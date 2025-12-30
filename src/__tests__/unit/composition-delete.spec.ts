import 'reflect-metadata';
import { Entity, hasMany, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { HttpErrors } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef, EntitySetRegistry } from '../../registry/entityset-registry';
import { ODATA_BINDINGS, ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';
import { ODATA_ATOMICITY_STATE } from '../../constants';

describe('Composition delete semantics', () => {
  @model()
  class Order extends Entity {
    @property({ id: true })
    id!: number;

    @hasMany(() => OrderItem, { keyTo: 'orderId' })
    items?: OrderItem[];
  }

  @model()
  class OrderItem extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    orderId!: number;

    @hasMany(() => OrderItemNote, { keyTo: 'orderItemId' })
    notes?: OrderItemNote[];
  }

  @model()
  class OrderItemNote extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    orderItemId!: number;
  }

  const noopLogger: ODataLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const throttler: ODataTenantThrottler = {
    check: async () => undefined,
    release: () => undefined,
  };

  function createHttpCtx(bindings: Map<any, any>, registry: EntitySetRegistry) {
    return {
      getSync(key: any) {
        if (key === ODATA_BINDINGS.ENTITY_SET_REGISTRY) return registry;
        return undefined;
      },
      async get(key: any) {
        if (!bindings.has(key)) {
          throw new Error(`missing binding: ${String(key)}`);
        }
        return bindings.get(key);
      },
    } as any;
  }

  function createController(options: {
    def: EntitySetDef;
    repo: any;
    cfg?: Partial<ODataConfig>;
    registry: EntitySetRegistry;
    bindings: Map<any, any>;
    requestOverrides?: Record<string, unknown>;
    logger?: ODataLogger;
  }) {
    const Controller = defineODataCrudController(options.def);
    const cfg: ODataConfig = {
      tokenSecret: 'test-secret',
      strict: true,
      ...options.cfg,
    } as ODataConfig;
    const request = {
      protocol: 'http',
      headers: { host: 'example.test' },
      get() {
        return undefined;
      },
      ...options.requestOverrides,
    } as any;
    const response = {
      headersSent: false,
      set() {},
      getHeader() {
        return undefined;
      },
      type() {
        return this;
      },
      status() {
        return this;
      },
      end() {},
      send() {},
    } as any;
    const httpCtx = createHttpCtx(options.bindings, options.registry);
    return new Controller(
      options.repo as any,
      request,
      response,
      httpCtx,
      cfg,
      {} as any,
      (options.logger ?? noopLogger) as any,
      throttler,
    );
  }

  it('returns 409 when children exist under a restrict relation', async () => {
    const registry = new EntitySetRegistry();
    const def = registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { items: { delete: 'restrict' } },
      },
    } as any);

    let deleted = false;
    const repo = {
      dataSource: { name: 'db' },
      async findById() {
        return { id: 1 };
      },
      async deleteById() {
        deleted = true;
      },
      items() {
        return {
          async find() {
            return [{ id: 100, orderId: 1 }];
          },
        };
      },
    };

    const controller = createController({
      def,
      repo,
      registry,
      bindings: new Map(),
    });

    await expect(controller.delete(1 as any)).to.be.rejectedWith(HttpErrors.Conflict);
    expect(deleted).to.equal(false);
  });

  it('cascades depth-first and runs child before/after hooks (but not on)', async () => {
    const callOrder: string[] = [];
    const registry = new EntitySetRegistry();

    const ordersDef = registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { items: { delete: 'cascade' } },
      },
    } as any);

    const itemsDef = registry.register({
      name: 'OrderItems',
      modelCtor: OrderItem,
      repositoryBindingKey: 'repositories.OrderItemRepo',
      sourceControllerBindingKey: 'controllers.OrderItemController',
      hooks: {
        before: [{ op: 'DELETE', methodName: 'beforeDelete' }],
        after: [{ op: 'DELETE', methodName: 'afterDelete' }],
        on: [{ op: 'DELETE', methodName: 'onDelete' }],
      },
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { notes: { delete: 'cascade' } },
      },
    } as any);

    const notesDef = registry.register({
      name: 'OrderItemNotes',
      modelCtor: OrderItemNote,
      repositoryBindingKey: 'repositories.OrderItemNoteRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: {},
      },
    } as any);

    const tx = {
      async commit() {},
      async rollback() {},
    };
    const ds = {
      name: 'db',
      async beginTransaction() {
        return tx;
      },
    };

    const noteRepo = {
      dataSource: ds,
      async count() {
        return { count: 1 };
      },
      async deleteById(id: any, options?: any) {
        expect(options).to.containEql({ transaction: tx });
        callOrder.push(`note:${id}`);
      },
    };
    const itemRepo = {
      dataSource: ds,
      async count() {
        return { count: 1 };
      },
      notes(itemId: any) {
        return {
          async count() {
            return { count: 1 };
          },
          async find() {
            return [{ id: 300, orderItemId: itemId }];
          },
        };
      },
      async deleteById(id: any, options?: any) {
        expect(options).to.containEql({ transaction: tx });
        callOrder.push(`item:${id}`);
      },
    };
    const orderRepo = {
      dataSource: ds,
      async findById() {
        return { id: 1 };
      },
      items() {
        return {
          async count() {
            return { count: 1 };
          },
          async find() {
            return [{ id: 200, orderId: 1 }];
          },
        };
      },
      async deleteById(id: any, options?: any) {
        expect(options).to.containEql({ transaction: tx });
        callOrder.push(`order:${id}`);
      },
    };

    const childControllerCalls: string[] = [];
    const orderItemController = {
      beforeDelete(ctx: any) {
        childControllerCalls.push(`before:${ctx.id}`);
        expect(ctx.state.cascade).to.equal(true);
        expect(ctx.state.cascadeRoot).to.containEql({ entitySet: 'Orders', id: 1 });
      },
      afterDelete(ctx: any) {
        childControllerCalls.push(`after:${ctx.id}`);
      },
      onDelete() {
        childControllerCalls.push('on');
      },
    };

    const bindings = new Map<any, any>([
      [itemsDef.repositoryBindingKey, itemRepo],
      [notesDef.repositoryBindingKey, noteRepo],
      [itemsDef.sourceControllerBindingKey, orderItemController],
    ]);

    const controller = createController({
      def: ordersDef,
      repo: orderRepo,
      registry,
      bindings,
    });

    await controller.delete(1 as any);
    expect(callOrder).to.eql(['note:300', 'item:200', 'order:1']);
    expect(childControllerCalls).to.eql(['before:200', 'after:200']);
  });

  it('reuses $batch atomicity group transactions for cascades', async () => {
    const callOrder: string[] = [];
    const registry = new EntitySetRegistry();

    const ordersDef = registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { items: { delete: 'cascade' } },
      },
    } as any);

    const itemsDef = registry.register({
      name: 'OrderItems',
      modelCtor: OrderItem,
      repositoryBindingKey: 'repositories.OrderItemRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { notes: { delete: 'cascade' } },
      },
    } as any);

    const notesDef = registry.register({
      name: 'OrderItemNotes',
      modelCtor: OrderItemNote,
      repositoryBindingKey: 'repositories.OrderItemNoteRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: {},
      },
    } as any);

    let beginCount = 0;
    const tx = { commit: async () => {}, rollback: async () => {} };
    const ds = {
      name: 'db',
      async beginTransaction() {
        beginCount += 1;
        return tx;
      },
    };

    const noteRepo = {
      dataSource: ds,
      async deleteById(id: any, options?: any) {
        expect(options).to.containEql({ transaction: tx });
        callOrder.push(`note:${id}`);
      },
    };
    const itemRepo = {
      dataSource: ds,
      notes(itemId: any) {
        return {
          async find() {
            return [{ id: 300, orderItemId: itemId }];
          },
        };
      },
      async deleteById(id: any, options?: any) {
        expect(options).to.containEql({ transaction: tx });
        callOrder.push(`item:${id}`);
      },
    };
    const orderRepo = {
      dataSource: ds,
      async findById() {
        return { id: 1 };
      },
      items() {
        return {
          async find() {
            return [{ id: 200, orderId: 1 }];
          },
        };
      },
      async deleteById(id: any, options?: any) {
        expect(options).to.containEql({ transaction: tx });
        callOrder.push(`order:${id}`);
      },
    };

    const bindings = new Map<any, any>([
      [itemsDef.repositoryBindingKey, itemRepo],
      [notesDef.repositoryBindingKey, noteRepo],
    ]);

    const controller = createController({
      def: ordersDef,
      repo: orderRepo,
      registry,
      bindings,
      requestOverrides: {
        [ODATA_ATOMICITY_STATE]: {
          groupId: 'g1',
          getTransaction() {
            return tx;
          },
        },
      } as any,
    });

    await controller.delete(1 as any);
    expect(beginCount).to.equal(0);
    expect(callOrder).to.eql(['note:300', 'item:200', 'order:1']);
  });

  it('returns 501 when cascade delete requires transactions but datasource does not support them', async () => {
    const registry = new EntitySetRegistry();
    const def = registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { items: { delete: 'cascade' } },
      },
    } as any);

    const repo = {
      dataSource: { name: 'db' }, // no beginTransaction => unsupported
      async findById() {
        return { id: 1 };
      },
      items() {
        return {
          async count() {
            return { count: 0 };
          },
          async find() {
            return [];
          },
        };
      },
      async deleteById() {
        throw new Error('should not delete');
      },
    };

    const controller = createController({
      def,
      repo,
      registry,
      bindings: new Map(),
    });

    await expect(controller.delete(1 as any)).to.be.rejectedWith(HttpErrors.NotImplemented);
  });

  it('returns 501 when cascade would write across multiple datasources', async () => {
    const registry = new EntitySetRegistry();
    const ordersDef = registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { items: { delete: 'cascade' } },
      },
    } as any);
    const itemsDef = registry.register({
      name: 'OrderItems',
      modelCtor: OrderItem,
      repositoryBindingKey: 'repositories.OrderItemRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: {},
      },
    } as any);

    const tx = { commit: async () => {}, rollback: async () => {} };
    const ds1 = { name: 'db1', beginTransaction: async () => tx };
    const ds2 = { name: 'db2', beginTransaction: async () => tx };

    const itemRepo = {
      dataSource: ds2,
      async count() {
        return { count: 1 };
      },
      async deleteById() {},
    };
    const orderRepo = {
      dataSource: ds1,
      async findById() {
        return { id: 1 };
      },
      items() {
        return {
          async count() {
            return { count: 1 };
          },
          async find() {
            return [{ id: 200, orderId: 1 }];
          },
        };
      },
      async deleteById() {},
    };

    const bindings = new Map<any, any>([[itemsDef.repositoryBindingKey, itemRepo]]);
    const controller = createController({
      def: ordersDef,
      repo: orderRepo,
      registry,
      bindings,
    });

    await expect(controller.delete(1 as any)).to.be.rejectedWith(HttpErrors.NotImplemented);
  });

  it('rejects cascade plans that exceed maxEntities', async () => {
    const registry = new EntitySetRegistry();
    const ordersDef = registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: false,
        maxDepth: 8,
        maxEntities: 2,
        relations: { items: { delete: 'cascade' } },
      },
    } as any);
    const itemsDef = registry.register({
      name: 'OrderItems',
      modelCtor: OrderItem,
      repositoryBindingKey: 'repositories.OrderItemRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: false,
        maxDepth: 8,
        maxEntities: 2,
        relations: {},
      },
    } as any);

    const ds = { name: 'db' }; // best-effort mode
    const itemRepo = {
      dataSource: ds,
      async count() {
        return { count: 2 };
      },
      async deleteById() {},
    };
    const orderRepo = {
      dataSource: ds,
      async findById() {
        return { id: 1 };
      },
      items() {
        return {
          async count() {
            return { count: 2 };
          },
          async find() {
            return [
              { id: 200, orderId: 1 },
              { id: 201, orderId: 1 },
            ];
          },
        };
      },
      async deleteById() {},
    };

    const bindings = new Map<any, any>([[itemsDef.repositoryBindingKey, itemRepo]]);
    const controller = createController({
      def: ordersDef,
      repo: orderRepo,
      registry,
      bindings,
    });

    await expect(controller.delete(1 as any)).to.be.rejectedWith(HttpErrors.BadRequest);
  });

  it('rejects cascade plans that exceed maxDepth', async () => {
    const registry = new EntitySetRegistry();
    const ordersDef = registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: false,
        maxDepth: 1,
        maxEntities: 5000,
        relations: { items: { delete: 'cascade' } },
      },
    } as any);
    const itemsDef = registry.register({
      name: 'OrderItems',
      modelCtor: OrderItem,
      repositoryBindingKey: 'repositories.OrderItemRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: false,
        maxDepth: 1,
        maxEntities: 5000,
        relations: { notes: { delete: 'cascade' } },
      },
    } as any);
    const notesDef = registry.register({
      name: 'OrderItemNotes',
      modelCtor: OrderItemNote,
      repositoryBindingKey: 'repositories.OrderItemNoteRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: false,
        maxDepth: 1,
        maxEntities: 5000,
        relations: {},
      },
    } as any);

    const ds = { name: 'db' };
    const noteRepo = {
      dataSource: ds,
      async count() {
        return { count: 1 };
      },
      async deleteById() {},
    };
    const itemRepo = {
      dataSource: ds,
      async count() {
        return { count: 1 };
      },
      notes(itemId: any) {
        return {
          async count() {
            return { count: 1 };
          },
          async find() {
            return [{ id: 300, orderItemId: itemId }];
          },
        };
      },
      async deleteById() {},
    };
    const orderRepo = {
      dataSource: ds,
      async findById() {
        return { id: 1 };
      },
      items() {
        return {
          async count() {
            return { count: 1 };
          },
          async find() {
            return [{ id: 200, orderId: 1 }];
          },
        };
      },
      async deleteById() {},
    };

    const bindings = new Map<any, any>([
      [itemsDef.repositoryBindingKey, itemRepo],
      [notesDef.repositoryBindingKey, noteRepo],
    ]);
    const controller = createController({
      def: ordersDef,
      repo: orderRepo,
      registry,
      bindings,
    });

    await expect(controller.delete(1 as any)).to.be.rejectedWith(HttpErrors.BadRequest);
  });

  it('does not run composition semantics when @odata.on(DELETE) is present', async () => {
    const registry = new EntitySetRegistry();
    const ordersDef = registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepo',
      sourceControllerBindingKey: 'controllers.OrderController',
      hooks: {
        on: [{ op: 'DELETE', methodName: 'onDelete' }],
      },
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { items: { delete: 'cascade' } },
      },
    } as any);

    let childDeleteCalled = false;
    const itemsDef = registry.register({
      name: 'OrderItems',
      modelCtor: OrderItem,
      repositoryBindingKey: 'repositories.OrderItemRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: {},
      },
    } as any);

    const orderRepo = {
      dataSource: { name: 'db' },
      async deleteById() {},
    };
    const itemRepo = {
      dataSource: { name: 'db' },
      async deleteById() {
        childDeleteCalled = true;
      },
    };
    const orderController = {
      async onDelete(_ctx: any, next: any) {
        return next();
      },
    };

    const bindings = new Map<any, any>([
      [itemsDef.repositoryBindingKey, itemRepo],
      [ordersDef.sourceControllerBindingKey, orderController],
    ]);
    const controller = createController({
      def: ordersDef,
      repo: orderRepo,
      registry,
      bindings,
    });

    await controller.delete(1 as any);
    expect(childDeleteCalled).to.equal(false);
  });
});

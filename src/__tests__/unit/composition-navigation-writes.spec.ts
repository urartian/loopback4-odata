import 'reflect-metadata';
import { Entity, hasMany, hasOne, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { HttpErrors, Request, Response } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef, EntitySetRegistry } from '../../registry/entityset-registry';
import { ODATA_BINDINGS, ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

type AnyObject = Record<string, unknown>;

describe('Composition-safe navigation writes ($ref + reparenting)', () => {
  @model()
  class OrderItem extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    orderId?: number | null;
  }

  @model()
  class Customer extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    orderId?: number | null;
  }

  @model()
  class Order extends Entity {
    @property({ id: true })
    id!: number;

    @hasMany(() => OrderItem, { keyTo: 'orderId' })
    items?: OrderItem[];

    @hasOne(() => Customer, { keyTo: 'orderId' })
    customer?: Customer;
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

  function createHttpCtx(registry?: EntitySetRegistry) {
    return {
      getSync(key: any) {
        if (key === ODATA_BINDINGS.ENTITY_SET_REGISTRY) return registry;
        return undefined;
      },
      async get(key: any) {
        throw new Error(`missing binding: ${String(key)}`);
      },
    } as any;
  }

  function createController(params: {
    def: EntitySetDef;
    repo: AnyObject;
    registry?: EntitySetRegistry;
    cfg?: Partial<ODataConfig>;
  }) {
    const Controller = defineODataCrudController(params.def);
    const request = {
      protocol: 'https',
      headers: { host: 'example.test' },
      path: '/odata',
      get() {
        return undefined;
      },
    } as unknown as Request;
    const response = {
      headersSent: false,
      set() {},
      getHeader() {
        return undefined;
      },
      status() {
        return this;
      },
      end() {},
      send() {},
      type() {
        return this;
      },
    } as unknown as Response;
    const cfg: ODataConfig = {
      tokenSecret: 'test-secret',
      strict: true,
      ...params.cfg,
    } as ODataConfig;
    return new Controller(
      params.repo as any,
      request as any,
      response as any,
      createHttpCtx(params.registry),
      cfg,
      {} as any,
      noopLogger,
      throttler,
    );
  }

  function compositionResolved(relations: Record<string, { delete: 'restrict' | 'cascade' }>) {
    return {
      enforcement: 'database',
      defaultDeletePolicy: 'restrict',
      requireTransactionSupport: true,
      maxDepth: 8,
      maxEntities: 5000,
      relations,
    } as any;
  }

  it('rejects $ref link/unlink for composition relations (hasMany + hasOne)', async () => {
    const def: EntitySetDef = {
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepository',
      compositionResolved: compositionResolved({
        items: { delete: 'restrict' },
        customer: { delete: 'restrict' },
      }),
    };

    const orderItemTargetRepo = { entityClass: OrderItem };
    const customerTargetRepo = { entityClass: Customer };
    const repo = {
      items() {
        return { getTargetRepository: async () => orderItemTargetRepo };
      },
      customer() {
        return { getTargetRepository: async () => customerTargetRepo };
      },
    };

    const controller = createController({ def, repo: repo as AnyObject });

    await expect(
      (controller as any).linkNavigationRef('items', 1, '/odata/OrderItems(10)'),
    ).to.be.rejectedWith(
      HttpErrors.Conflict,
      /Cannot link existing entities via \$ref for composition relation "Orders\.items"/,
    );

    await expect(
      (controller as any).linkNavigationRef('customer', 1, '/odata/Customers(10)'),
    ).to.be.rejectedWith(
      HttpErrors.Conflict,
      /Cannot link existing entities via \$ref for composition relation "Orders\.customer"/,
    );

    await expect((controller as any).unlinkNavigationRef('items', 1, '10')).to.be.rejectedWith(
      HttpErrors.Conflict,
      /Cannot unlink entities via \$ref for composition relation "Orders\.items"/,
    );

    await expect(
      (controller as any).unlinkNavigationRef('customer', 1, undefined),
    ).to.be.rejectedWith(
      HttpErrors.Conflict,
      /Cannot unlink entities via \$ref for composition relation "Orders\.customer"/,
    );
  });

  it('keeps existing $ref behavior for non-composition relations (hasMany + hasOne)', async () => {
    const def: EntitySetDef = {
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepository',
    };

    const orderId = 7;
    const orderItems = new Map<number, AnyObject>([[10, { id: 10, orderId: 999 }]]);
    const customers = new Map<number, AnyObject>([[12, { id: 12, orderId: 999 }]]);

    const orderItemTargetRepo = {
      entityClass: OrderItem,
      async findById(id: any) {
        const item = orderItems.get(Number(id));
        if (!item) throw new HttpErrors.NotFound();
        return { ...item };
      },
      async replaceById(_id: any, data: AnyObject) {
        orderItems.set(10, { ...(orderItems.get(10) ?? {}), ...data, id: 10 });
        expect(data).to.not.have.property('id');
      },
    };

    const customerTargetRepo = {
      entityClass: Customer,
      async findById(id: any) {
        const customer = customers.get(Number(id));
        if (!customer) throw new HttpErrors.NotFound();
        return { ...customer };
      },
      async replaceById(_id: any, data: AnyObject) {
        customers.set(12, { ...(customers.get(12) ?? {}), ...data, id: 12 });
        expect(data).to.not.have.property('id');
      },
    };

    const repo = {
      items() {
        return {
          getTargetRepository: async () => orderItemTargetRepo,
        };
      },
      customer() {
        return {
          getTargetRepository: async () => customerTargetRepo,
          get: async () => ({ ...(customers.get(12) ?? { id: 12, orderId: null }) }),
        };
      },
    };

    const controller = createController({ def, repo: repo as AnyObject });

    await expect(
      (controller as any).linkNavigationRef('items', orderId, '/odata/OrderItems(10)'),
    ).to.be.fulfilled();
    expect(orderItems.get(10)?.orderId).to.equal(orderId);
    await expect(
      (controller as any).linkNavigationRef('customer', orderId, '/odata/Customers(12)'),
    ).to.be.fulfilled();
    expect(customers.get(12)?.orderId).to.equal(orderId);
    await expect((controller as any).unlinkNavigationRef('items', orderId, '10')).to.be.fulfilled();
    expect(orderItems.get(10)?.orderId).to.equal(null);
    await expect(
      (controller as any).unlinkNavigationRef('customer', orderId, undefined),
    ).to.be.fulfilled();
    expect(customers.get(12)?.orderId).to.equal(null);
  });

  it('rejects re-parenting by PATCHing a composition FK', async () => {
    const registry = new EntitySetRegistry();
    registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepository',
      compositionResolved: compositionResolved({ items: { delete: 'restrict' } }),
    } as any);
    const itemsDef = registry.register({
      name: 'OrderItems',
      modelCtor: OrderItem,
      repositoryBindingKey: 'repositories.OrderItemRepository',
    } as any);

    const repo: AnyObject = {
      async findById() {
        return { id: 1, orderId: 10 };
      },
      async updateById() {
        throw new Error('updateById should not be called');
      },
    };

    const controller = createController({ def: itemsDef, repo, registry });
    await expect((controller as any).update(1, { orderId: 11 })).to.be.rejectedWith(
      HttpErrors.Conflict,
      /Re-parenting is not allowed for composition children \(attempted to modify "orderId"\)/,
    );
  });

  it('allows PATCH when composition FK is present but unchanged (idempotent)', async () => {
    const registry = new EntitySetRegistry();
    registry.register({
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepository',
      compositionResolved: compositionResolved({ items: { delete: 'restrict' } }),
    } as any);
    const itemsDef = registry.register({
      name: 'OrderItems',
      modelCtor: OrderItem,
      repositoryBindingKey: 'repositories.OrderItemRepository',
    } as any);

    let updateCalls = 0;
    const state: AnyObject = { id: 1, orderId: 10, note: 'unchanged' };
    const repo: AnyObject = {
      async findById() {
        return { ...state };
      },
      async updateById(_id: any, data: AnyObject) {
        updateCalls++;
        Object.assign(state, data);
      },
    };

    const controller = createController({ def: itemsDef, repo, registry });
    await expect(
      (controller as any).update(1, { orderId: '10', note: 'updated' }),
    ).to.be.fulfilled();
    expect(updateCalls).to.equal(1);
  });

  it('rejects re-parenting via deep update payload for composition relations (hasMany + hasOne)', async () => {
    const def: EntitySetDef = {
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepository',
      deepUpdate: true,
      compositionResolved: compositionResolved({
        items: { delete: 'restrict' },
        customer: { delete: 'restrict' },
      }),
    };

    const orderId = 1;

    const itemsRelationRepo: AnyObject = {
      getTargetRepository: async () => ({ entityClass: OrderItem }),
      find: async () => [{ id: 10, orderId }],
      patch: async () => {
        throw new Error('items.patch should not be called');
      },
      create: async () => {
        throw new Error('items.create should not be called');
      },
    };

    const customerRelationRepo: AnyObject = {
      getTargetRepository: async () => ({ entityClass: Customer }),
      get: async () => ({ id: 12, orderId }),
      patch: async () => {
        throw new Error('customer.patch should not be called');
      },
      create: async () => {
        throw new Error('customer.create should not be called');
      },
    };

    const repo: AnyObject = {
      async findById(id: any) {
        return { id };
      },
      items() {
        return itemsRelationRepo;
      },
      customer() {
        return customerRelationRepo;
      },
    };

    const controller = createController({ def, repo });

    await expect(
      (controller as any).update(orderId, { items: [{ id: 10, orderId: 999 }] }),
    ).to.be.rejectedWith(HttpErrors.Conflict, /attempted to modify "orderId"/);

    await expect(
      (controller as any).update(orderId, { customer: { id: 12, orderId: 999 } }),
    ).to.be.rejectedWith(HttpErrors.Conflict, /attempted to modify "orderId"/);
  });
});

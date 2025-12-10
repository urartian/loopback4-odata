import 'reflect-metadata';
import {
  Application,
  inject,
  BindingScope,
  Context,
  ResolutionContext,
} from '@loopback/core';
import { RestApplication } from '@loopback/rest';
import {
  AnyObject,
  DefaultCrudRepository,
  Entity,
  RepositoryMixin,
  juggler,
  model,
  property,
  RelationType,
} from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { ODataBooter } from '../../booters/odata.booter';
import { EntitySetDef, EntitySetRegistry } from '../../registry/entityset-registry';
import { odataModel } from '../../decorators/model.decorator';
import { odataController } from '../../decorators/controller.decorator';
import { ODataApplyExecutorRegistry } from '../../services/odata-apply-executor.registry';
import { ODataLogger } from '../../keys';
import { odataAction, odataFunction } from '../../decorators/action.function.decorators';

describe('ODataBooter entity set naming', () => {
  it('uses inflection to pluralize model names by default', () => {
    @model()
    class Person extends Entity {}

    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    const setName = (booter as any).getEntitySetName(Person);
    expect(setName).to.equal('People');
  });

  it('respects explicit entity set name metadata', () => {
    @odataModel({ entitySetName: 'CustomPeople' })
    @model()
    class Citizen extends Entity {}

    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    const setName = (booter as any).getEntitySetName(Citizen);
    expect(setName).to.equal('CustomPeople');
  });
});

describe('ODataBooter repository binding resolution', () => {
  it('uses naming conventions to resolve repositories without instantiating them', async () => {
    const RepoApp = RepositoryMixin(Application);
    const app = new RepoApp();
    app.dataSource(new juggler.DataSource({ name: 'db', connector: 'memory' }), 'db');

    @model()
    class Widget extends Entity {
      @property({ id: true })
      id?: number;
    }

    let instantiationAttempts = 0;

    class WidgetRepository extends DefaultCrudRepository<Widget, typeof Widget.prototype.id> {
      constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
        instantiationAttempts++;
        super(Widget, dataSource);
        throw new Error('Repository should not be instantiated during OData boot.');
      }
    }

    @odataController(Widget)
    class WidgetODataController {}

    app.repository(WidgetRepository);
    app.controller(WidgetODataController);

    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    await booter.load();

    expect(instantiationAttempts).to.equal(0);
    const def = registry.get(Widget);
    expect(def?.repositoryBindingKey).to.equal('repositories.WidgetRepository');
  });

  it('infers datasource binding from static dataSourceName metadata', async () => {
    const RepoApp = RepositoryMixin(Application);
    const app = new RepoApp();
    app.dataSource(new juggler.DataSource({ name: 'db', connector: 'memory' }), 'db');

    @model()
    class Sensor extends Entity {
      @property({ id: true })
      id?: number;
    }

    class SensorRepository extends DefaultCrudRepository<Sensor, typeof Sensor.prototype.id> {
      static dataSourceName = 'db';
      constructor(dataSource: juggler.DataSource) {
        super(Sensor, dataSource);
      }
    }

    app.repository(SensorRepository);

    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    const repoBinding = app.getBinding('repositories.SensorRepository');
    const selector = (booter as any).resolveRepositoryDataSourceBindingKey(repoBinding);
    expect(selector).to.equal('datasources.db');
  });
});

describe('ODataBooter transaction capability detection', () => {
  it('detects transactional datasources without instantiating repositories', async () => {
    const RepoApp = RepositoryMixin(Application);
    const app = new RepoApp();
    const txDataSource = new juggler.DataSource({ name: 'tx', connector: 'memory' }) as AnyObject;
    let beginCalls = 0;
    txDataSource.beginTransaction = async () => {
      beginCalls++;
      return {
        commit: async () => undefined,
        rollback: async () => undefined,
      };
    };
    app.dataSource(txDataSource as juggler.DataSource, 'tx');

    @model()
    class Device extends Entity {
      @property({ id: true })
      id?: number;
    }

    let instantiations = 0;
    class DeviceRepository extends DefaultCrudRepository<Device, typeof Device.prototype.id> {
      constructor(@inject('datasources.tx') dataSource: juggler.DataSource) {
        instantiations++;
        super(Device, dataSource);
        throw new Error('Repository should not be instantiated during capability detection.');
      }
    }

    @odataController(Device)
    class DeviceController {}

    app.repository(DeviceRepository);
    app.controller(DeviceController);

    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    await booter.load();

    expect(instantiations).to.equal(0);
    expect(beginCalls).to.equal(1);
    const def = registry.get(Device);
    expect(def?.supportsTransactions).to.equal(true);
  });

  it('marks datasources without beginTransaction as non-transactional', async () => {
    const RepoApp = RepositoryMixin(Application);
    const app = new RepoApp();
    const ds = new juggler.DataSource({ name: 'mem', connector: 'memory' }) as AnyObject;
    delete ds.beginTransaction;
    app.dataSource(ds as juggler.DataSource, 'mem');

    @model()
    class LogEntry extends Entity {
      @property({ id: true })
      id?: number;
    }

    class LogRepository extends DefaultCrudRepository<LogEntry, typeof LogEntry.prototype.id> {
      constructor(@inject('datasources.mem') dataSource: juggler.DataSource) {
        super(LogEntry, dataSource);
      }
    }

    @odataController(LogEntry)
    class LogController {}

    app.repository(LogRepository);
    app.controller(LogController);

    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    await booter.load();

    const def = registry.get(LogEntry);
    expect(def?.supportsTransactions).to.equal(false);
  });

  it('marks datasources whose beginTransaction rejects as non-transactional', async () => {
    const RepoApp = RepositoryMixin(Application);
    const app = new RepoApp();
    const flaky = new juggler.DataSource({ name: 'flaky', connector: 'memory' }) as AnyObject;
    flaky.beginTransaction = async () => {
      throw new Error('Transactions not supported');
    };
    app.dataSource(flaky as juggler.DataSource, 'flaky');

    @model()
    class AuditLog extends Entity {
      @property({ id: true })
      id?: number;
    }

    class AuditRepository extends DefaultCrudRepository<AuditLog, typeof AuditLog.prototype.id> {
      constructor(@inject('datasources.flaky') dataSource: juggler.DataSource) {
        super(AuditLog, dataSource);
      }
    }

    @odataController(AuditLog)
    class AuditController {}

    app.repository(AuditRepository);
    app.controller(AuditController);

    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    await booter.load();

    const def = registry.get(AuditLog);
    expect(def?.supportsTransactions).to.equal(false);
  });
});

describe('ODataBooter navigation reference routes', () => {
  it('registers $ref routes when the foreign key can be inferred', async () => {
    const app = new RestApplication();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    @model()
    class Order extends Entity {
      @property({ id: true })
      id!: number;
    }

    @model()
    class OrderItem extends Entity {
      @property({ id: true })
      id!: number;

      @property()
      orderId!: number;
    }

    const orderDef = (Order as typeof Entity).definition;
    orderDef.addRelation({
      name: 'items',
      type: RelationType.hasMany,
      targetsMany: true,
      source: Order,
      target: () => OrderItem,
    });

    @odataController(Order)
    class OrderODataController {
      async linkNavigationRef() {}
      async unlinkNavigationRef() {}
    }

    app.controller(OrderODataController);

    const def = registry.register({
      name: 'Orders',
      modelCtor: Order,
      controllerCtor: OrderODataController,
    });

    (booter as any).registerNavigationRefRoutes(def, orderDef, OrderODataController);

    const spec = await app.restServer.getApiSpec();
    expect(spec.paths?.['/odata/Orders/{id}/items/$ref']).to.be.Object();
    expect(spec.paths?.['/odata/Orders/{id}/items/{targetKey}/$ref']).to.be.Object();
  });
});

describe('ODataBooter operation parameter warnings', () => {
  it('logs a warning when operation parameter metadata is missing', async () => {
    const warnings: Array<{ message: string; context?: unknown }> = [];
    const logger: ODataLogger = {
      ...noopLogger,
      warn: (message, context) => {
        warnings.push({ message, context });
      },
    };

    const RepoRestApp = RepositoryMixin(RestApplication);
    const app = new RepoRestApp();
    app.dataSource(new juggler.DataSource({ name: 'db', connector: 'memory' }), 'db');

    @model()
    class Account extends Entity {
      @property({ id: true })
      id?: number;
    }

    class AccountRepository extends DefaultCrudRepository<Account, typeof Account.prototype.id> {
      constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
        super(Account, dataSource);
      }
    }

    @odataController(Account)
    class AccountController {
      @odataAction()
      async login(body: { email: string }) {
        return body.email;
      }

      @odataFunction({ params: [] })
      async status() {
        return 'ok';
      }
    }

    app.repository(AccountRepository);
    app.controller(AccountController);

    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      logger,
    );

    await booter.load();

    expect(warnings).to.have.length(1);
    expect(warnings[0].message).to.match(
      /No parameter metadata defined for OData action "login" on AccountController/,
    );
    expect(warnings[0].context).to.containEql({
      controller: 'AccountController',
      method: 'login',
      operation: 'login',
      binding: 'entity',
      kind: 'Action',
    });
  });
});

describe('ODataBooter media handler bindings', () => {
  it('resolves property-backed media repositories within the request context', async () => {
    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    app
      .bind('repositories.MediaRepository')
      .toDynamicValue(async (ctx: ResolutionContext) => {
        const requestContext = ctx?.context ?? app;
        const requestId = await requestContext.get<string>('request-id');
        return { requestId } as AnyObject;
      })
      .inScope(BindingScope.REQUEST);

    const repoBinding = app.getBinding('repositories.MediaRepository');
    const def = {
      name: 'MediaAssets',
      hasStream: true,
      mediaField: 'content',
    } as EntitySetDef;

    await (booter as any).configureMediaHandler(def, repoBinding);

    const mediaBindingKey = def.mediaHandlerBindingKey!;
    const requestCtx = new Context(app);
    requestCtx.bind('request-id').to('req-123');

    const handler = (await requestCtx.get(mediaBindingKey)) as AnyObject;
    expect(handler).to.be.Object();
    expect(handler.repository?.requestId).to.equal('req-123');
  });

  it('resolves repository-adapter media handlers within the request context', async () => {
    const RepoApp = RepositoryMixin(Application);
    const app = new RepoApp();
    app.dataSource(new juggler.DataSource({ name: 'db', connector: 'memory' }), 'db');
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(
      app,
      registry,
      {} as any,
      new ODataApplyExecutorRegistry(),
      noopLogger,
    );

    @model()
    class MediaEntity extends Entity {
      @property({ id: true })
      id?: number;
    }

    class StreamingRepository extends DefaultCrudRepository<
      MediaEntity,
      typeof MediaEntity.prototype.id
    > {
      constructor(
        @inject('datasources.db') dataSource: juggler.DataSource,
        @inject('request-id') public readonly requestId: string,
      ) {
        super(MediaEntity, dataSource);
      }

      async getMedia() {
        return Buffer.from(this.requestId ?? '');
      }

      async setMedia() {
        return { etag: this.requestId ?? 'etag' };
      }
    }

    app
      .bind('repositories.StreamingRepository')
      .toClass(StreamingRepository)
      .inScope(BindingScope.REQUEST);

    const repoBinding = app.getBinding('repositories.StreamingRepository');
    const def = {
      name: 'StreamingAssets',
      hasStream: true,
    } as EntitySetDef;

    await (booter as any).configureMediaHandler(def, repoBinding);

    const mediaBindingKey = def.mediaHandlerBindingKey!;
    const requestCtx = new Context(app);
    requestCtx.bind('request-id').to('request-xyz');

    const handler = (await requestCtx.get(mediaBindingKey)) as AnyObject;
    expect(handler).to.be.Object();
    expect(handler.repository?.requestId).to.equal('request-xyz');
  });
});
const noopLogger: ODataLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

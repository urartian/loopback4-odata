import 'reflect-metadata';
import { Entity, hasMany, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { HttpErrors } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';
import { ODATA_ATOMICITY_STATE } from '../../constants';

describe('CRUD controller writeTransactions', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    name?: string;
  }

  @model()
  class WidgetChild extends Entity {
    @property({ id: true })
    id!: number;
  }

  const def: EntitySetDef = {
    name: 'Widgets',
    modelCtor: Widget,
    repositoryBindingKey: 'repositories.WidgetRepository',
  };

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

  function createController(options: {
    repo: any;
    cfg: Partial<ODataConfig>;
    defOverride?: Partial<EntitySetDef>;
    requestOverrides?: Record<string, unknown>;
    responseOverrides?: Record<string, unknown>;
    httpCtx?: any;
    logger?: ODataLogger;
  }) {
    const controllerDef: EntitySetDef = { ...def, ...(options.defOverride ?? {}) };
    const Controller = defineODataCrudController(controllerDef);
    const cfg: ODataConfig = {
      tokenSecret: 'test-secret',
      ...options.cfg,
    } as ODataConfig;
    const request = {
      protocol: 'http',
      headers: { host: 'example.test' },
      get() {
        return undefined;
      },
    } as any;
    if (options.requestOverrides) {
      Object.assign(request, options.requestOverrides);
    }
    return new Controller(
      options.repo as any,
      request,
      {
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
        ...options.responseOverrides,
      } as any,
      (options.httpCtx ?? {}) as any,
      cfg,
      {} as any,
      (options.logger ?? noopLogger) as any,
      throttler,
    );
  }

  it('wraps create in a transaction and commits on success', async () => {
    let commitCount = 0;
    let rollbackCount = 0;
    const tx = {
      async commit() {
        commitCount += 1;
      },
      async rollback() {
        rollbackCount += 1;
      },
    };
    const ds = {
      name: 'db',
      async beginTransaction() {
        return tx;
      },
    };
    let seenOptions: any;
    const repo = {
      dataSource: ds,
      async create(payload: any, options?: any) {
        seenOptions = options;
        return { id: 1, ...payload };
      },
    };

    const controller = createController({
      repo,
      cfg: {
        writeTransactions: { enabled: true, requireTransactionSupport: true },
      },
    });

    await controller.create({ name: 'ok' } as any);
    expect(seenOptions).to.containEql({ transaction: tx });
    expect(commitCount).to.equal(1);
    expect(rollbackCount).to.equal(0);
  });

  it('rolls back when the handler throws', async () => {
    let commitCount = 0;
    let rollbackCount = 0;
    const tx = {
      async commit() {
        commitCount += 1;
      },
      async rollback() {
        rollbackCount += 1;
      },
    };
    const ds = {
      name: 'db',
      async beginTransaction() {
        return tx;
      },
    };
    const repo = {
      dataSource: ds,
      async create() {
        throw new Error('boom');
      },
    };

    const controller = createController({
      repo,
      cfg: {
        writeTransactions: { enabled: true, requireTransactionSupport: true },
      },
    });

    await expect(controller.create({ name: 'fail' } as any)).to.be.rejectedWith('boom');
    expect(commitCount).to.equal(0);
    expect(rollbackCount).to.equal(1);
  });

  it('rolls back when deep insert fails after parent insert', async () => {
    @model()
    class Parent extends Entity {
      @property({ id: true })
      id!: number;

      @hasMany(() => WidgetChild)
      children?: WidgetChild[];
    }

    let commitCount = 0;
    let rollbackCount = 0;
    const tx = {
      async commit() {
        commitCount += 1;
      },
      async rollback() {
        rollbackCount += 1;
      },
    };
    const ds = {
      name: 'db',
      async beginTransaction() {
        return tx;
      },
    };

    let parentCreateOptions: any;
    let relationFactoryOptions: any;
    const relationRepo = {
      dataSource: ds,
      async create() {
        throw new Error('child insert failed');
      },
    };
    const repo: any = {
      dataSource: ds,
      async create(payload: any, options?: any) {
        parentCreateOptions = options;
        return { id: 1, ...payload };
      },
      children(_id: unknown, options?: any) {
        relationFactoryOptions = options;
        return relationRepo;
      },
    };

    const controller = createController({
      repo,
      defOverride: {
        name: 'Parents',
        modelCtor: Parent,
        deepInsert: true,
      },
      cfg: {
        writeTransactions: {
          enabled: true,
          requireTransactionSupport: true,
          rejectMultiDataSource: true,
        },
      },
    });

    await expect(controller.create({ id: 1, children: [{ id: 1 }] } as any)).to.be.rejectedWith(
      'child insert failed',
    );
    expect(parentCreateOptions).to.containEql({ transaction: tx });
    expect(relationFactoryOptions).to.containEql({ transaction: tx });
    expect(commitCount).to.equal(0);
    expect(rollbackCount).to.equal(1);
  });

  it('rejects deep insert writes that target a different datasource', async () => {
    let rollbackCount = 0;
    const tx = {
      async commit() {},
      async rollback() {
        rollbackCount += 1;
      },
    };
    const ds1 = {
      name: 'db1',
      async beginTransaction() {
        return tx;
      },
    };
    const repo = {
      dataSource: ds1,
    };

    const controller = createController({
      repo,
      cfg: {
        writeTransactions: {
          enabled: true,
          requireTransactionSupport: true,
          rejectMultiDataSource: true,
        },
      },
    });

    const ds2 = { name: 'db2' };
    const relationRepo = {
      dataSource: ds2,
      async create() {
        return { id: 1 };
      },
    };
    const relationMeta = {
      type: 'hasMany',
      targetsMany: true,
      target: () => WidgetChild,
    };

    await expect(
      (controller as any).withWriteTransaction(async () => {
        const options = (controller as any).repositoryOptions();
        await (controller as any).persistDeepInsertGraph(
          'children',
          relationMeta,
          relationRepo,
          { id: 1 },
          options,
          new Set(),
          1,
        );
      }),
    ).to.be.rejectedWith(HttpErrors.NotImplemented);
    expect(rollbackCount).to.equal(1);
  });

  it('rolls back when deep update fails', async () => {
    @model()
    class Parent extends Entity {
      @property({ id: true })
      id!: number;

      @hasMany(() => WidgetChild)
      children?: WidgetChild[];
    }

    let rollbackCount = 0;
    const tx = {
      async commit() {},
      async rollback() {
        rollbackCount += 1;
      },
    };
    const ds = {
      name: 'db',
      async beginTransaction() {
        return tx;
      },
    };

    const relationRepo = {
      dataSource: ds,
      async find() {
        return [];
      },
      async getTargetRepository() {
        return {
          async findOne() {
            return undefined;
          },
        };
      },
      async create() {
        throw new Error('deep update child create failed');
      },
    };
    const repo: any = {
      dataSource: ds,
      async updateById() {},
      async findById() {
        return { id: 1 };
      },
      children() {
        return relationRepo;
      },
    };

    const controller = createController({
      repo,
      defOverride: {
        name: 'Parents',
        modelCtor: Parent,
        deepUpdate: true,
      },
      cfg: {
        writeTransactions: {
          enabled: true,
          requireTransactionSupport: true,
          rejectMultiDataSource: true,
        },
      },
    });

    await expect(controller.update(1, { children: [{}] } as any)).to.be.rejectedWith(
      'deep update child create failed',
    );
    expect(rollbackCount).to.equal(1);
  });

  it('rejects deep update writes that target a different datasource', async () => {
    @model()
    class Parent extends Entity {
      @property({ id: true })
      id!: number;

      @hasMany(() => WidgetChild)
      children?: WidgetChild[];
    }

    let rollbackCount = 0;
    const tx = {
      async commit() {},
      async rollback() {
        rollbackCount += 1;
      },
    };
    const ds = {
      name: 'db',
      async beginTransaction() {
        return tx;
      },
    };

    const relationRepo = {
      dataSource: { name: 'other' },
      async find() {
        return [];
      },
      async getTargetRepository() {
        return {
          async findOne() {
            return undefined;
          },
        };
      },
      async create() {
        return { id: 1 };
      },
    };
    const repo: any = {
      dataSource: ds,
      async updateById() {},
      async findById() {
        return { id: 1 };
      },
      children() {
        return relationRepo;
      },
    };

    const controller = createController({
      repo,
      defOverride: {
        name: 'Parents',
        modelCtor: Parent,
        deepUpdate: true,
      },
      cfg: {
        writeTransactions: {
          enabled: true,
          requireTransactionSupport: true,
          rejectMultiDataSource: true,
        },
      },
    });

    await expect(controller.update(1, { children: [{}] } as any)).to.be.rejectedWith(
      HttpErrors.NotImplemented,
    );
    expect(rollbackCount).to.equal(1);
  });

  it('emits tx.unavailable telemetry and still enforces cross-datasource rejection in best-effort mode', async () => {
    const logs: Array<{ level: string; message: string; context?: any }> = [];
    const logger: ODataLogger = {
      trace: (message, context) => logs.push({ level: 'trace', message, context }),
      debug: (message, context) => logs.push({ level: 'debug', message, context }),
      info: (message, context) => logs.push({ level: 'info', message, context }),
      warn: (message, context) => logs.push({ level: 'warn', message, context }),
      error: (message, context) => logs.push({ level: 'error', message, context }),
    };

    const httpCtx = {
      getSync() {
        return {
          telemetry: {
            enabled: true,
            level: 'info',
            sampled: true,
            includeApplyPlanOnFallback: false,
            categories: new Set(['requests']),
          },
        };
      },
    };

    const ds1 = { name: 'db1' }; // no beginTransaction => unsupported
    const repo = {
      dataSource: ds1,
    };
    const controller = createController({
      repo,
      cfg: {
        writeTransactions: {
          enabled: true,
          requireTransactionSupport: false,
          rejectMultiDataSource: true,
        },
      },
      httpCtx,
      logger,
    });

    const relationRepo = {
      dataSource: { name: 'db2' },
      async create() {
        return { id: 1 };
      },
    };
    const relationMeta = {
      type: 'hasMany',
      targetsMany: true,
      target: () => WidgetChild,
    };

    await expect(
      (controller as any).withWriteTransaction(async () => {
        await (controller as any).persistDeepInsertGraph(
          'children',
          relationMeta,
          relationRepo,
          { id: 1 },
          undefined,
          new Set(),
          1,
        );
      }),
    ).to.be.rejectedWith(HttpErrors.NotImplemented);

    expect(
      logs.some(
        (entry) =>
          entry.level === 'warn' &&
          entry.message === 'Telemetry:tx.unavailable' &&
          entry.context?.telemetryEvent === 'tx.unavailable',
      ),
    ).to.be.true();
  });

  it('does not start a new transaction when running inside a $batch atomicity group', async () => {
    let beginCount = 0;
    const ds = {
      name: 'db',
      async beginTransaction() {
        beginCount += 1;
        return { commit: async () => {}, rollback: async () => {} };
      },
    };
    const tx = { commit: async () => {}, rollback: async () => {} };
    let seenOptions: any;
    const repo = {
      dataSource: ds,
      async create(payload: any, options?: any) {
        seenOptions = options;
        return { id: 1, ...payload };
      },
    };

    const controller = createController({
      repo,
      cfg: {
        writeTransactions: { enabled: true, requireTransactionSupport: true },
      },
      requestOverrides: {
        [ODATA_ATOMICITY_STATE]: {
          groupId: 'g1',
          getTransaction(entitySetName: string) {
            return entitySetName === 'Widgets' ? (tx as any) : undefined;
          },
        },
      },
    });

    await controller.create({ name: 'batch' } as any);
    expect(beginCount).to.equal(0);
    expect(seenOptions).to.containEql({ transaction: tx });
  });

  it('rolls back and throws TransactionCommitFailed when commit fails', async () => {
    let rollbackCount = 0;
    const tx = {
      async commit() {
        throw new Error('commit failed');
      },
      async rollback() {
        rollbackCount += 1;
      },
    };
    const ds = {
      name: 'db',
      async beginTransaction() {
        return tx;
      },
    };
    const repo = {
      dataSource: ds,
      async create(payload: any) {
        return { id: 1, ...payload };
      },
    };

    const controller = createController({
      repo,
      cfg: {
        writeTransactions: { enabled: true, requireTransactionSupport: true },
      },
    });

    try {
      await controller.create({ name: 'commit-fail' } as any);
      throw new Error('expected commit failure');
    } catch (err) {
      expect((err as any).code).to.equal('TransactionCommitFailed');
    }
    expect(rollbackCount).to.equal(1);
  });

  it('fails fast when datasource does not support transactions and support is required', async () => {
    const repo = {
      dataSource: { name: 'db' },
      async create() {
        return { id: 1 };
      },
    };
    const controller = createController({
      repo,
      cfg: {
        strict: true,
        writeTransactions: { enabled: true, requireTransactionSupport: true },
      },
    });

    await expect(controller.create({ name: 'no-tx' } as any)).to.be.rejectedWith(
      HttpErrors.NotImplemented,
    );
  });
});

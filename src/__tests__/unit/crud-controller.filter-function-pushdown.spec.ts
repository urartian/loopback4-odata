import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller Postgres $filter function pushdown', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    name?: string;
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

  const createController = (query: Record<string, string | string[] | undefined>, repo: any) => {
    const Controller = defineODataCrudController(def);
    const request = {
      query,
      get: () => undefined,
      headers: {},
      originalUrl: '/odata/Widgets',
    };
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
      once() {},
    };
    const cfg: ODataConfig = {
      tokenSecret: 'test-secret',
      strict: true,
    };
    return new Controller(
      repo,
      request as any,
      response as any,
      {} as any,
      cfg,
      {} as any,
      noopLogger,
      throttler,
    );
  };

  it('pushes down trim() filters on Postgres in strict mode', async () => {
    const executeCalls: Array<{ sql: string; params: unknown[] }> = [];
    const findCalls: any[] = [];
    const dataSource = {
      connector: {
        name: 'postgresql',
        table: (modelName: string) => modelName,
        column: (_modelName: string, propertyName: string) => propertyName,
      },
      execute: async (sql: string, params: unknown[]) => {
        executeCalls.push({ sql, params });
        return [{ id: 1 }];
      },
    };
    const repo = {
      dataSource,
      find: async (filter: any) => {
        findCalls.push(filter);
        return [{ id: 1, name: ' x ' }];
      },
      count: async () => ({ count: 0 }),
    };
    const controller = createController({ $filter: "trim(name) eq 'x'" }, repo);

    await controller.list();

    expect(executeCalls.length).to.be.greaterThan(0);
    expect(executeCalls[0].sql).to.match(/btrim\(/i);
    expect(findCalls.length).to.equal(1);
    expect(findCalls[0].where).to.containEql({ id: { inq: [1] } });
  });

  it('pushes down contains(tolower(...)) filters on Postgres in strict mode', async () => {
    const executeCalls: Array<{ sql: string; params: unknown[] }> = [];
    const findCalls: any[] = [];
    const dataSource = {
      connector: {
        name: 'postgresql',
        table: (modelName: string) => modelName,
        column: (_modelName: string, propertyName: string) => propertyName,
      },
      execute: async (sql: string, params: unknown[]) => {
        executeCalls.push({ sql, params });
        return [{ id: 1 }];
      },
    };
    const repo = {
      dataSource,
      find: async (filter: any) => {
        findCalls.push(filter);
        return [{ id: 1, name: 'Notification job delivery' }];
      },
      count: async () => ({ count: 0 }),
    };
    const controller = createController(
      { $filter: "contains(tolower(name),'Notification Job Delivery')" },
      repo,
    );

    const result = await controller.list();

    expect(executeCalls.length).to.be.greaterThan(0);
    expect(executeCalls[0].sql).to.match(/LOWER\s*\(\s*r\."name"\s*\)\s+LIKE/i);
    expect(executeCalls[0].params).to.containEql('%notification job delivery%');
    expect(findCalls.length).to.equal(1);
    expect(findCalls[0].where).to.containEql({ id: { inq: [1] } });
    expect(findCalls[0].where).to.not.containEql({
      name: { like: '%notification job delivery%', options: 'i' },
    });
    expect((result as any).value).to.containDeep([{ name: 'Notification job delivery' }]);
  });
});

import 'reflect-metadata';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';
import { OrderItem } from '../../../examples/basic-app';

describe('CRUD controller navigation-property $filter pushdown', () => {
  const def: EntitySetDef = {
    name: 'OrderItems',
    modelCtor: OrderItem,
    repositoryBindingKey: 'repositories.OrderItemRepository',
  };

  const noopLogger: ODataLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const baseConfig: ODataConfig = {
    tokenSecret: 'test-secret',
    strict: true,
  };

  const createController = (query: Record<string, string | string[] | undefined>, repo: any) => {
    const Controller = defineODataCrudController(def);
    const request = {
      query,
      get: () => undefined,
      headers: {},
      originalUrl: '/odata/OrderItems',
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

    return new Controller(
      repo,
      request as any,
      response as any,
      {} as any,
      baseConfig,
      {} as any,
      noopLogger,
      {
        check: async () => undefined,
        release: () => undefined,
      } as ODataTenantThrottler,
    );
  };

  it('routes navigation path comparisons out of repository where', async () => {
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
        return [{ id: 1, orderId: 10, productId: 20, quantity: 1, unitPrice: 100 }];
      },
      count: async () => ({ count: 0 }),
    };
    const controller = createController({ $filter: 'order/total eq 1000' }, repo);

    await controller.list();

    expect(executeCalls.length).to.be.greaterThan(0);
    expect(executeCalls[0].sql).to.match(/EXISTS\s*\(SELECT 1 FROM/i);
    expect(findCalls.length).to.equal(1);
    expect(Object.keys(findCalls[0].where ?? {})).to.not.containEql('order/total');
  });
});

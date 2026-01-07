import 'reflect-metadata';
import { belongsTo, Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller navigation-property $filter + post-filter fallback', () => {
  @model()
  class Address extends Entity {
    @property({ id: true })
    id!: number;

    @property({ type: 'string' })
    city!: string;
  }

  @model()
  class Customer extends Entity {
    @property({ id: true })
    id!: number;

    @property({ type: 'string' })
    name!: string;

    @belongsTo(() => Address, { name: 'address' })
    addressId!: number;
  }

  @model()
  class Purchase extends Entity {
    @property({ id: true })
    id!: number;

    @property({ type: 'string' })
    status!: string;

    @belongsTo(() => Customer, { name: 'customer' })
    customerId!: number;
  }

  const def: EntitySetDef = {
    name: 'Purchases',
    modelCtor: Purchase,
    repositoryBindingKey: 'repositories.PurchaseRepository',
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

  const createController = (
    query: Record<string, string | string[] | undefined>,
    cfg: Partial<ODataConfig>,
    repo: any,
  ) => {
    const Controller = defineODataCrudController(def);
    const resolvedConfig = {
      tokenSecret: 'test-secret',
      ...(cfg ?? {}),
    } as ODataConfig;
    const request = {
      query,
      get: () => undefined,
      headers: {},
      originalUrl: '/odata/Purchases',
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
      resolvedConfig,
      {} as any,
      noopLogger,
      throttler,
    );
  };

  it('falls back to bounded post-filter in non-strict mode and injects required includes', async () => {
    const findCalls: any[] = [];
    const controller = createController(
      { $filter: "customer/name eq 'Alice' and trim(status) eq 'Open'" },
      { strict: false, filter: { maxPostFilterScanRows: 2 } },
      {
        find: async (filter: any) => {
          findCalls.push(filter);
          return [
            { id: 1, status: ' Open ', customer: { id: 10, name: 'Alice' } },
            { id: 2, status: 'Closed', customer: { id: 11, name: 'Alice' } },
          ];
        },
        count: async () => ({ count: 0 }),
      },
    );

    const result = (await controller.list()) as any;

    expect(findCalls.length).to.equal(1);
    expect(findCalls[0]?.limit).to.equal(3);
    expect(findCalls[0]?.include ?? []).to.containDeep([{ relation: 'customer' }]);
    expect(result.value).to.have.length(1);
    expect(result.value[0]?.id).to.equal(1);
    expect(result.value[0]).to.not.have.property('customer');
  });

  it('keeps client-expanded relations but strips deeper injected includes', async () => {
    const findCalls: any[] = [];
    const controller = createController(
      { $expand: 'customer', $filter: "customer/address/city eq 'X' and trim(status) eq 'Open'" },
      { strict: false, filter: { maxPostFilterScanRows: 5 } },
      {
        find: async (filter: any) => {
          findCalls.push(filter);
          return [
            {
              id: 1,
              status: ' Open ',
              customer: { id: 10, name: 'Alice', address: { id: 50, city: 'X' } },
            },
            {
              id: 2,
              status: ' Open ',
              customer: { id: 11, name: 'Bob', address: { id: 51, city: 'Y' } },
            },
          ];
        },
        count: async () => ({ count: 0 }),
      },
    );

    const result = (await controller.list()) as any;

    expect(findCalls.length).to.equal(1);
    expect(findCalls[0]?.include ?? []).to.containDeep([{ relation: 'customer' }]);
    expect(JSON.stringify(findCalls[0]?.include ?? [])).to.match(/address/);
    expect(result.value).to.have.length(1);
    expect(result.value[0]?.customer).to.have.property('name', 'Alice');
    expect(result.value[0]?.customer).to.not.have.property('address');
  });
});

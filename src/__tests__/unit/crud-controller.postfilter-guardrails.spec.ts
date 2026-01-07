import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller post-filter guardrails', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    name?: string;

    @property({
      jsonSchema: {
        type: 'object',
        properties: {
          width: { type: 'number' },
        },
      },
    })
    dimensions?: { width?: number };
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

  it('requires $top for post-filter evaluation in non-strict mode', async () => {
    const findCalls: any[] = [];
    const controller = createController(
      { $filter: "trim(name) eq 'x'" },
      { strict: false, filter: { requireTopWhenPostFilter: true, maxPostFilterScanRows: 2 } },
      {
        find: async (filter: any) => {
          findCalls.push(filter);
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(findCalls[0]?.limit).to.equal(3);
  });

  it('rejects post-filter scans that exceed maxPostFilterScanRows', async () => {
    const findCalls: any[] = [];
    const controller = createController(
      { $filter: "trim(name) eq 'x'", $top: '5' },
      { strict: false, filter: { maxPostFilterScanRows: 2 } },
      {
        find: async (filter: any) => {
          findCalls.push(filter);
          return [{ id: 1 }, { id: 2 }, { id: 3 }];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await expect(controller.list()).to.be.rejectedWith({ code: 'postfilter-scan-limit-exceeded' });
    expect(findCalls[0]?.limit).to.equal(3);
    expect(findCalls[0]?.offset).to.equal(0);
  });

  it('allows bounded post-filter evaluation in strict mode when server paging is enabled', async () => {
    const findCalls: any[] = [];
    const controller = createController(
      { $filter: 'dimensions/width gt 300' },
      { strict: true, filter: { maxPostFilterScanRows: 2 } },
      {
        find: async (filter: any) => {
          findCalls.push(filter);
          return [
            { id: 1, dimensions: { width: 350 } },
            { id: 2, dimensions: { width: 250 } },
          ];
        },
        count: async () => ({ count: 0 }),
      },
    );

    const result = await controller.list();
    expect(findCalls[0]?.limit).to.equal(3);
    expect((result as any).value).to.have.length(1);
  });

  it('evaluates tolower()/toupper() transform comparisons in post-filter mode', async () => {
    const controller = createController(
      { $filter: "tolower(name) eq 'x'" },
      { strict: false, filter: { maxPostFilterScanRows: 10, requireTopWhenPostFilter: false } },
      {
        find: async () => [{ id: 1, name: 'X' }, { id: 2, name: 'y' }, { id: 3 }],
        count: async () => ({ count: 0 }),
      },
    );

    const result = await controller.list();
    expect((result as any).value.map((item: any) => item.id)).to.eql([1]);
  });
});

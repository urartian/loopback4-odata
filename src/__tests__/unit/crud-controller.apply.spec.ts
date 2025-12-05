import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ApplyExecutionPlan } from '../../services/odata-apply-planner.service';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller $apply fallback', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;
  }

  const baseDef: EntitySetDef = {
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

  const baseConfig: ODataConfig = { tokenSecret: 'test-secret' };

  const createController = () => {
    const Controller = defineODataCrudController(baseDef);
    return new Controller(
      {} as any,
      {} as any,
      {
        set() {},
        status() {
          return this;
        },
        end() {},
      } as any,
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

  it('throws when runApplyPlanFallback exceeds configured max rows', () => {
    const controller = createController();
    const plan: ApplyExecutionPlan = {
      pushdownWhere: undefined,
      preAggregationFilters: [],
      stages: [],
    };
    const rows = Array.from({ length: 10 }, (_, idx) => ({ id: idx + 1 }));

    expect(() => (controller as any).runApplyPlanFallback(plan, rows, { maxRows: 5 })).to.throw(
      /\$apply result exceeds/,
    );
  });

  it('rejects $apply requests when capability is disabled', async () => {
    const Controller = defineODataCrudController({
      ...baseDef,
      capabilities: { applySupported: false },
    });
    const repo = {
      find: async () => [],
      count: async () => ({ count: 0 }),
    };
    const request = {
      query: { $apply: 'aggregate(id with sum as Total)' },
      get: () => undefined,
      headers: {},
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
    const controller = new Controller(
      repo as any,
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

    await expect(controller.list()).to.be.rejectedWith('$apply is disabled for this entity set.');
  });
});

import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import {
  ApplyExecutionPlan,
  buildApplyExecutionPlan,
} from '../../services/odata-apply-planner.service';
import { parseApplyPipeline } from '../../services/odata-query-parser.service';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller $apply fallback', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    unitPrice?: number;
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

  it('rejects $apply with unknown groupby fields even when strict mode is disabled', () => {
    const controller = createController();
    const pipeline = parseApplyPipeline('groupby((unknown), aggregate(id with count as Total))');
    const plan = buildApplyExecutionPlan(pipeline, { modelCtor: Widget });

    expect(() => (controller as any).validateApplyPlanFields(plan)).to.throw(
      /Unknown property in \$apply/i,
    );
  });

  it('rejects $apply with unknown aggregate fields', () => {
    const controller = createController();
    const pipeline = parseApplyPipeline('aggregate(unknown with sum as Total)');
    const plan = buildApplyExecutionPlan(pipeline, { modelCtor: Widget });

    expect(() => (controller as any).validateApplyPlanFields(plan)).to.throw(
      /Unknown property in \$apply/i,
    );
  });

  it('accepts $apply with known fields', () => {
    const controller = createController();
    const pipeline = parseApplyPipeline('groupby((id), aggregate(id with count as Total))');
    const plan = buildApplyExecutionPlan(pipeline, { modelCtor: Widget });

    expect(() => (controller as any).validateApplyPlanFields(plan)).to.not.throw();
  });

  it('accepts successive aggregate stages using prior aliases', () => {
    const controller = createController();
    const pipeline = parseApplyPipeline(
      'groupby((id), aggregate(id with count as OrderCount))/aggregate(OrderCount with sum as OverallCount)',
    );
    const plan = buildApplyExecutionPlan(pipeline, { modelCtor: Widget });

    expect(() => (controller as any).validateApplyPlanFields(plan)).to.not.throw();
  });

  it('accepts concat pipelines that reference aggregate aliases', () => {
    const controller = createController();
    const pipeline = parseApplyPipeline(
      'concat(aggregate(unitPrice with sum as price),aggregate(unitPrice with sum as price)/concat(aggregate($count as UI5__count),top(5)))/filter(price ge 0)/orderby(price desc)',
    );
    const plan = buildApplyExecutionPlan(pipeline, { modelCtor: Widget });

    expect(() => (controller as any).validateApplyPlanFields(plan)).to.not.throw();
  });
});

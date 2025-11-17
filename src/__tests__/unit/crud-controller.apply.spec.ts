import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ApplyExecutionPlan } from '../../services/odata-apply-planner.service';
import { ODataLogger, ODataTenantThrottler } from '../../keys';

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
      {},
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
});

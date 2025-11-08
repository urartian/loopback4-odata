import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig, ODataPaginationConfig } from '../../types';

describe('CRUD controller pagination config', () => {
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

  const createController = (options?: {
    def?: Partial<EntitySetDef>;
    cfg?: Omit<Partial<ODataConfig>, 'pagination'> & {
      pagination?: Partial<ODataPaginationConfig>;
    };
  }) => {
    const defOverrides = options?.def ?? {};
    const controllerDef: EntitySetDef = {
      ...baseDef,
      ...defOverrides,
    };
    if (defOverrides.pagination !== undefined) {
      controllerDef.pagination = { ...defOverrides.pagination };
    }

    const Controller = defineODataCrudController(controllerDef);
    const { pagination: paginationOverrides, ...restConfig } = options?.cfg ?? {};
    const cfg = {
      ...(restConfig as object),
    } as ODataConfig;
    if (paginationOverrides) {
      cfg.pagination = { ...(paginationOverrides as ODataPaginationConfig) };
    }

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
      cfg,
      {} as any,
      noopLogger,
      {
        check: async () => undefined,
        release: () => undefined,
      } as ODataTenantThrottler,
    );
  };

  it('prefers entity-level pagination limits over global defaults', () => {
    const controller = createController({
      def: {
        pagination: {
          maxTop: 7,
          maxSkip: 9,
          maxPageSize: 11,
          maxApplyPageSize: 13,
        },
      },
      cfg: {
        pagination: {
          maxTop: 3,
          maxSkip: 4,
          maxPageSize: 5,
          maxApplyPageSize: 6,
        },
      },
    });

    const limits = controller.getPaginationLimits();

    expect(limits).to.containEql({
      maxTop: 7,
      maxSkip: 9,
      maxPageSize: 11,
      maxApplyPageSize: 13,
    });
  });

  it('falls back to global pagination configuration when entity has none', () => {
    const controller = createController({
      cfg: {
        pagination: {
          maxTop: 2,
          maxSkip: 4,
          maxPageSize: 8,
          maxApplyPageSize: 10,
        },
      },
    });

    const limits = controller.getPaginationLimits();

    expect(limits).to.containEql({
      maxTop: 2,
      maxSkip: 4,
      maxPageSize: 8,
      maxApplyPageSize: 10,
    });
  });

  it('uses legacy maxTop/maxSkip config when pagination block omits them', () => {
    const controller = createController({
      cfg: {
        maxTop: 21,
        maxSkip: 34,
        pagination: {
          maxPageSize: 5,
        },
      },
    });

    const limits = controller.getPaginationLimits();

    expect(limits.maxTop).to.equal(21);
    expect(limits.maxSkip).to.equal(34);
    expect(limits.maxPageSize).to.equal(5);
  });

  it('defaults maxApplyPageSize to maxPageSize when not provided', () => {
    const controller = createController({
      cfg: {
        pagination: {
          maxPageSize: 12,
        },
      },
    });

    const limits = controller.getPaginationLimits();

    expect(limits.maxApplyPageSize).to.equal(12);
  });
});

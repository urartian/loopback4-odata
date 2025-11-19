import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { HttpErrors } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller $search guardrails', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    name?: string;

    @property()
    description?: string;
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

  const createController = (cfg: Partial<ODataConfig>, repositoryStub?: object) => {
    const Controller = defineODataCrudController(def);
    return new Controller(
      (repositoryStub ?? {}) as any,
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
        check: async (_tenant?: string) => undefined,
        release: () => undefined,
      } as ODataTenantThrottler,
    );
  };

  it('rejects $search expressions that exceed maxSearchTerms', () => {
    const controller = createController({
      searchFields: {
        Widgets: ['name'],
      },
      maxSearchTerms: 1,
    });
    const baseFilter: Record<string, unknown> = {};

    expect(() => (controller as any).applySearch(baseFilter, 'Laptop AND Phone')).to.throw(
      HttpErrors.BadRequest,
      /\$search allows at most 1 terms/i,
    );
  });

  it('uses standard like/nlike for $search when datasource connector is not Postgres', () => {
    const controller = createController({
      searchFields: {
        Widgets: ['name'],
      },
    });
    const baseFilter: Record<string, unknown> = {};

    (controller as any).applySearch(baseFilter, 'widget');

    expect(baseFilter.where).to.deepEqual({
      name: { like: '%widget%' },
    });

    const negatedFilter: Record<string, unknown> = {};
    (controller as any).applySearch(negatedFilter, 'NOT widget');

    expect(negatedFilter.where).to.deepEqual({
      or: [{ name: { nlike: '%widget%' } }, { name: null }],
    });
  });

  it('emits ilike/nilike operators only for Postgres connectors', () => {
    const controller = createController(
      {
        searchFields: {
          Widgets: ['name'],
        },
      },
      {
        dataSource: {
          connector: { name: 'postgresql' },
          settings: { connector: 'postgresql' },
        },
      },
    );

    const baseFilter: Record<string, unknown> = {};
    (controller as any).applySearch(baseFilter, 'widget');

    expect(baseFilter.where).to.deepEqual({
      name: { ilike: '%widget%' },
    });

    const negatedFilter: Record<string, unknown> = {};
    (controller as any).applySearch(negatedFilter, 'NOT widget');

    expect(negatedFilter.where).to.deepEqual({
      or: [{ name: { nilike: '%widget%' } }, { name: null }],
    });
  });

  it('uses ilike/nilike for memory connectors to stay case-insensitive', () => {
    const controller = createController(
      {
        searchFields: {
          Widgets: ['name'],
        },
      },
      {
        dataSource: {
          connector: { name: 'memory' },
          settings: { connector: 'memory' },
        },
      },
    );

    const baseFilter: Record<string, unknown> = {};
    (controller as any).applySearch(baseFilter, 'widget');

    expect(baseFilter.where).to.deepEqual({
      name: { ilike: '%widget%' },
    });

    const negatedFilter: Record<string, unknown> = {};
    (controller as any).applySearch(negatedFilter, 'NOT widget');

    expect(negatedFilter.where).to.deepEqual({
      or: [{ name: { nilike: '%widget%' } }, { name: null }],
    });
  });

  it('clamps searchable fields to maxSearchFields', () => {
    const controller = createController({
      searchFields: {
        Widgets: ['name', 'description'],
      },
      maxSearchFields: 1,
    });
    const baseFilter: Record<string, unknown> = {};

    (controller as any).applySearch(baseFilter, 'Widget');

    expect(JSON.stringify(baseFilter.where)).to.match(/name/i);
    expect(JSON.stringify(baseFilter.where)).to.not.match(/description/i);
  });
});

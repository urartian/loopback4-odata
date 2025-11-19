import 'reflect-metadata';
import { AnyObject, Entity, belongsTo, hasMany, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { HttpErrors } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller navigation path validation', () => {
  @model()
  class Status extends Entity {
    @property({ id: true })
    code!: string;

    @property()
    name?: string;
  }

  @model()
  class IncidentNote extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    incidentId!: string;

    @property()
    descr?: string;
  }

  @model()
  class Incident extends Entity {
    @property({ id: true })
    id!: string;

    @property()
    title?: string;

    @belongsTo(() => Status, { name: 'status' })
    statusCode!: string;

    @hasMany(() => IncidentNote, { name: 'notes', keyTo: 'incidentId' })
    notes?: IncidentNote[];
  }

  const def: EntitySetDef = {
    name: 'Incidents',
    modelCtor: Incident,
    repositoryBindingKey: 'repositories.IncidentRepository',
  };

  const noopLogger: ODataLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  function createController(cfg: Partial<ODataConfig> = {}) {
    const Controller = defineODataCrudController(def);
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
        check: async (_tenant?: string) => undefined,
        release: () => undefined,
      } as ODataTenantThrottler,
    );
  }

  it('allows filtering on navigation properties in strict mode', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'status/code': 'NEW' } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.not.throw();
  });

  it('rejects navigation filters referencing unknown members in strict mode', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'status/unknown': 'NEW' } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.throw(
      HttpErrors.BadRequest,
      /Unknown property in \$filter: status\/unknown/i,
    );
  });

  it('allows selecting nested navigation properties', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { fields: { 'status/code': true } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.not.throw();
  });

  it('allows ordering by navigation properties', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { order: ['status/code ASC'] };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.not.throw();
  });

  it('rejects filters with stray property segments containing slashes', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'title/foo': 'bar' } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.throw(
      HttpErrors.BadRequest,
      /Unknown property in \$filter: title\/foo/i,
    );
  });

  it('rejects collection navigation filters outside lambdas', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'notes/descr': 'test' } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.throw(
      HttpErrors.BadRequest,
      /Unknown property in \$filter: notes\/descr/i,
    );
  });
});

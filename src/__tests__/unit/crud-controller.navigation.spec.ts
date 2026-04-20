import 'reflect-metadata';
import {
  AnyObject,
  Entity,
  Model,
  belongsTo,
  hasMany,
  model,
  property,
} from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { HttpErrors } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller navigation path validation', () => {
  @model()
  class StatusContact extends Model {
    @property({ type: 'string' })
    email?: string;
  }

  @model()
  class StatusDetails extends Model {
    @property({ type: 'string' })
    label?: string;

    @property({ type: () => StatusContact })
    contact?: StatusContact;
  }

  @model()
  class IncidentRegion extends Model {
    @property({ type: 'string' })
    name?: string;
  }

  @model()
  class IncidentAddress extends Model {
    @property({ type: 'string' })
    city?: string;

    @property({ type: () => IncidentRegion })
    region?: IncidentRegion;
  }

  @model()
  class Status extends Entity {
    @property({ id: true })
    code!: string;

    @property()
    name?: string;

    @property({ type: () => StatusDetails })
    details?: StatusDetails;
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

    @property({ type: () => IncidentAddress })
    location?: IncidentAddress;

    @property({
      jsonSchema: {
        type: 'object',
        properties: {
          severity: { type: 'string' },
          reporter: { $ref: '#/definitions/ReporterDetails' },
        },
        definitions: {
          ReporterDetails: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              organization: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                },
              },
            },
          },
        },
      },
    })
    metadata?: AnyObject;

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
    const resolvedConfig = {
      ...cfg,
      tokenSecret: cfg.tokenSecret ?? 'test-secret',
    } as ODataConfig;
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
      resolvedConfig,
      {} as any,
      noopLogger,
      {
        check: async (_tenant?: string) => undefined,
        release: () => undefined,
      } as ODataTenantThrottler,
    );
  }

  function createRuntimeController(
    query: Record<string, string | string[] | undefined>,
    repo: any,
    cfg: Partial<ODataConfig> = {},
  ) {
    const Controller = defineODataCrudController(def);
    const resolvedConfig = {
      ...cfg,
      tokenSecret: cfg.tokenSecret ?? 'test-secret',
    } as ODataConfig;
    const request = {
      query,
      get: () => undefined,
      headers: {},
      originalUrl: '/odata/Incidents(incident-1)/notes',
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

  it('allows filtering on structured properties in strict mode', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'location/region/name': 'EMEA' } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.not.throw();
  });

  it('allows selecting structured properties defined via jsonSchema references', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { fields: { 'metadata/reporter/organization/name': true } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.not.throw();
  });

  it('allows selecting entire structured properties without specifying child fields', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { fields: { location: true, metadata: true } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.not.throw();
  });

  it('allows ordering by structured properties', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { order: ['location/city DESC'] };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.not.throw();
  });

  it('allows navigation followed by structured property hops', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'status/details/contact/email': 'ops@example.com' } };

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

  it('rejects structured paths that do not end on a scalar', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'location/region': 'EMEA' } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.throw(
      HttpErrors.BadRequest,
      /Unknown property in \$filter: location\/region/i,
    );
  });

  it('rejects structured paths referencing unknown members', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'metadata/reporter/department/name': 'Support' } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.throw(
      HttpErrors.BadRequest,
      /Unknown property in \$filter: metadata\/reporter\/department\/name/i,
    );
  });

  it('rejects hasMany navigation segments combined with structured members', () => {
    const controller = createController({ strict: true });
    const filter: AnyObject = { where: { 'notes/location/city': 'Paris' } };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.throw(
      HttpErrors.BadRequest,
      /Unknown property in \$filter: notes\/location\/city/i,
    );
  });

  it('converts navigation collection filter expressions and paging before relation find', async () => {
    const findCalls: any[] = [];
    const repo = {
      notes: () => ({
        find: async (filter: any) => {
          findCalls.push(filter);
          return [{ id: 2, incidentId: 'incident-1', descr: 'urgent' }];
        },
      }),
    };
    const controller = createRuntimeController(
      { $filter: "descr eq 'urgent'", $top: '2', $skip: '1' },
      repo,
      { strict: true },
    );

    const result = (await (controller as any).getEntityProperty('incident-1', 'notes')) as any;

    expect(findCalls).to.have.length(1);
    expect(findCalls[0]).to.containEql({
      where: { descr: 'urgent' },
      limit: 2,
      offset: 1,
    });
    expect(findCalls[0].where).to.not.have.property('operator');
    expect(result.value).to.containDeep([{ descr: 'urgent' }]);
  });

  it('applies navigation singleton filter expressions after relation get', async () => {
    const getCalls: any[] = [];
    const repo = {
      status: () => ({
        get: async (filter: any) => {
          getCalls.push(filter);
          return { code: 'OPEN', name: 'Open' };
        },
      }),
    };
    const controller = createRuntimeController(
      { $filter: "name eq 'Closed'" },
      repo,
      { strict: true },
    );

    const result = await (controller as any).getEntityProperty('incident-1', 'status');

    expect(getCalls).to.have.length(1);
    expect(getCalls[0]).to.containEql({ where: { name: 'Closed' } });
    expect(result).to.equal(undefined);
  });
});

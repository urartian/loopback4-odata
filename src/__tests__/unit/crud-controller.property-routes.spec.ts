import {expect, sinon} from '@loopback/testlab';
import {AnyObject, DefaultCrudRepository, Entity, model, property} from '@loopback/repository';
import {Request, RequestContext, Response} from '@loopback/rest';
import {defineODataCrudController} from '../../controllers/crud-controller-factory';
import {ODataConfig} from '../../types';
import {ODataApplyExecutorRegistry} from '../../services/odata-apply-executor.registry';
import {ODataLogger, ODataTenantThrottler} from '../../keys';

@model()
class PropertyRouteEntity extends Entity {
  @property({id: true})
  id?: number;

  @property({type: 'string'})
  name?: string;

  @property({type: 'string'})
  status?: string;

  @property({type: 'number'})
  price?: number;

  @property({
    type: 'object',
    jsonSchema: {
      type: 'object',
      format: 'json',
      contentMediaType: 'application/json',
    },
    postgresql: {dataType: 'jsonb'},
  })
  metadata?: Record<string, unknown>;

  @property({type: 'object'})
  unsupported?: Record<string, unknown>;

  @property({type: 'string'})
  version?: string;
}

describe('ODataCrudController property routes', () => {
  const ControllerCtor = defineODataCrudController({
    name: 'Products',
    modelCtor: PropertyRouteEntity,
    repositoryBindingKey: 'repositories.Products',
    etagProperties: ['version'],
  });

  const logger: ODataLogger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  const throttler: ODataTenantThrottler = {
    async check() {},
    release() {},
  };
  const httpCtx = {
    getSync: () => undefined,
  } as unknown as RequestContext;
  const cfg = {strict: true, tokenSecret: 'unit-test-secret'} as ODataConfig;
  const applyExecutors = {} as ODataApplyExecutorRegistry;

  afterEach(() => {
    sinon.restore();
  });

  it('returns 304 for scalar $value requests when If-None-Match matches', async () => {
    const {controller, response} = givenController({
      requestHeaders: {'if-none-match': 'W/"v1"'},
      entity: {id: 1, name: 'Widget', version: 'v1'},
    });

    const result = await controller.getPropertyValue(1, 'name');

    expect(result).to.equal(undefined);
    sinon.assert.calledWith(response.statusStub, 304);
    sinon.assert.calledOnce(response.endStub);
    expect(response.headers.ETag).to.equal('W/"v1"');
    expect(response.headers['OData-Version']).to.equal('4.0');
  });

  it('returns 204 for null scalar $value requests', async () => {
    const {controller, response} = givenController({
      entity: {id: 1, name: null, version: 'v1'},
    });

    const result = await controller.getPropertyValue(1, 'name');

    expect(result).to.equal(undefined);
    sinon.assert.calledWith(response.statusStub, 204);
    sinon.assert.calledOnce(response.endStub);
  });

  it('serializes scalar $value responses as plain text', async () => {
    const {controller, response} = givenController({
      entity: {id: 1, price: 12.5, version: 'v2'},
    });

    const result = await controller.getPropertyValue(1, 'price');

    expect(result).to.equal(12.5);
    expect(response.headers['content-type']).to.equal('text/plain; charset=utf-8');
    sinon.assert.calledWith(response.sendStub, '12.5');
    expect(response.headers.ETag).to.equal('W/"v2"');
  });

  it('rejects $value for unsupported structured properties', async () => {
    const {controller} = givenController({
      entity: {id: 1, unsupported: {x: 1}, version: 'v1'},
    });

    await expect(controller.getPropertyValue(1, 'unsupported')).to.be.rejectedWith(
      /does not expose a scalar \$value/i,
    );
  });

  it('wraps scalar property reads in an OData value payload', async () => {
    const {controller, response} = givenController({
      entity: {id: 1, name: 'Widget', version: 'v3'},
    });

    const result = await controller.getEntityProperty(1, 'name');

    expect(result).to.deepEqual({
      '@odata.context': '/odata/$metadata#Products/name',
      value: 'Widget',
    });
    expect(response.headers.ETag).to.equal('W/"W/\\"v3\\""');
  });

  it('returns 204 when scalar property read filter does not match the entity', async () => {
    const {controller, response} = givenController({
      query: {$filter: "status eq 'Completed'"},
      entity: {id: 1, status: 'Draft', version: 'v3'},
    });

    const result = await controller.getEntityProperty(1, 'status');

    expect(result).to.equal(undefined);
    sinon.assert.calledWith(response.statusStub, 204);
    sinon.assert.calledOnce(response.endStub);
  });

  it('returns scalar property payload when read filter matches the entity', async () => {
    const {controller} = givenController({
      query: {$filter: "status eq 'Draft'"},
      entity: {id: 1, status: 'Draft', version: 'v3'},
    });

    const result = await controller.getEntityProperty(1, 'status');

    expect(result).to.deepEqual({
      '@odata.context': '/odata/$metadata#Products/status',
      value: 'Draft',
    });
  });

  it('returns 204 when scalar $value read filter does not match the entity', async () => {
    const {controller, response} = givenController({
      query: {$filter: "status eq 'Completed'"},
      entity: {id: 1, status: 'Draft', version: 'v3'},
    });

    const result = await controller.getPropertyValue(1, 'status');

    expect(result).to.equal(undefined);
    sinon.assert.calledWith(response.statusStub, 204);
    sinon.assert.calledOnce(response.endStub);
  });

  it('streams JSON-valued properties directly when JSON is accepted', async () => {
    const {controller, response} = givenController({
      requestHeaders: {accept: 'application/json'},
      entity: {id: 1, metadata: {enabled: true}, version: 'v4'},
    });

    const result = await controller.getEntityProperty(1, 'metadata');

    expect(result).to.deepEqual({enabled: true});
    expect(response.headers['content-type']).to.equal('application/json; charset=utf-8');
    sinon.assert.calledWith(response.sendStub, JSON.stringify({enabled: true}));
  });

  it('rejects JSON-valued property reads when Accept excludes JSON', async () => {
    const {controller} = givenController({
      requestHeaders: {accept: 'text/plain'},
      entity: {id: 1, metadata: {enabled: true}, version: 'v4'},
    });

    await expect(controller.getEntityProperty(1, 'metadata')).to.be.rejectedWith(
      /Accept header must allow one of: application\/json/i,
    );
  });

  it('returns 204 for null property reads', async () => {
    const {controller, response} = givenController({
      entity: {id: 1, metadata: null, version: 'v5'},
    });

    const result = await controller.getEntityProperty(1, 'metadata');

    expect(result).to.equal(undefined);
    sinon.assert.calledWith(response.statusStub, 204);
    sinon.assert.calledOnce(response.endStub);
  });

  function givenController(options?: {
    requestHeaders?: Record<string, string>;
    query?: Record<string, string | string[] | undefined>;
    entity?: AnyObject;
  }) {
    const headers = normalizeHeaders(options?.requestHeaders);
    const response = createResponse();
    const findById = sinon.stub().resolves(options?.entity ?? {id: 1});
    const repository = {
      findById,
    } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const controller = new ControllerCtor(
      repository,
      createRequest(headers, options?.query),
      response,
      httpCtx,
      cfg,
      applyExecutors,
      logger,
      throttler,
    );
    return {controller, repository: {findById}, response};
  }
});

function normalizeHeaders(headers?: Record<string, string>) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function createRequest(
  headers: Record<string, string>,
  query?: Record<string, string | string[] | undefined>,
): Request {
  return {
    headers,
    query: query ?? {},
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function createResponse() {
  const headers: Record<string, string> = {};
  const response = {
    headers,
    headersSent: false,
    set: sinon.stub().callsFake((name: string, value: string) => {
      headers[name] = value;
      return response;
    }),
    statusStub: sinon.stub().callsFake((_code: number) => response),
    status(code: number) {
      return response.statusStub(code);
    },
    endStub: sinon.stub(),
    end() {
      return response.endStub();
    },
    sendStub: sinon.stub(),
    send(body: unknown) {
      return response.sendStub(body);
    },
    once: sinon.stub().returnsThis(),
    getHeader(name: string) {
      return headers[name];
    },
    type: sinon.stub().callsFake((value: string) => {
      headers['content-type'] = value;
      return response;
    }),
  } as unknown as Response & {
    headers: Record<string, string>;
    statusStub: sinon.SinonStub;
    endStub: sinon.SinonStub;
    sendStub: sinon.SinonStub;
  };
  return response;
}

import {expect, sinon} from '@loopback/testlab';
import {
  AnyObject,
  DefaultCrudRepository,
  Entity,
  model,
  property,
} from '@loopback/repository';
import {Request, RequestContext, Response} from '@loopback/rest';
import {defineODataCrudController} from '../../controllers/crud-controller-factory';
import {ODataConfig} from '../../types';
import {ODataApplyExecutorRegistry} from '../../services/odata-apply-executor.registry';
import {ODataLogger, ODataTenantThrottler} from '../../keys';
import {ODataMediaHandler} from '../../services/odata-media-handler';
import {odataModel} from '../../decorators/model.decorator';

@odataModel({etag: 'version'})
@model()
class MediaHelperEntity extends Entity {
  @property({id: true})
  id?: number;

  @property({type: 'buffer'})
  payload?: Buffer;

  @property({type: 'string'})
  contentType?: string;

  @property({type: 'number'})
  size?: number;

  @property({type: 'string'})
  mediaVersion?: string;

  @property({type: 'string'})
  version?: string;
}

describe('ODataCrudController media helper methods', () => {
  const BoundControllerCtor = defineODataCrudController({
    name: 'MediaHelpers',
    modelCtor: MediaHelperEntity,
    repositoryBindingKey: 'repositories.MediaHelpers',
    etagProperties: ['version'],
    hasStream: true,
    mediaField: 'payload',
    mediaContentTypeField: 'contentType',
    mediaLengthField: 'size',
    mediaEtagField: 'mediaVersion',
    mediaHandlerBindingKey: 'services.MediaHelpers.handler',
  });
  const FallbackControllerCtor = defineODataCrudController({
    name: 'MediaFallback',
    modelCtor: MediaHelperEntity,
    repositoryBindingKey: 'repositories.MediaFallback',
    etagProperties: ['version'],
    hasStream: true,
    mediaField: 'payload',
    mediaContentTypeField: 'contentType',
    mediaLengthField: 'size',
    mediaEtagField: 'mediaVersion',
  });
  const NoStreamControllerCtor = defineODataCrudController({
    name: 'PlainEntities',
    modelCtor: MediaHelperEntity,
    repositoryBindingKey: 'repositories.PlainEntities',
  });
  const CompositeEtagControllerCtor = defineODataCrudController({
    name: 'CompositeEtags',
    modelCtor: MediaHelperEntity,
    repositoryBindingKey: 'repositories.CompositeEtags',
    etagProperties: ['version', 'mediaVersion'],
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
  const cfg = {strict: true, tokenSecret: 'unit-test-secret'} as ODataConfig;
  const applyExecutors = {} as ODataApplyExecutorRegistry;

  it('uses and caches a bound media handler when one is registered', async () => {
    const handler: ODataMediaHandler = {
      read: sinon.stub().resolves(undefined),
      write: sinon.stub().resolves(undefined),
    };
    const httpCtx = createHttpContext({
      get: sinon.stub().resolves(handler),
    });
    const controller = createController(BoundControllerCtor, {}, httpCtx);

    const first = await controller.resolveMediaHandler();
    const second = await controller.resolveMediaHandler();

    expect(first).to.equal(handler);
    expect(second).to.equal(handler);
    sinon.assert.calledOnce(httpCtx.get);
  });

  it('falls back to the built-in property-backed handler when no binding exists', async () => {
    const httpCtx = createHttpContext({
      get: sinon.stub().resolves(undefined),
    });
    const controller = createController(FallbackControllerCtor, {}, httpCtx);

    const handler = await controller.resolveMediaHandler();

    expect(handler?.constructor.name).to.equal('PropertyBackedMediaHandler');
  });

  it('requires a media handler only for stream-enabled entity sets', async () => {
    const controller = createController(NoStreamControllerCtor);

    await expect(controller.requireMediaHandler()).to.be.rejectedWith(
      /Media handler is not configured/i,
    );
    expect(controller.buildMediaProjectionFields()).to.equal(undefined);
  });

  it('builds media projection fields including id and etag properties', () => {
    const controller = createController(FallbackControllerCtor);

    expect(controller.buildMediaProjectionFields()).to.deepEqual({
      id: true,
      payload: true,
      contentType: true,
      size: true,
      mediaVersion: true,
      version: true,
    });
  });

  it('reads media metadata with sensible defaults', () => {
    const controller = createController(FallbackControllerCtor);

    expect(
      controller.readMediaEtag({mediaVersion: 'W/"media"', version: 'entity-version'}),
    ).to.equal('W/"media"');
    expect(controller.readMediaContentType({contentType: 'image/png'})).to.equal('image/png');
    expect(controller.readMediaContentType({})).to.equal('application/octet-stream');
    expect(controller.readMediaLength({size: 42})).to.equal(42);
    expect(controller.readMediaLength({size: '42'} as AnyObject)).to.equal(undefined);
  });

  it('parses Prefer and conditional request headers', () => {
    const controller = createController(FallbackControllerCtor, {
      prefer: 'respond-async, return=representation',
      'if-match': 'W/"1"',
      'if-none-match': '*',
    });

    expect(controller.parsePreferenceHeader()).to.deepEqual({
      respondAsync: true,
      returnPreference: 'representation',
    });
    expect(controller.parseIfMatchHeader()).to.deepEqual({any: false, values: ['W/"1"']});
    expect(controller.parseIfNoneMatchHeader()).to.deepEqual({any: true, values: []});
  });

  it('applies response preferences and JSON format overrides', () => {
    const response = createResponse();
    const controller = createController(FallbackControllerCtor, {}, undefined, response);

    controller.applyPreference('minimal');
    expect(response.headers['Preference-Applied']).to.equal('return=minimal');

    controller.applyFormatPreference('application/json;odata.metadata=minimal');
    expect(response.headers['content-type']).to.equal('application/json');

    expect(() => controller.applyFormatPreference('application/xml')).to.throw(
      /Only JSON \$format values are supported/i,
    );
  });

  it('skips applying preferences after headers are sent', () => {
    const response = createResponse();
    response.headersSent = true;
    const controller = createController(FallbackControllerCtor, {}, undefined, response);

    controller.applyPreference('representation');

    expect(response.headers['Preference-Applied']).to.equal(undefined);
  });

  it('enforces JSON Accept negotiation in strict mode', () => {
    const controller = createController(FallbackControllerCtor, {accept: 'text/plain'});

    expect(() => controller.ensureAcceptsJson()).to.throw(/Accept header must allow one of/i);

    const extraTypeController = createController(FallbackControllerCtor, {
      accept: 'application/xml',
    });
    expect(() => extraTypeController.ensureAcceptsJson(['application/xml'])).not.to.throw();

    const formatOverrideController = createController(FallbackControllerCtor, {
      accept: 'text/plain',
    });
    formatOverrideController.applyFormatPreference('json');
    expect(() => formatOverrideController.ensureAcceptsJson()).not.to.throw();

    const relaxedController = createController(
      FallbackControllerCtor,
      {accept: 'text/plain'},
      undefined,
      undefined,
      {strict: false},
    );
    expect(() => relaxedController.ensureAcceptsJson()).not.to.throw();
  });

  it('enforces JSON content types in strict mode', () => {
    const jsonController = createController(FallbackControllerCtor, {
      'content-type': 'application/merge-patch+json',
    });
    expect(() => jsonController.ensureJsonContentType()).not.to.throw();

    const invalidController = createController(FallbackControllerCtor, {
      'content-type': 'text/plain',
    });
    expect(() => invalidController.ensureJsonContentType()).to.throw(
      /Content-Type must be application\/json/i,
    );

    const relaxedController = createController(
      FallbackControllerCtor,
      {'content-type': 'text/plain'},
      undefined,
      undefined,
      {strict: false},
    );
    expect(() => relaxedController.ensureJsonContentType()).not.to.throw();
  });

  it('enforces apply capability only when apply input is present', () => {
    const controller = createController(FallbackControllerCtor);

    expect(() => controller.enforceApplyCapability(false, undefined)).not.to.throw();
    expect(() => controller.enforceApplyCapability(false, {apply: {} as AnyObject})).to.throw(
      /\$apply is disabled/i,
    );
    expect(() =>
      controller.enforceApplyCapability(false, {applyPipeline: [] as unknown as AnyObject}),
    ).to.throw(/\$apply is disabled/i);
    expect(() => controller.enforceApplyCapability(true, {apply: {} as AnyObject})).not.to.throw();
  });

  it('resolves tenant ids and quota enablement from config', () => {
    const defaultController = createController(FallbackControllerCtor);
    expect(defaultController.resolveTenantId()).to.equal('default');
    expect(defaultController.tenantQuotasEnabled()).to.equal(false);

    const resolvedController = createController(
      FallbackControllerCtor,
      {},
      undefined,
      undefined,
      {
        tenantResolver: () => 'tenant-a',
        tenantQuotas: {overrides: {tenantA: {maxRequestsPerMinute: 5}}},
      },
    );
    expect(resolvedController.resolveTenantId()).to.equal('tenant-a');
    expect(resolvedController.tenantQuotasEnabled()).to.equal(true);

    const whitespaceController = createController(
      FallbackControllerCtor,
      {},
      undefined,
      undefined,
      {tenantResolver: () => '   '},
    );
    expect(() => whitespaceController.resolveTenantId()).to.throw(
      /Unable to resolve tenant identifier/i,
    );

    const throwingController = createController(
      FallbackControllerCtor,
      {},
      undefined,
      undefined,
      {tenantResolver: () => {
        throw new Error('boom');
      }},
    );
    expect(() => throwingController.resolveTenantId()).to.throw(
      /Unable to resolve tenant identifier/i,
    );
  });

  it('builds conditional where clauses for single and composite etags', () => {
    const singleController = createController(FallbackControllerCtor);
    expect(singleController.buildConditionalWhere(7, ['v1'], false)).to.deepEqual({
      and: [{id: 7}, {version: 'v1'}],
    });
    expect(singleController.buildConditionalWhere(7, ['v1', 'v2'], false)).to.deepEqual({
      and: [{id: 7}, {version: {inq: ['v1', 'v2']}}],
    });
    expect(singleController.buildConditionalWhere(7, ['v1'], true)).to.deepEqual({id: 7});

    const compositeController = createController(CompositeEtagControllerCtor);
    expect(
      compositeController.buildConditionalWhere(
        7,
        [{version: 'v1', mediaVersion: 'm1'}],
        false,
      ),
    ).to.deepEqual({
      and: [{id: 7}, {and: [{mediaVersion: 'm1'}, {version: 'v1'}]}],
    });

    expect(() => compositeController.buildConditionalWhere(7, ['bad-token'], false)).to.throw(
      /ETag does not match the current resource version/i,
    );
  });

  it('raises stable precondition and preference errors', () => {
    const controller = createController(FallbackControllerCtor);

    expect(() => controller.throwPreconditionRequired()).to.throw(
      /If-Match header is required when ETags are enabled/i,
    );
    expect(() => controller.throwPreconditionFailed()).to.throw(
      /ETag does not match the current resource version/i,
    );
    expect(() => controller.throwPreferenceNotSupported('respond-async')).to.throw(
      /Prefer respond-async is not supported/i,
    );
  });
});

function createController(
  controllerCtor: new (
    repository: DefaultCrudRepository<Entity & AnyObject, unknown>,
    request: Request,
    response: Response,
    httpCtx: RequestContext,
    cfg: ODataConfig,
    applyExecutors: ODataApplyExecutorRegistry,
    logger: ODataLogger,
    throttler: ODataTenantThrottler,
  ) => AnyObject,
  requestOverrides?: Record<string, string>,
  httpCtx?: RequestContext & {get?: sinon.SinonStub},
  response?: Response & {headers: Record<string, string>; typeStub?: sinon.SinonStub},
  cfgOverrides?: Partial<ODataConfig>,
) {
  const repository = {} as DefaultCrudRepository<Entity & AnyObject, unknown>;
  return new controllerCtor(
    repository,
    createRequest(requestOverrides),
    response ?? createResponse(),
    httpCtx ?? createHttpContext(),
    {
      strict: true,
      tokenSecret: 'unit-test-secret',
      ...cfgOverrides,
    } as ODataConfig,
    {} as ODataApplyExecutorRegistry,
    {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    {
      async check() {},
      release() {},
    },
  );
}

function createRequest(headers?: Record<string, string>): Request {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }
  return {
    headers: normalized,
    get(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as unknown as Request;
}

function createResponse() {
  const headers: Record<string, string> = {};
  const response = {
    headers,
    headersSent: false,
    set(name: string, value: string) {
      headers[name] = value;
      return response;
    },
    getHeader(name: string) {
      return headers[name];
    },
    type(type: string) {
      headers['content-type'] = type;
      return response;
    },
    once() {
      return response;
    },
  } as unknown as Response & {headers: Record<string, string>};
  return response;
}

function createHttpContext(overrides?: Partial<RequestContext> & {get?: sinon.SinonStub}) {
  return {
    get: overrides?.get ?? sinon.stub().resolves(undefined),
    getSync: overrides?.getSync ?? (() => undefined),
  } as RequestContext & {get: sinon.SinonStub};
}

import {expect, sinon} from '@loopback/testlab';
import {AnyObject, DefaultCrudRepository, Entity, model, property} from '@loopback/repository';
import {Request, RequestContext, Response} from '@loopback/rest';
import {Readable} from 'stream';
import {defineODataCrudController} from '../../controllers/crud-controller-factory';
import {ODataConfig} from '../../types';
import {ODataApplyExecutorRegistry} from '../../services/odata-apply-executor.registry';
import {ODataLogger, ODataTenantThrottler} from '../../keys';
import {ODataMediaHandler} from '../../services/odata-media-handler';

@model()
class MediaRouteEntity extends Entity {
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
}

describe('ODataCrudController media routes', () => {
  const ControllerCtor = defineODataCrudController({
    name: 'MediaAssets',
    modelCtor: MediaRouteEntity,
    repositoryBindingKey: 'repositories.MediaAssets',
    hasStream: true,
    mediaField: 'payload',
    mediaContentTypeField: 'contentType',
    mediaLengthField: 'size',
    mediaEtagField: 'mediaVersion',
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

  it('returns 304 for matching If-None-Match without calling the media handler', async () => {
    const {controller, repository, response} = givenController({
      requestHeaders: {
        accept: 'image/png',
        'if-none-match': 'W/"media-1"',
      },
      entity: {
        id: 1,
        contentType: 'image/png',
        mediaVersion: 'W/"media-1"',
      },
    });
    const handler = {
      read: sinon.stub().resolves(undefined),
      write: sinon.stub().resolves(undefined),
    } as ODataMediaHandler;
    sinon.stub(controller, 'requireMediaHandler').resolves(handler);

    const result = await controller.getMediaValue(1);

    expect(result).to.equal(undefined);
    sinon.assert.notCalled(handler.read as sinon.SinonStub);
    sinon.assert.calledWith(response.statusStub, 304);
    sinon.assert.calledOnce(response.endStub);
    expect(response.headers.ETag).to.equal('W/"media-1"');
    expect(response.headers['OData-Version']).to.equal('4.0');
  });

  it('returns 204 when the media handler reports no payload', async () => {
    const {controller, response} = givenController({
      entity: {
        id: 1,
        contentType: 'application/octet-stream',
      },
    });
    const handler = {
      read: sinon.stub().resolves(undefined),
      write: sinon.stub().resolves(undefined),
    } as ODataMediaHandler;
    sinon.stub(controller, 'requireMediaHandler').resolves(handler);

    const result = await controller.getMediaValue(1);

    expect(result).to.equal(undefined);
    sinon.assert.calledOnce(handler.read as sinon.SinonStub);
    sinon.assert.calledWith(response.statusStub, 204);
    sinon.assert.calledOnce(response.endStub);
  });

  it('streams media responses with type and content length headers', async () => {
    const {controller, response} = givenController({
      requestHeaders: {accept: 'image/png'},
      entity: {
        id: 1,
        contentType: 'image/png',
        size: 5,
        mediaVersion: 'W/"media-2"',
      },
    });
    const handler = {
      read: sinon.stub().resolves({
        stream: Readable.from(['hello']),
        contentType: 'image/png',
      }),
      write: sinon.stub().resolves(undefined),
    } as ODataMediaHandler;
    sinon.stub(controller, 'requireMediaHandler').resolves(handler);
    const streamToResponse = sinon.stub(controller, 'streamToResponse').resolves();

    const result = await controller.getMediaValue(1);

    expect(result).to.equal(undefined);
    sinon.assert.calledOnce(streamToResponse);
    expect(response.headers['content-type']).to.equal('image/png');
    expect(response.headers['Content-Length']).to.equal('5');
    expect(response.headers.ETag).to.equal('W/"media-2"');
  });

  it('rejects media reads when Accept excludes the stored content type', async () => {
    const {controller} = givenController({
      requestHeaders: {accept: 'application/json'},
      entity: {
        id: 1,
        contentType: 'image/png',
        mediaVersion: 'W/"media-3"',
      },
    });
    const handler = {
      read: sinon.stub().resolves({
        stream: Readable.from(['hello']),
        contentType: 'image/png',
      }),
      write: sinon.stub().resolves(undefined),
    } as ODataMediaHandler;
    sinon.stub(controller, 'requireMediaHandler').resolves(handler);
    sinon.stub(controller, 'streamToResponse').resolves();

    await expect(controller.getMediaValue(1)).to.be.rejectedWith(/Accept header must allow/i);
  });

  it('requires a media Content-Type for binary replacements', async () => {
    const {controller} = givenController({
      entity: {
        id: 1,
        mediaVersion: 'W/"media-4"',
      },
    });

    await expect(controller.replaceMediaValue(1, Buffer.from('hello'))).to.be.rejectedWith(
      /Content-Type header is required for media requests/i,
    );
  });

  it('requires If-Match for media replacements in strict mode', async () => {
    const {controller} = givenController({
      requestHeaders: {'content-type': 'image/png'},
      entity: {
        id: 1,
        mediaVersion: 'W/"media-5"',
      },
    });

    await expect(controller.replaceMediaValue(1, Buffer.from('hello'))).to.be.rejectedWith(
      /If-Match header is required/i,
    );
  });

  it('returns a representation for media replacement when requested', async () => {
    const {controller, repository, response} = givenController({
      requestHeaders: {
        'content-type': 'image/png',
        'if-match': 'W/"media-5"',
        prefer: 'return=representation',
        accept: 'application/json',
      },
      entity: {
        id: 1,
        contentType: 'image/png',
        size: 5,
        mediaVersion: 'W/"media-5"',
      },
      reloadedEntity: {
        id: 1,
        contentType: 'image/png',
        size: 6,
        mediaVersion: 'W/"media-6"',
      },
    });
    const handler = {
      read: sinon.stub().resolves(undefined),
      write: sinon.stub().resolves({
        contentType: 'image/png',
        length: 6,
        etag: 'W/"media-6"',
      }),
    } as ODataMediaHandler;
    sinon.stub(controller, 'requireMediaHandler').resolves(handler);
    sinon.stub(controller, 'withWriteTransaction').callsFake(async (fn: () => Promise<unknown>) => fn());

    const result = await controller.replaceMediaValue(1, Buffer.from('hello!'));

    sinon.assert.calledOnce(handler.write as sinon.SinonStub);
    sinon.assert.calledWithMatch(repository.updateById, 1, {
      contentType: 'image/png',
      size: 6,
      mediaVersion: 'W/"media-6"',
    });
    sinon.assert.calledWith(response.statusStub, 200);
    expect(response.headers['Preference-Applied']).to.equal('return=representation');
    expect(response.headers.ETag).to.equal('W/"media-6"');
    expect(result).to.containEql({
      id: 1,
      contentType: 'image/png',
      size: 6,
      mediaVersion: 'W/"media-6"',
    });
    expect(result).to.have.property('@odata.context');
  });

  it('rejects media delete when the handler cannot delete', async () => {
    const {controller} = givenController({
      requestHeaders: {'if-match': 'W/"media-7"'},
      entity: {
        id: 1,
        mediaVersion: 'W/"media-7"',
      },
    });
    const handler = {
      read: sinon.stub().resolves(undefined),
      write: sinon.stub().resolves(undefined),
    } as ODataMediaHandler;
    sinon.stub(controller, 'requireMediaHandler').resolves(handler);
    sinon.stub(controller, 'withWriteTransaction').callsFake(async (fn: () => Promise<unknown>) => fn());

    await expect(controller.deleteMediaValue(1)).to.be.rejectedWith(
      /Media handler does not support delete/i,
    );
  });

  it('clears media metadata after a successful delete', async () => {
    const {controller, repository, response} = givenController({
      requestHeaders: {'if-match': 'W/"media-8"'},
      entity: {
        id: 1,
        contentType: 'image/png',
        size: 3,
        mediaVersion: 'W/"media-8"',
      },
    });
    const handler = {
      read: sinon.stub().resolves(undefined),
      write: sinon.stub().resolves(undefined),
      delete: sinon.stub().resolves(),
    } as ODataMediaHandler;
    sinon.stub(controller, 'requireMediaHandler').resolves(handler);
    sinon.stub(controller, 'withWriteTransaction').callsFake(async (fn: () => Promise<unknown>) => fn());

    const result = await controller.deleteMediaValue(1);

    expect(result).to.equal(undefined);
    sinon.assert.calledOnce(handler.delete as sinon.SinonStub);
    sinon.assert.calledWithMatch(repository.updateById, 1, {
      contentType: null,
      size: null,
      mediaVersion: null,
    });
    sinon.assert.calledWith(response.statusStub, 204);
    expect(response.headers['OData-Version']).to.equal('4.0');
  });

  function givenController(options?: {
    requestHeaders?: Record<string, string>;
    entity?: AnyObject;
    reloadedEntity?: AnyObject;
  }) {
    const headers = normalizeHeaders(options?.requestHeaders);
    const response = createResponse();
    const findById = sinon.stub();
    const firstEntity = options?.entity ?? {id: 1};
    findById.onCall(0).resolves(firstEntity);
    findById.onCall(1).resolves(options?.reloadedEntity ?? firstEntity);
    const updateById = sinon.stub().resolves();
    const repository = {
      findById,
      updateById,
    } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const controller = new ControllerCtor(
      repository,
      createRequest(headers),
      response,
      httpCtx,
      cfg,
      applyExecutors,
      logger,
      throttler,
    );
    return {controller, repository: {findById, updateById}, response};
  }
});

function normalizeHeaders(headers?: Record<string, string>) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function createRequest(headers: Record<string, string>): Request {
  return {
    headers,
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
  };
  return response;
}

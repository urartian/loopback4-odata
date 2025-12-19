import { expect, sinon } from '@loopback/testlab';
import { AnyObject, DefaultCrudRepository, Entity, model, property } from '@loopback/repository';
import { Request, RequestContext, Response } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { ODataConfig } from '../../types';
import { ODataApplyExecutorRegistry } from '../../services/odata-apply-executor.registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataMediaHandler } from '../../services/odata-media-handler';

@model()
class MediaMetadataEntity extends Entity {
  @property({ id: true })
  id?: number;

  @property({ type: 'string' })
  contentType?: string;

  @property({ type: 'number' })
  size?: number;

  @property({ type: 'string' })
  mediaVersion?: string;
}

describe('ODataCrudController media metadata updates', () => {
  const ControllerCtor = defineODataCrudController({
    name: 'TestMedia',
    modelCtor: MediaMetadataEntity,
    repositoryBindingKey: 'repositories.TestMedia',
    hasStream: true,
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
  const request = { headers: {}, get: () => undefined } as unknown as Request;
  const response = {
    headersSent: false,
    set: () => undefined,
    status: () => undefined,
    once: () => undefined,
  } as unknown as Response;
  const httpCtx = {
    getSync: () => undefined,
  } as unknown as RequestContext;
  const cfg = { tokenSecret: 'unit-test-secret' } as ODataConfig;
  const applyExecutors = {} as ODataApplyExecutorRegistry;

  afterEach(() => {
    sinon.restore();
  });

  function givenController() {
    const updateById = sinon.stub().resolves();
    const repository = {
      updateById,
    } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const controller = new ControllerCtor(
      repository,
      request,
      response,
      httpCtx,
      cfg,
      applyExecutors,
      logger,
      throttler,
    );
    return { controller, repoStub: updateById };
  }

  it('prefers handler metadata over overrides', async () => {
    const { controller, repoStub } = givenController();
    const handlerResult = {
      contentType: 'image/png',
      length: 2048,
      etag: 'W/"handler"',
    };
    const overrides = {
      contentType: 'text/plain',
      contentLength: 1111,
      etag: 'W/"override"',
    };

    const updates = await controller.applyMediaMetadataUpdates(1, handlerResult, overrides);

    sinon.assert.calledWithMatch(repoStub, 1, {
      contentType: 'image/png',
      size: 2048,
      mediaVersion: 'W/"handler"',
    });
    expect(updates).to.deepEqual({
      contentType: 'image/png',
      size: 2048,
      mediaVersion: 'W/"handler"',
    });
  });

  it('populates metadata from overrides when handler omits values', async () => {
    const { controller, repoStub } = givenController();
    const overrides = {
      contentType: 'text/plain',
      contentLength: 512,
    };
    const generated = 'W/"generated-etag"';
    sinon.stub(controller, 'generateMediaEtag').returns(generated);

    const updates = await controller.applyMediaMetadataUpdates(2, undefined, overrides);

    sinon.assert.calledWithMatch(repoStub, 2, {
      contentType: 'text/plain',
      size: 512,
      mediaVersion: generated,
    });
    expect(updates).to.deepEqual({
      contentType: 'text/plain',
      size: 512,
      mediaVersion: generated,
    });
  });

  it('persists handler-provided ETags', async () => {
    const { controller, repoStub } = givenController();
    const overrides = {
      contentType: 'application/json',
      contentLength: 256,
    };
    const handlerResult = {
      etag: 'W/"handler-override"',
    };

    const updates = await controller.applyMediaMetadataUpdates(3, handlerResult, overrides);

    sinon.assert.calledWithMatch(repoStub, 3, {
      contentType: 'application/json',
      size: 256,
      mediaVersion: 'W/"handler-override"',
    });
    expect(updates).to.deepEqual({
      contentType: 'application/json',
      size: 256,
      mediaVersion: 'W/"handler-override"',
    });
  });

  it('propagates Content-Length headers for binary media creates', async () => {
    const binaryHeaders: AnyObject = {};
    const binaryRequest = {
      headers: binaryHeaders,
      get: (name: string) => binaryHeaders[name.toLowerCase()],
    } as unknown as Request;
    const binaryResponse = {
      headersSent: false,
      set: sinon.stub(),
      status: sinon.stub(),
      end: sinon.stub(),
      once: sinon.stub(),
      getHeader: sinon.stub().returns(undefined),
      type: sinon.stub(),
    } as unknown as Response;
    (binaryResponse.status as sinon.SinonStub).returns(binaryResponse);
    const createStub = sinon.stub().resolves({ id: 1 });
    const updateStub = sinon.stub().resolves();
    const repository = {
      create: createStub,
      updateById: updateStub,
    } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const controller = new ControllerCtor(
      repository,
      binaryRequest,
      binaryResponse,
      httpCtx,
      cfg,
      applyExecutors,
      logger,
      undefined as unknown as ODataTenantThrottler,
    );
    const contentLength = 2048;
    binaryHeaders['content-type'] = 'application/octet-stream';
    binaryHeaders['content-length'] = String(contentLength);
    const writeStub = sinon.stub().resolves(undefined);
    const handler: ODataMediaHandler = {
      read: sinon.stub().resolves(undefined),
      write: writeStub,
    };
    sinon.stub(controller, 'requireMediaHandler').resolves(handler);

    await controller.create(Buffer.from('example-binary'));

    sinon.assert.calledWithMatch(writeStub, sinon.match.has('contentLength', contentLength));
    sinon.assert.calledWithMatch(updateStub, 1, sinon.match.has('size', contentLength));
  });
});

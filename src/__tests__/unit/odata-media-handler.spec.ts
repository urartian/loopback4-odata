import 'reflect-metadata';
import {expect, sinon} from '@loopback/testlab';
import {AnyObject, DefaultCrudRepository, Entity} from '@loopback/repository';
import {Readable} from 'stream';
import {
  ODataMediaDeleteContext,
  ODataMediaReadContext,
  ODataMediaWriteContext,
  PropertyBackedMediaHandler,
  RepositoryMediaHandlerAdapter,
} from '../../services/odata-media-handler';
import {EntitySetDef} from '../../registry/entityset-registry';

describe('PropertyBackedMediaHandler', () => {
  const entitySet = {
    name: 'MediaAssets',
    modelCtor: Entity,
  } as EntitySetDef;

  it('rejects writes that declare a Content-Length exceeding the limit', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload', {maxPayloadBytes: 5});

    const ctx = buildWriteContext(repo.crud, {
      contentLength: 12,
      stream: Readable.from(['hello world']),
    });

    await expect(handler.write(ctx)).to.be.rejectedWith(/exceeds the configured limit/i);
    expect(repo.writes.size).to.equal(0);
  });

  it('aborts streaming uploads once the buffered bytes exceed the limit', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload', {maxPayloadBytes: 6});

    const ctx = buildWriteContext(repo.crud, {
      stream: Readable.from(['abc', 'def', 'ghi']),
    });

    await expect(handler.write(ctx)).to.be.rejectedWith(/exceeds the configured limit/i);
    expect(repo.writes.size).to.equal(0);
  });

  it('persists the buffered payload when it fits within the limit', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload', {maxPayloadBytes: 64});

    const payload = 'hello';
    const ctx = buildWriteContext(repo.crud, {stream: Readable.from([payload])});

    const result = await handler.write(ctx);
    expect(result?.length).to.equal(Buffer.byteLength(payload));

    const stored = repo.writes.get('asset-1');
    expect(Buffer.isBuffer(stored?.payload)).to.equal(true);
    expect((stored?.payload as Buffer).toString()).to.equal(payload);
  });

  it('reads a buffered field from the repository and reports its length', async () => {
    const repo = createRepositoryStub({
      entities: new Map([['asset-1', {payload: Buffer.from('hello')}]]),
    });
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload');

    const result = await handler.read(buildReadContext(repo.crud));

    expect(await readStream(result?.stream)).to.equal('hello');
    expect(result?.length).to.equal(5);
    sinon.assert.calledOnce(repo.findById);
  });

  it('uses the preloaded entity when provided', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload');

    const result = await handler.read(
      buildReadContext(repo.crud, {
        entity: {payload: Buffer.from('cached')},
      }),
    );

    expect(await readStream(result?.stream)).to.equal('cached');
    sinon.assert.notCalled(repo.findById);
  });

  it('supports Uint8Array and serialized Buffer payloads', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload');

    const uint8Result = await handler.read(
      buildReadContext(repo.crud, {
        entity: {payload: new Uint8Array(Buffer.from('bytes'))},
      }),
    );
    expect(await readStream(uint8Result?.stream)).to.equal('bytes');
    expect(uint8Result?.length).to.equal(5);

    const serializedResult = await handler.read(
      buildReadContext(repo.crud, {
        entity: {payload: {type: 'Buffer', data: [111, 107]}},
      }),
    );
    expect(await readStream(serializedResult?.stream)).to.equal('ok');
    expect(serializedResult?.length).to.equal(2);
  });

  it('returns a stream without a known length for Readable payloads', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload');

    const result = await handler.read(
      buildReadContext(repo.crud, {
        entity: {payload: Readable.from(['streamed'])},
      }),
    );

    expect(await readStream(result?.stream)).to.equal('streamed');
    expect(result?.length).to.equal(undefined);
  });

  it('returns undefined when the entity is missing or the field is empty', async () => {
    const missingRepo = createRepositoryStub({
      findByIdError: new Error('missing'),
    });
    const handler = new PropertyBackedMediaHandler(missingRepo.crud, 'payload');

    const missing = await handler.read(buildReadContext(missingRepo.crud));
    expect(missing).to.equal(undefined);

    const emptyRepo = createRepositoryStub({
      entities: new Map([['asset-1', {payload: null}]]),
    });
    const emptyHandler = new PropertyBackedMediaHandler(emptyRepo.crud, 'payload');

    const empty = await emptyHandler.read(buildReadContext(emptyRepo.crud));
    expect(empty).to.equal(undefined);
  });

  it('rejects unsupported media field values', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload');

    await expect(
      handler.read(
        buildReadContext(repo.crud, {
          entity: {payload: 'not-binary'},
        }),
      ),
    ).to.be.rejectedWith(/must contain binary data/i);
  });

  it('clears the media field on delete', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload');

    await handler.delete(buildDeleteContext(repo.crud));

    expect(repo.writes.get('asset-1')).to.deepEqual({payload: null});
  });

  it('rejects invalid maxPayloadBytes values', () => {
    const repo = createRepositoryStub();

    expect(() => new PropertyBackedMediaHandler(repo.crud, 'payload', {maxPayloadBytes: 0})).to
      .throw(/positive finite number/i);
    expect(() => new PropertyBackedMediaHandler(repo.crud, 'payload', {maxPayloadBytes: Infinity}))
      .to.throw(/positive finite number/i);
  });

  function buildReadContext(
    repo: DefaultCrudRepository<Entity & AnyObject, unknown>,
    overrides: Partial<ODataMediaReadContext> = {},
  ): ODataMediaReadContext {
    return {
      id: 'asset-1',
      entitySet,
      repository: repo,
      entity: overrides.entity,
      options: overrides.options,
    };
  }

  function buildWriteContext(
    repo: DefaultCrudRepository<Entity & AnyObject, unknown>,
    overrides: Partial<ODataMediaWriteContext>,
  ): ODataMediaWriteContext {
    return {
      id: 'asset-1',
      entitySet,
      repository: repo,
      stream: overrides.stream ?? Readable.from([]),
      contentType: overrides.contentType,
      contentLength: overrides.contentLength,
      options: overrides.options,
      slug: overrides.slug,
      entity: overrides.entity,
    };
  }

  function buildDeleteContext(
    repo: DefaultCrudRepository<Entity & AnyObject, unknown>,
    overrides: Partial<ODataMediaDeleteContext> = {},
  ): ODataMediaDeleteContext {
    return {
      id: 'asset-1',
      entitySet,
      repository: repo,
      entity: overrides.entity,
      options: overrides.options,
    };
  }
});

describe('RepositoryMediaHandlerAdapter', () => {
  const entitySet = {
    name: 'MediaAssets',
    modelCtor: Entity,
  } as EntitySetDef;

  it('rejects missing repository media methods', async () => {
    const repository = {} as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const handler = new RepositoryMediaHandlerAdapter(repository);
    const readCtx = buildReadContext(repository);
    const writeCtx = buildWriteContext(repository, {stream: Readable.from(['x'])});

    await expect(handler.read(readCtx)).to.be.rejectedWith(/does not expose getMedia/i);
    await expect(handler.write(writeCtx)).to.be.rejectedWith(/does not expose setMedia/i);
    await expect(handler.delete(buildDeleteContext(repository))).to.be.rejectedWith(
      /does not expose deleteMedia/i,
    );
  });

  it('normalizes Readable, Buffer, serialized Buffer, and structured read results', async () => {
    const stream = Readable.from(['stream']);
    const getMedia = sinon.stub();
    getMedia.onCall(0).resolves(stream);
    getMedia.onCall(1).resolves(Buffer.from('buffer'));
    getMedia.onCall(2).resolves({type: 'Buffer', data: [111, 107]});
    getMedia.onCall(3).resolves({
      stream: Readable.from(['result']),
      contentType: 'text/plain',
      etag: 'W/"media"',
      length: 6,
    });
    const repository = {getMedia} as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const handler = new RepositoryMediaHandlerAdapter(repository);

    const streamResult = await handler.read(buildReadContext(repository));
    expect(await readStream(streamResult?.stream)).to.equal('stream');
    expect(streamResult?.length).to.equal(undefined);

    const bufferResult = await handler.read(buildReadContext(repository));
    expect(await readStream(bufferResult?.stream)).to.equal('buffer');
    expect(bufferResult?.length).to.equal(6);

    const serializedResult = await handler.read(buildReadContext(repository));
    expect(await readStream(serializedResult?.stream)).to.equal('ok');
    expect(serializedResult?.length).to.equal(2);

    const structuredResult = await handler.read(buildReadContext(repository));
    expect(await readStream(structuredResult?.stream)).to.equal('result');
    expect(structuredResult).to.containEql({
      contentType: 'text/plain',
      etag: 'W/"media"',
      length: 6,
    });
  });

  it('rejects invalid getMedia return values', async () => {
    const repository = {
      getMedia: sinon.stub().resolves('invalid'),
    } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const handler = new RepositoryMediaHandlerAdapter(repository);

    await expect(handler.read(buildReadContext(repository))).to.be.rejectedWith(
      /must return a stream, Buffer, or ODataMediaReadResult/i,
    );
  });

  it('passes metadata through setMedia and accepts both void and result returns', async () => {
    const setMedia = sinon.stub();
    setMedia.onCall(0).resolves();
    setMedia.onCall(1).resolves({
      contentType: 'image/png',
      etag: 'W/"adapter"',
      length: 3,
    });
    const repository = {
      setMedia,
    } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const handler = new RepositoryMediaHandlerAdapter(repository);

    const first = await handler.write(
      buildWriteContext(repository, {
        stream: Readable.from(['abc']),
        contentType: 'text/plain',
        contentLength: 3,
        slug: 'asset.txt',
      }),
    );
    expect(first).to.equal(undefined);

    const second = await handler.write(
      buildWriteContext(repository, {
        stream: Readable.from(['png']),
        contentType: 'image/png',
        contentLength: 3,
        slug: 'asset.png',
      }),
    );
    expect(second).to.deepEqual({
      contentType: 'image/png',
      etag: 'W/"adapter"',
      length: 3,
    });

    sinon.assert.calledWithMatch(
      setMedia.firstCall,
      'asset-1',
      sinon.match.instanceOf(Readable),
      {
        contentType: 'text/plain',
        contentLength: 3,
        slug: 'asset.txt',
      },
      undefined,
    );
  });

  it('delegates deleteMedia with the request id and options', async () => {
    const deleteMedia = sinon.stub().resolves();
    const repository = {
      deleteMedia,
    } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    const handler = new RepositoryMediaHandlerAdapter(repository);

    await handler.delete(
      buildDeleteContext(repository, {
        id: 99,
        options: {transaction: 'tx'} as AnyObject,
      }),
    );

    sinon.assert.calledWithExactly(deleteMedia, 99, {transaction: 'tx'});
  });

  function buildReadContext(
    repo: DefaultCrudRepository<Entity & AnyObject, unknown>,
  ): ODataMediaReadContext {
    return {
      id: 'asset-1',
      entitySet,
      repository: repo,
    };
  }

  function buildWriteContext(
    repo: DefaultCrudRepository<Entity & AnyObject, unknown>,
    overrides: Partial<ODataMediaWriteContext>,
  ): ODataMediaWriteContext {
    return {
      id: 'asset-1',
      entitySet,
      repository: repo,
      stream: overrides.stream ?? Readable.from([]),
      contentType: overrides.contentType,
      contentLength: overrides.contentLength,
      options: overrides.options,
      slug: overrides.slug,
      entity: overrides.entity,
    };
  }

  function buildDeleteContext(
    repo: DefaultCrudRepository<Entity & AnyObject, unknown>,
    overrides: Partial<ODataMediaDeleteContext> = {},
  ): ODataMediaDeleteContext {
    return {
      id: overrides.id ?? 'asset-1',
      entitySet,
      repository: repo,
      entity: overrides.entity,
      options: overrides.options,
    };
  }
});

function createRepositoryStub(options?: {
  entities?: Map<unknown, AnyObject>;
  findByIdError?: Error;
}) {
  const writes = new Map<unknown, AnyObject>();
  const entities = options?.entities ?? new Map<unknown, AnyObject>();
  const updateById = sinon.stub().callsFake(async (id: unknown, data: AnyObject) => {
    writes.set(id, data);
  });
  const findById = sinon.stub().callsFake(async (id: unknown) => {
    if (options?.findByIdError) throw options.findByIdError;
    const entity = entities.get(id);
    if (!entity) throw new Error('missing');
    return entity;
  });
  const crud = {
    updateById,
    findById,
  } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
  return {crud, writes, findById, updateById};
}

async function readStream(stream?: Readable): Promise<string | undefined> {
  if (!stream) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

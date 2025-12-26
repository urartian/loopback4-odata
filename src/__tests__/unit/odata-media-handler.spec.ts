import 'reflect-metadata';
import { expect } from '@loopback/testlab';
import { AnyObject, DefaultCrudRepository, Entity } from '@loopback/repository';
import { Readable } from 'stream';
import {
  ODataMediaWriteContext,
  PropertyBackedMediaHandler,
} from '../../services/odata-media-handler';
import { EntitySetDef } from '../../registry/entityset-registry';

describe('PropertyBackedMediaHandler', () => {
  const entitySet = {
    name: 'MediaAssets',
    modelCtor: Entity,
  } as EntitySetDef;

  it('rejects writes that declare a Content-Length exceeding the limit', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload', { maxPayloadBytes: 5 });

    const ctx = buildWriteContext(repo.crud, {
      contentLength: 12,
      stream: Readable.from(['hello world']),
    });

    await expect(handler.write(ctx)).to.be.rejectedWith(/exceeds the configured limit/i);
    expect(repo.writes.size).to.equal(0);
  });

  it('aborts streaming uploads once the buffered bytes exceed the limit', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload', { maxPayloadBytes: 6 });

    const ctx = buildWriteContext(repo.crud, {
      stream: Readable.from(['abc', 'def', 'ghi']),
    });

    await expect(handler.write(ctx)).to.be.rejectedWith(/exceeds the configured limit/i);
    expect(repo.writes.size).to.equal(0);
  });

  it('persists the buffered payload when it fits within the limit', async () => {
    const repo = createRepositoryStub();
    const handler = new PropertyBackedMediaHandler(repo.crud, 'payload', { maxPayloadBytes: 64 });

    const payload = 'hello';
    const ctx = buildWriteContext(repo.crud, { stream: Readable.from([payload]) });

    const result = await handler.write(ctx);
    expect(result?.length).to.equal(Buffer.byteLength(payload));

    const stored = repo.writes.get('asset-1');
    expect(Buffer.isBuffer(stored?.payload)).to.equal(true);
    expect((stored?.payload as Buffer).toString()).to.equal(payload);
  });

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
    };
  }

  function createRepositoryStub() {
    const writes = new Map<unknown, AnyObject>();
    const crud = {
      async updateById(id: unknown, data: AnyObject) {
        writes.set(id, data);
      },
    } as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    return { crud, writes };
  }
});

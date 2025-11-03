/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { ODataBatchController, BatchResponsePayload } from '../../controllers/batch.controller';
import { ODataConfig } from '../../types';
import { HttpErrors, Response } from '@loopback/rest';
import { Readable } from 'stream';

type StubResponseMap = Record<
  string,
  { status: number; body?: unknown; headers?: Record<string, string> }
>;

const defaultConfig: ODataConfig = {
  tokenSecret: 'test-secret',
  batch: {
    maxPayloadBytes: 1024 * 1024,
    maxOperations: 100,
    maxChangesetOperations: 100,
    maxDepth: 3,
    maxPartBodyBytes: 512 * 1024,
  },
};

function createController(stubs: StubResponseMap) {
  const controller = new ODataBatchController(
    { handleRequest: async () => undefined } as any,
    'http://localhost',
    { get: async () => undefined } as any,
    { findByName: () => undefined } as any,
    defaultConfig,
  );
  (controller as any).executeSingle = async (request: { id: string }) => {
    const stub = stubs[request.id];
    if (!stub) {
      throw new Error(`Missing stub for request ${request.id}`);
    }
    return {
      id: request.id,
      status: stub.status,
      headers: stub.headers,
      body: stub.body,
    };
  };
  return controller;
}

const responseStub = {
  contentType: () => undefined,
  set: () => undefined,
  send: () => undefined,
} as unknown as Response;

function requestStub(contentType: string): any {
  return {
    headers: { 'content-type': contentType },
    get: (header: string) => (header.toLowerCase() === 'content-type' ? contentType : undefined),
  };
}

describe('$batch controller', () => {
  it('returns batched responses in order', async () => {
    const controller = createController({
      '1': { status: 200, body: { value: [{ id: 1 }] } },
      '2': { status: 200, body: { value: [] } },
    });

    const batchResult = (await controller.handleBatch(
      {
        requests: [
          { id: '1', method: 'GET', url: '/odata/Products' },
          { id: '2', method: 'GET', url: '/odata/Products/$count' },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(batchResult.responses.length, 2);
    const first = batchResult.responses[0];
    const second = batchResult.responses[1];
    assert.equal(first.id, '1');
    assert.equal(first.status, 200);
    assert.deepStrictEqual(first.body, { value: [{ id: 1 }] });
    assert.equal(second.id, '2');
    assert.equal(second.status, 200);
    assert.deepStrictEqual(second.body, { value: [] });
  });

  it('returns all executed responses up to failing request inside changeset', async () => {
    const controller = createController({
      a1: { status: 200, body: { value: [{ id: 10 }] } },
      a2: { status: 409, body: { error: { code: 'Conflict' } } },
    });
    let rollbackCalled = false;
    (controller as any).createAtomicGroupContext = async () => ({
      applyTo: () => undefined,
      clearFrom: () => undefined,
      commit: async () => undefined,
      rollback: async () => {
        rollbackCalled = true;
      },
    });

    const batchResult = (await controller.handleBatch(
      {
        requests: [
          { id: 'a1', method: 'POST', url: '/odata/Products', atomicityGroup: 'changeset-1' },
          { id: 'a2', method: 'POST', url: '/odata/Products', atomicityGroup: 'changeset-1' },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(batchResult.responses.length, 2);
    const first = batchResult.responses[0];
    const second = batchResult.responses[1];
    assert.equal(first.atomicityGroup, 'changeset-1');
    assert.equal(first.id, 'a1');
    assert.equal(first.status, 200);
    assert.equal(second.atomicityGroup, 'changeset-1');
    assert.equal(second.id, 'a2');
    assert.equal(second.status, 409);
    assert.deepStrictEqual(second.body, { error: { code: 'Conflict' } });
    assert.equal(rollbackCalled, true);
  });

  it('rejects empty request arrays', async () => {
    const controller = createController({});
    await assert.rejects(
      controller.handleBatch({ requests: [] }, responseStub, requestStub('application/json')),
      (err: unknown) => err instanceof HttpErrors.BadRequest,
    );
  });

  it('returns 400 for malformed URLs', async () => {
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      defaultConfig,
    );

    const result = await (controller as any).executeSingle({
      id: 'bad',
      method: 'GET',
      url: '',
    });

    assert.equal(result.status, 400);
    assert.equal((result.body as any)?.error?.code, 'InvalidUrl');
  });

  it('returns 400 when method is missing', async () => {
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      defaultConfig,
    );

    const result = await (controller as any).executeSingle({
      id: 'bad',
      method: undefined,
      url: '/odata/Products',
    });

    assert.equal(result.status, 400);
    assert.equal((result.body as any)?.error?.code, 'InvalidMethod');
  });

  it('commits transactional group when all requests succeed', async () => {
    const controller = createController({
      t1: { status: 200 },
      t2: { status: 200 },
    });

    let commitCalled = false;
    (controller as any).createAtomicGroupContext = async () => ({
      applyTo: () => undefined,
      clearFrom: () => undefined,
      commit: async () => {
        commitCalled = true;
      },
      rollback: async () => undefined,
    });

    const result = (await controller.handleBatch(
      {
        requests: [
          { id: 't1', method: 'POST', url: '/odata/Products', atomicityGroup: 'group-1' },
          { id: 't2', method: 'PATCH', url: '/odata/Products(1)', atomicityGroup: 'group-1' },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(result.responses.length, 2);
    assert.equal(commitCalled, true);
    for (const entry of result.responses) {
      assert.equal(entry.atomicityGroup, 'group-1');
      assert.equal(entry.status, 200);
    }
  });

  it('appends 424 Failed Dependency for unexecuted requests after a failure in a changeset', async () => {
    const controller = createController({
      b1: { status: 200, body: { value: [{ id: 1 }] } },
      b2: { status: 409, body: { error: { code: 'Conflict' } } },
      // Note: no stub for b3 -> it should not be executed, server should synthesize 424
    });
    let rolledBack = false;
    (controller as any).createAtomicGroupContext = async () => ({
      applyTo: () => undefined,
      clearFrom: () => undefined,
      commit: async () => undefined,
      rollback: async () => {
        rolledBack = true;
      },
    });

    const result = (await controller.handleBatch(
      {
        requests: [
          { id: 'b1', method: 'POST', url: '/odata/Products', atomicityGroup: 'g2' },
          { id: 'b2', method: 'POST', url: '/odata/Products', atomicityGroup: 'g2' },
          { id: 'b3', method: 'POST', url: '/odata/Products', atomicityGroup: 'g2' },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(rolledBack, true);
    assert.equal(result.responses.length, 3);
    const [r1, r2, r3] = result.responses;
    assert.equal(r1.id, 'b1');
    assert.equal(r1.atomicityGroup, 'g2');
    assert.equal(r1.status, 200);
    assert.equal(r2.id, 'b2');
    assert.equal(r2.atomicityGroup, 'g2');
    assert.equal(r2.status, 409);
    assert.equal(r3.id, 'b3');
    assert.equal(r3.atomicityGroup, 'g2');
    assert.equal(r3.status, 424);
    assert.equal((r3.body as any)?.error?.code, 'FailedDependency');
  });

  it('returns 501 when atomicity group cannot start a transaction', async () => {
    const registry = {
      findByName: (name: string) =>
        name === 'Products'
          ? {
              name: 'Products',
              modelCtor: class {},
              repositoryBindingKey: 'repositories.Products',
            }
          : undefined,
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      { get: async () => ({ dataSource: { name: 'db' } }) } as any,
      registry,
      defaultConfig,
    );

    const result = (await controller.handleBatch(
      {
        requests: [{ id: 'x', method: 'POST', url: '/odata/Products', atomicityGroup: 'no-tx' }],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(result.responses.length, 1);
    const failure = result.responses[0];
    assert.equal(failure.atomicityGroup, 'no-tx');
    assert.equal(failure.status, 501);
    assert.equal((failure.body as any)?.error?.code, 'BatchExecutionError');
  });
});

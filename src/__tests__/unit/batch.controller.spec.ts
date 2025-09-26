/// <reference path="../../types/testing.globals.d.ts" />

import {strict as assert} from 'assert';
import {ODataBatchController, BatchResponsePayload} from '../../controllers/batch.controller';
import {HttpErrors, Response} from '@loopback/rest';
import {Readable} from 'stream';

type StubResponseMap = Record<string, {status: number; body?: unknown; headers?: Record<string, string>}>;

function createController(stubs: StubResponseMap) {
  const controller = new ODataBatchController(
    {handleRequest: async () => undefined} as any,
    'http://localhost',
    {get: async () => undefined} as any,
    {findByName: () => undefined} as any,
  );
  (controller as any).executeSingle = async (request: {id: string}) => {
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
    headers: {'content-type': contentType},
    get: (header: string) => (header.toLowerCase() === 'content-type' ? contentType : undefined),
  };
}

describe('$batch controller', () => {
  it('returns batched responses in order', async () => {
    const controller = createController({
      '1': {status: 200, body: {value: [{id: 1}]}},
      '2': {status: 200, body: {value: []}},
    });

    const batchResult = (await controller.handleBatch(
      {
        requests: [
          {id: '1', method: 'GET', url: '/odata/Products'},
          {id: '2', method: 'GET', url: '/odata/Products/$count'},
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
    assert.deepStrictEqual(first.body, {value: [{id: 1}]});
    assert.equal(second.id, '2');
    assert.equal(second.status, 200);
    assert.deepStrictEqual(second.body, {value: []});
  });

  it('stops at failing request inside changeset', async () => {
    const controller = createController({
      a1: {status: 200, body: {value: [{id: 10}]}},
      a2: {status: 409, body: {error: {code: 'Conflict'}}},
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
          {id: 'a1', method: 'POST', url: '/odata/Products', atomicityGroup: 'changeset-1'},
          {id: 'a2', method: 'POST', url: '/odata/Products', atomicityGroup: 'changeset-1'},
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(batchResult.responses.length, 1);
    const [failure] = batchResult.responses;
    assert.equal(failure.atomicityGroup, 'changeset-1');
    assert.equal(failure.id, 'a2');
    assert.equal(failure.status, 409);
    assert.deepStrictEqual(failure.body, {error: {code: 'Conflict'}});
    assert.equal(rollbackCalled, true);
  });

  it('rejects empty request arrays', async () => {
    const controller = createController({});
    await assert.rejects(
      controller.handleBatch({requests: []}, responseStub, requestStub('application/json')),
      (err: unknown) => err instanceof HttpErrors.BadRequest,
    );
  });

  it('returns 400 for malformed URLs', async () => {
    const controller = new ODataBatchController(
      {handleRequest: async () => undefined} as any,
      'http://localhost',
      {get: async () => undefined} as any,
      {findByName: () => undefined} as any,
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
      {handleRequest: async () => undefined} as any,
      'http://localhost',
      {get: async () => undefined} as any,
      {findByName: () => undefined} as any,
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
      t1: {status: 200},
      t2: {status: 200},
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
          {id: 't1', method: 'POST', url: '/odata/Products', atomicityGroup: 'group-1'},
          {id: 't2', method: 'PATCH', url: '/odata/Products(1)', atomicityGroup: 'group-1'},
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
      {handleRequest: async () => undefined} as any,
      'http://localhost',
      {get: async () => ({dataSource: {name: 'db'}})} as any,
      registry,
    );

    const result = (await controller.handleBatch(
      {
        requests: [
          {id: 'x', method: 'POST', url: '/odata/Products', atomicityGroup: 'no-tx'},
        ],
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

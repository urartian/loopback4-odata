import {strict as assert} from 'assert';
import {ODataBatchController} from '../controllers/batch.controller';
import {HttpErrors, Response} from '@loopback/rest';

type StubResponseMap = Record<string, {status: number; body?: unknown; headers?: Record<string, string>}>;

function createController(stubs: StubResponseMap) {
  const controller = new ODataBatchController({handleRequest: async () => undefined} as any);
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

const responseStub = {contentType: () => undefined} as unknown as Response;

(async () => {
  const controller = createController({
    '1': {status: 200, body: {value: [{id: 1}]}},
    '2': {status: 200, body: {value: []}},
  });

  const batchResult = await controller.handleBatch(
    {
      requests: [
        {id: '1', method: 'GET', url: '/odata/Products'},
        {id: '2', method: 'GET', url: '/odata/Products/$count'},
      ],
    },
    responseStub,
  );

  assert.equal(batchResult.responses.length, 2);
  const first = batchResult.responses[0];
  const second = batchResult.responses[1];
  assert.equal(first.id, '1');
  assert.equal(first.status, 200);
  assert.deepStrictEqual(first.body, {value: [{id: 1}]});
  assert.equal(second.id, '2');
  assert.equal(second.status, 200);
  assert.deepStrictEqual(second.body, {value: []});
})();

(async () => {
  const controller = createController({
    a1: {status: 200, body: {value: [{id: 10}]}},
    a2: {status: 409, body: {error: {code: 'Conflict'}}},
  });

  const batchResult = await controller.handleBatch(
    {
      requests: [
        {id: 'a1', method: 'POST', url: '/odata/Products', atomicityGroup: 'changeset-1'},
        {id: 'a2', method: 'POST', url: '/odata/Products', atomicityGroup: 'changeset-1'},
      ],
    },
    responseStub,
  );

  assert.equal(batchResult.responses.length, 1);
  const [failure] = batchResult.responses;
  assert.equal(failure.atomicityGroup, 'changeset-1');
  assert.equal(failure.id, 'a2');
  assert.equal(failure.status, 409);
  assert.deepStrictEqual(failure.body, {error: {code: 'Conflict'}});
})();

(async () => {
  const controller = createController({});
  let caught = false;
  try {
    await controller.handleBatch({requests: []}, responseStub);
  } catch (error) {
    caught = error instanceof HttpErrors.BadRequest;
  }
  assert.ok(caught, 'Expected BadRequest for empty batch payload');
})();

console.log('All $batch controller tests passed');

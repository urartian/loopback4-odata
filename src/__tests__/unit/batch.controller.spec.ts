/// <reference path="../../types/testing.globals.d.ts" />

import 'reflect-metadata';
import { strict as assert } from 'assert';
import { ODataBatchController, BatchResponsePayload } from '../../controllers/batch.controller';
import { ODataConfig } from '../../types';
import { HttpErrors, Response } from '@loopback/rest';
import { Readable } from 'stream';
import { ODataLogger } from '../../keys';
import { EntitySetRegistry } from '../../registry/entityset-registry';
import { Order, OrderItem } from '../fixtures/odata-app.fixture';
import { ODATA_ATOMICITY_STATE } from '../../constants';
import { Entity, hasMany, model, property } from '@loopback/repository';

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
    maxResponseBodyBytes: 512 * 1024,
    maxResponsePayloadBytes: 4 * 1024 * 1024,
  },
};

const noopLogger: ODataLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function createController(stubs: StubResponseMap, config: ODataConfig = defaultConfig) {
  const requestContext = createRequestContextStub();
  const controller = new ODataBatchController(
    { handleRequest: async () => undefined } as any,
    'http://localhost',
    requestContext,
    { get: async () => undefined } as any,
    { findByName: () => undefined } as any,
    noopLogger,
    config,
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

function createRequestContextStub() {
  return {
    getSync: () => undefined,
  } as any;
}

const responseStub = {
  contentType: () => undefined,
  set: () => undefined,
  send: () => undefined,
} as unknown as Response;

function requestStub(contentType: string, overrides?: Record<string, unknown>): any {
  const headers: Record<string, string> = {};
  const extraHeaders = (overrides?.headers ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers[key.toLowerCase()] = value;
  }
  headers['content-type'] = headers['content-type'] ?? contentType;
  const stub: any = {
    headers,
    get: (header: string) => headers[header.toLowerCase()],
  };
  return Object.assign(stub, overrides);
}

function createControllerWithRegistry(
  stubs: StubResponseMap,
  registry: EntitySetRegistry,
  executedUrls: Record<string, string>,
) {
  const controller = new ODataBatchController(
    { handleRequest: async () => undefined } as any,
    'http://localhost',
    createRequestContextStub(),
    { get: async () => undefined } as any,
    registry,
    noopLogger,
    defaultConfig,
  );
  (controller as any).executeSingle = async (request: { id: string; url?: string }) => {
    if (request.id && request.url) {
      executedUrls[request.id] = request.url;
    }
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

  it('rejects changesets that would write to multiple datasources', async () => {
    let beginCount = 0;
    const dsA = {
      name: 'dsA',
      async beginTransaction() {
        beginCount += 1;
        return { commit: async () => undefined, rollback: async () => undefined };
      },
    };
    const dsB = {
      name: 'dsB',
      async beginTransaction() {
        beginCount += 1;
        return { commit: async () => undefined, rollback: async () => undefined };
      },
    };
    const defs = {
      Orders: {
        name: 'Orders',
        modelCtor: class {},
        repositoryBindingKey: 'repositories.Orders',
      },
      Customers: {
        name: 'Customers',
        modelCtor: class {},
        repositoryBindingKey: 'repositories.Customers',
      },
    };
    const registry = {
      findByName: (name: string) => (defs as any)[name],
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async (binding: string) => {
          if (binding === 'repositories.Orders') return { dataSource: dsA };
          if (binding === 'repositories.Customers') return { dataSource: dsB };
          return undefined;
        },
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );
    let executed = 0;
    (controller as any).executeSingle = async (request: { id?: string }) => {
      executed += 1;
      return { id: request.id, status: 204 };
    };

    const batchResult = (await controller.handleBatch(
      {
        requests: [
          { id: 'o1', method: 'POST', url: '/odata/Orders', atomicityGroup: 'g1' },
          { id: 'c1', method: 'POST', url: '/odata/Customers', atomicityGroup: 'g1' },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(executed, 0);
    assert.equal(beginCount, 0);
    const changeset = batchResult.responses.filter((entry: any) => entry.atomicityGroup === 'g1');
    assert.equal(changeset.length, 2);
    for (const entry of changeset) {
      assert.equal(entry.status, 501);
      assert.equal((entry.body as any)?.error?.code, 'MultiDataSourceChangesetNotSupported');
    }
  });

  it('resolves Content-ID URLs within a changeset and uses a single transaction', async () => {
    @model()
    class OrderModel extends Entity {
      @property({ id: true })
      id!: number;

      @hasMany(() => OrderItemModel)
      items?: OrderItemModel[];
    }

    @model()
    class OrderItemModel extends Entity {
      @property({ id: true })
      id!: number;
    }

    let beginCount = 0;
    let commitCount = 0;
    let rollbackCount = 0;
    const tx = {
      async commit() {
        commitCount += 1;
      },
      async rollback() {
        rollbackCount += 1;
      },
    };
    const ds = {
      name: 'db',
      async beginTransaction() {
        beginCount += 1;
        return tx;
      },
    };
    const defs = {
      Orders: {
        name: 'Orders',
        modelCtor: OrderModel,
        repositoryBindingKey: 'repositories.Orders',
      },
      OrderItems: {
        name: 'OrderItems',
        modelCtor: OrderItemModel,
        repositoryBindingKey: 'repositories.OrderItems',
      },
    };
    const registry = {
      findByName: (name: string) => (defs as any)[name],
      get: (modelCtor: unknown) =>
        modelCtor === OrderModel
          ? (defs as any).Orders
          : modelCtor === OrderItemModel
            ? (defs as any).OrderItems
            : undefined,
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => ({ dataSource: ds }),
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );
    let executed = 0;
    (controller as any).executeSingle = async (request: { id?: string }) => {
      executed += 1;
      return { id: request.id, status: 204 };
    };

    const batchResult = (await controller.handleBatch(
      {
        requests: [
          { id: '1', method: 'POST', url: '/odata/Orders', atomicityGroup: 'g1' },
          { id: '2', method: 'POST', url: '$1/Items', atomicityGroup: 'g1' },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(executed, 2);
    assert.equal(beginCount, 1);
    assert.equal(commitCount, 1);
    assert.equal(rollbackCount, 0);
    const changeset = batchResult.responses.filter((entry: any) => entry.atomicityGroup === 'g1');
    assert.equal(changeset.length, 2);
    for (const entry of changeset) {
      assert.equal(entry.status, 204);
    }
  });

  it('rejects Content-ID forward references inside a changeset', async () => {
    @model()
    class OrderModel extends Entity {
      @property({ id: true })
      id!: number;

      @hasMany(() => OrderItemModel)
      items?: OrderItemModel[];
    }

    @model()
    class OrderItemModel extends Entity {
      @property({ id: true })
      id!: number;
    }

    let beginCount = 0;
    const ds = {
      name: 'db',
      async beginTransaction() {
        beginCount += 1;
        return { commit: async () => undefined, rollback: async () => undefined };
      },
    };
    const defs = {
      Orders: {
        name: 'Orders',
        modelCtor: OrderModel,
        repositoryBindingKey: 'repositories.Orders',
      },
      OrderItems: {
        name: 'OrderItems',
        modelCtor: OrderItemModel,
        repositoryBindingKey: 'repositories.OrderItems',
      },
    };
    const registry = {
      findByName: (name: string) => (defs as any)[name],
      get: (modelCtor: unknown) =>
        modelCtor === OrderModel
          ? (defs as any).Orders
          : modelCtor === OrderItemModel
            ? (defs as any).OrderItems
            : undefined,
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => ({ dataSource: ds }),
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );
    let executed = 0;
    (controller as any).executeSingle = async (request: { id?: string }) => {
      executed += 1;
      return { id: request.id, status: 204 };
    };

    await assert.rejects(
      () =>
        controller.handleBatch(
          {
            requests: [
              { id: '1', method: 'POST', url: '$2/Items', atomicityGroup: 'g1' },
              { id: '2', method: 'POST', url: '/odata/Orders', atomicityGroup: 'g1' },
            ],
          },
          responseStub,
          requestStub('application/json'),
        ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest && /Content-ID/i.test((err as Error).message ?? ''),
    );

    assert.equal(executed, 0);
    assert.equal(beginCount, 0);
  });

  it('continues executing independent JSON requests after a failure', async () => {
    const controller = createController({
      fail: { status: 422, body: { error: { code: 'Invalid' } } },
      ok: { status: 200, body: { value: [{ id: 1 }] } },
    });

    const result = (await controller.handleBatch(
      {
        requests: [
          { id: 'fail', method: 'POST', url: '/odata/Products' },
          { id: 'ok', method: 'GET', url: '/odata/Products' },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(result.responses.length, 2);
    const [first, second] = result.responses;
    assert.equal(first.id, 'fail');
    assert.equal(first.status, 422);
    assert.equal(second.id, 'ok');
    assert.equal(second.status, 200);
    assert.deepStrictEqual(second.body, { value: [{ id: 1 }] });
  });

  it('rejects JSON requests that exceed per-part size limit', async () => {
    const config: ODataConfig = {
      ...defaultConfig,
      batch: { ...defaultConfig.batch, maxPartBodyBytes: 32 },
    };
    const controller = createController({}, config);

    await assert.rejects(
      controller.handleBatch(
        {
          requests: [
            {
              id: 'big',
              method: 'POST',
              url: '/odata/Products',
              body: 'x'.repeat(64),
            },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) => err instanceof HttpErrors.PayloadTooLarge,
    );
  });

  it('rejects JSON batches when nesting depth exceeds maxDepth', async () => {
    const config: ODataConfig = {
      ...defaultConfig,
      batch: { ...defaultConfig.batch, maxDepth: 1 },
    };
    const controller = createController(
      {
        nested: { status: 200, body: { ok: true } },
      },
      config,
    );
    const req = requestStub('application/json');
    (req as any).headers = (req as any).headers ?? {};
    (req as any).headers['x-odata-batch-depth'] = 1;

    await assert.rejects(
      controller.handleBatch(
        {
          requests: [{ id: 'nested', method: 'GET', url: '/odata/Products' }],
        },
        responseStub,
        req as any,
      ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest && /nesting depth/i.test((err as Error).message ?? ''),
    );
  });

  it('reuses parent request user for JSON batch entries', async () => {
    const captured: unknown[] = [];
    const handler = {
      async handleRequest(_req: any, res: any) {
        captured.push((_req as any).user);
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      },
    };
    const controller = new ODataBatchController(
      handler as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );
    const parent = requestStub('application/json');
    (parent as any).user = { id: 'user-1' };

    await controller.handleBatch(
      {
        requests: [{ id: 'req-1', method: 'GET', url: '/odata/Products' }],
      },
      responseStub,
      parent as any,
    );

    assert.deepStrictEqual(captured, [{ id: 'user-1' }]);
  });

  it('propagates trusted proxy context to sub-requests', async () => {
    const observed: Array<{ protocol?: string; secure?: boolean; remote?: string }> = [];
    const handler = {
      async handleRequest(req: any, res: any) {
        observed.push({
          protocol: (req as any).protocol,
          secure: (req as any).secure,
          remote: (req as any)?.socket?.remoteAddress,
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      },
    };
    const controller = new ODataBatchController(
      handler as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      {
        ...defaultConfig,
        batch: { ...defaultConfig.batch },
        trustedProxySubnets: ['10.0.0.0/8'],
      },
    );
    const parent = requestStub('application/json', {
      headers: {
        forwarded: 'for=198.51.100.7;proto=https;host=api.example.com',
        'x-forwarded-proto': 'https',
      },
    }) as any;
    parent.protocol = 'http';
    parent.secure = false;
    parent.socket = { remoteAddress: '10.1.2.3' };

    await controller.handleBatch(
      {
        requests: [{ id: 'req-1', method: 'GET', url: '/odata/Products' }],
      },
      responseStub,
      parent,
    );

    assert.deepStrictEqual(observed, [{ protocol: 'https', secure: true, remote: '10.1.2.3' }]);
  });

  it('applies atomicity context when executing JSON changesets', async () => {
    const seenStates: unknown[] = [];
    const handler = {
      async handleRequest(req: any, res: any) {
        seenStates.push((req as any)[ODATA_ATOMICITY_STATE]);
        res.statusCode = 204;
        res.end();
      },
    };
    const controller = new ODataBatchController(
      handler as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );
    const atomicityState = { groupId: 'g1', getTransaction: () => undefined };
    (controller as any).createAtomicGroupContext = async () => ({
      id: 'g1',
      applyTo: (req: any) => {
        (req as any)[ODATA_ATOMICITY_STATE] = atomicityState;
      },
      clearFrom: (req: any) => {
        delete (req as any)[ODATA_ATOMICITY_STATE];
      },
      commit: async () => undefined,
      rollback: async () => undefined,
    });

    await controller.handleBatch(
      {
        requests: [
          {
            id: 'req-1',
            method: 'POST',
            url: '/odata/Products',
            atomicityGroup: 'g1',
          },
        ],
      },
      responseStub,
      requestStub('application/json'),
    );

    assert.equal(seenStates.length, 1);
    assert.deepStrictEqual(seenStates[0], atomicityState);
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
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'bad',
        method: 'GET',
        url: '',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 400);
    assert.equal((result.body as any)?.error?.code, 'InvalidUrl');
  });

  it('returns 400 when method is missing', async () => {
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'bad',
        method: undefined,
        url: '/odata/Products',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 400);
    assert.equal((result.body as any)?.error?.code, 'InvalidMethod');
  });

  it('rejects protocol-relative URLs inside batch requests', async () => {
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'ssrf',
        method: 'GET',
        url: '//169.254.169.254/latest/meta-data',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 400);
    assert.equal((result.body as any)?.error?.code, 'InvalidUrl');
  });

  it('rejects JSON batch requests that target paths outside the service root', async () => {
    let callCount = 0;
    const controller = new ODataBatchController(
      {
        handleRequest: async () => {
          callCount++;
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'forbidden',
        method: 'GET',
        url: '/internal/admin/reset',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 400);
    assert.equal((result.body as any)?.error?.code, 'InvalidUrl');
    assert.equal(callCount, 0);
  });

  it('rejects absolute URLs with hosts when they fall outside the service root', async () => {
    let callCount = 0;
    const controller = new ODataBatchController(
      {
        handleRequest: async () => {
          callCount++;
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'hosted',
        method: 'GET',
        url: 'https://example.com/internal/admin',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 400);
    assert.equal((result.body as any)?.error?.code, 'InvalidUrl');
    assert.equal(callCount, 0);
  });

  it('allows absolute URLs that remain inside the service root', async () => {
    let callCount = 0;
    const controller = new ODataBatchController(
      {
        handleRequest: async (_req: unknown, res: any) => {
          callCount++;
          res.statusCode = 204;
          res.end();
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'allowed',
        method: 'GET',
        url: 'https://example.com/odata/Products?$top=1',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 204);
    assert.equal(callCount, 1);
  });

  it('propagates HTTPS protocol info from the parent request to sub-requests', async () => {
    const observed: Array<{ protocol?: string; secure?: boolean; socketEncrypted?: boolean }> = [];
    const controller = new ODataBatchController(
      {
        handleRequest: async (req: any, res: any) => {
          observed.push({
            protocol: req.protocol,
            secure: req.secure,
            socketEncrypted: req.socket?.encrypted,
          });
          res.statusCode = 204;
          res.end();
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const tlsSocket = { encrypted: true };
    const parentRequest = requestStub('application/json', {
      protocol: 'https',
      secure: true,
      socket: tlsSocket,
      connection: tlsSocket,
    });

    const limits = (controller as any).getBatchLimits();
    await (controller as any).executeSingle(
      {
        id: 'secure-subrequest',
        method: 'GET',
        url: '/odata/Products',
      },
      undefined,
      parentRequest,
      limits,
    );

    assert.equal(observed.length, 1);
    assert.equal(observed[0].protocol, 'https');
    assert.equal(observed[0].secure, true);
    assert.equal(observed[0].socketEncrypted, true);
  });

  it('defaults sub-request protocol to http when parent is not secure', async () => {
    const observed: Array<{ protocol?: string; secure?: boolean; socketEncrypted?: boolean }> = [];
    const controller = new ODataBatchController(
      {
        handleRequest: async (req: any, res: any) => {
          observed.push({
            protocol: req.protocol,
            secure: req.secure,
            socketEncrypted: req.socket?.encrypted,
          });
          res.statusCode = 204;
          res.end();
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const parentRequest = requestStub('application/json', {
      protocol: 'http',
      secure: false,
      socket: { encrypted: false },
      connection: { encrypted: false },
    });

    const limits = (controller as any).getBatchLimits();
    await (controller as any).executeSingle(
      {
        id: 'insecure-subrequest',
        method: 'GET',
        url: '/odata/Products',
      },
      undefined,
      parentRequest,
      limits,
    );

    assert.equal(observed.length, 1);
    assert.equal(observed[0].protocol, 'http');
    assert.equal(observed[0].secure, false);
    assert.equal(observed[0].socketEncrypted, false);
  });

  it('does not follow redirects that point outside the service root', async () => {
    let callCount = 0;
    const controller = new ODataBatchController(
      {
        handleRequest: async (_req: unknown, res: any) => {
          callCount++;
          res.statusCode = 302;
          res.setHeader('Location', 'https://evil.example/loop');
          res.end();
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'redir',
        method: 'GET',
        url: '/odata/Redirect',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 302);
    assert.equal(callCount, 1);
  });

  it('follows same-origin redirects for GET requests', async () => {
    let callCount = 0;
    const controller = new ODataBatchController(
      {
        handleRequest: async (_req: unknown, res: any) => {
          callCount++;
          if (callCount === 1) {
            res.statusCode = 302;
            res.setHeader('Location', '/odata/next');
            res.end();
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end('{"value":42}');
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'redir',
        method: 'GET',
        url: '/odata/Redirect',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 200);
    assert.deepStrictEqual(result.body, { value: 42 });
    assert.equal(callCount, 2);
  });

  it('preserves binary payloads for standalone requests', async () => {
    const blob = Buffer.from([0x00, 0xff, 0x10]);
    let callCount = 0;
    const controller = new ODataBatchController(
      {
        handleRequest: async (_req: unknown, res: any) => {
          callCount++;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(blob);
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      {
        id: 'bin',
        method: 'GET',
        url: '/odata/Binary',
      },
      undefined,
      requestStub('multipart/mixed'),
      limits,
    );

    assert.equal(result.status, 200);
    assert.equal(Buffer.isBuffer(result.body), true);
    assert.equal((result.body as Buffer).equals(blob), true);
    assert.equal(callCount, 1);
  });

  it('preserves binary payloads returned via in-process handler', async () => {
    const blob = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const controller = new ODataBatchController(
      {
        handleRequest: async (_req: unknown, res: any) => {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(blob);
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      defaultConfig,
    );

    const contextStub = {
      applyTo: () => undefined,
      clearFrom: () => undefined,
    };

    const limits = (controller as any).getBatchLimits();

    const result = await (controller as any).executeWithHandler(
      {
        id: 'bin',
        method: 'GET',
        url: '/odata/Binary',
      },
      contextStub,
      requestStub('multipart/mixed'),
      limits,
    );

    assert.equal(result.status, 200);
    assert.equal(Buffer.isBuffer(result.body), true);
    assert.equal((result.body as Buffer).equals(blob), true);
  });

  it('rejects sub-responses that exceed the configured response size limit', async () => {
    const controller = new ODataBatchController(
      {
        handleRequest: async (_req: unknown, res: any) => {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(Buffer.alloc(128));
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      {
        ...defaultConfig,
        batch: { ...defaultConfig.batch, maxResponseBodyBytes: 64 },
      },
    );

    const limits = (controller as any).getBatchLimits();

    const result = await (controller as any).executeWithHandler(
      {
        id: 'overflow',
        method: 'GET',
        url: '/odata/Binary',
      },
      undefined,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 413);
    assert.equal((result.body as any)?.error?.code, 'ResponseTooLarge');
  });

  it('rejects JSON batches whose aggregate response size exceeds the configured payload limit', async () => {
    const controller = createController(
      {
        first: { status: 200, body: Buffer.alloc(1024) },
        second: { status: 200, body: Buffer.alloc(1024) },
      },
      {
        ...defaultConfig,
        batch: {
          ...defaultConfig.batch,
          maxResponsePayloadBytes: 1500,
        },
      },
    );

    await assert.rejects(
      controller.handleBatch(
        {
          requests: [
            { id: 'first', method: 'GET', url: '/odata/Products' },
            { id: 'second', method: 'GET', url: '/odata/Products' },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) => err instanceof HttpErrors.PayloadTooLarge,
    );
  });

  it('rejects multipart batches whose aggregate response size exceeds the configured payload limit', async () => {
    const controller = createController(
      {
        '1': { status: 200, body: Buffer.alloc(1024) },
        '2': { status: 200, body: Buffer.alloc(1024) },
      },
      {
        ...defaultConfig,
        batch: {
          ...defaultConfig.batch,
          maxResponsePayloadBytes: 2500,
        },
      },
    );

    const boundary = 'batch_multi_limit';
    const body = [
      `--${boundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 1',
      '',
      'GET /odata/Products HTTP/1.1',
      '',
      '',
      `--${boundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 2',
      '',
      'GET /odata/Products HTTP/1.1',
      '',
      '',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const stream = Readable.from(body);

    await assert.rejects(
      controller.handleBatch(
        stream as any,
        responseStub,
        requestStub('multipart/mixed', {
          headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
        }),
      ),
      (err: unknown) => err instanceof HttpErrors.PayloadTooLarge,
    );
  });

  it('rejects JSON changesets whose aggregate response size exceeds the configured payload limit', async () => {
    const config: ODataConfig = {
      ...defaultConfig,
      batch: { ...defaultConfig.batch, maxResponsePayloadBytes: 3000 },
    };
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => ({
          dataSource: {
            name: 'db',
            beginTransaction: async () => ({
              commit: async () => undefined,
              rollback: async () => undefined,
            }),
          },
        }),
      } as any,
      registry,
      noopLogger,
      config,
    );
    const stubs: StubResponseMap = {
      c1: { status: 200, body: Buffer.alloc(2048) },
      c2: { status: 200, body: Buffer.alloc(2048) },
    };
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

    await assert.rejects(
      controller.handleBatch(
        {
          requests: [
            { id: 'c1', method: 'POST', url: '/odata/Products', atomicityGroup: 'changeset-1' },
            { id: 'c2', method: 'POST', url: '/odata/Products', atomicityGroup: 'changeset-1' },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) => err instanceof HttpErrors.PayloadTooLarge,
    );
  });

  it('rejects multipart changesets whose aggregate response size exceeds the configured payload limit', async () => {
    const config: ODataConfig = {
      ...defaultConfig,
      batch: { ...defaultConfig.batch, maxResponsePayloadBytes: 4000 },
    };
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => ({
          dataSource: {
            name: 'db',
            beginTransaction: async () => ({
              commit: async () => undefined,
              rollback: async () => undefined,
            }),
          },
        }),
      } as any,
      registry,
      noopLogger,
      config,
    );
    const stubs: StubResponseMap = {
      '1': { status: 200, body: Buffer.alloc(2048) },
      '2': { status: 200, body: Buffer.alloc(2048) },
    };
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

    const boundary = 'batch_cs_limit';
    const changesetBoundary = 'changeset_cs_limit';
    const body = [
      `--${boundary}`,
      `Content-Type: multipart/mixed; boundary=${changesetBoundary}`,
      '',
      `--${changesetBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 1',
      '',
      'POST /odata/Products HTTP/1.1',
      '',
      '',
      `--${changesetBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 2',
      '',
      'POST /odata/Products HTTP/1.1',
      '',
      '',
      `--${changesetBoundary}--`,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const stream = Readable.from(body);

    await assert.rejects(
      controller.handleBatch(
        stream as any,
        responseStub,
        requestStub('multipart/mixed', {
          headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
        }),
      ),
      (err: unknown) => err instanceof HttpErrors.PayloadTooLarge,
    );
  });

  it('encodes binary responses when returning JSON batch payloads', async () => {
    const blob = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const controller = createController({
      bin: {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': blob.length.toString(),
          'content-transfer-encoding': 'binary',
          'CONTENT-ENCODING': 'gzip',
          'Transfer-Encoding': 'chunked',
          Connection: 'keep-alive',
          TE: 'trailers',
          trailer: 'Expires',
          'x-custom': 'keep-me',
        },
        body: blob,
      },
      txt: { status: 200, body: { value: 1 } },
    });

    const batchResult = (await controller.handleBatch(
      {
        requests: [
          { id: 'bin', method: 'GET', url: '/odata/Binary' },
          { id: 'txt', method: 'GET', url: '/odata/Text' },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(batchResult.responses.length, 2);
    const [binaryEntry, jsonEntry] = batchResult.responses;
    assert.equal(binaryEntry.id, 'bin');
    assert.equal(binaryEntry.status, 200);
    assert.deepStrictEqual(binaryEntry.headers, {
      'Content-Type': 'application/pdf',
      'Content-Transfer-Encoding': 'base64',
      'x-custom': 'keep-me',
    });
    assert.equal(typeof binaryEntry.body, 'string');
    assert.equal(binaryEntry.body, blob.toString('base64'));
    assert.equal(jsonEntry.id, 'txt');
    assert.deepStrictEqual(jsonEntry.body, { value: 1 });
  });

  it('defaults content type for binary responses when header is missing', async () => {
    const blob = Buffer.from([0xaa]);
    const controller = createController({
      bin: {
        status: 200,
        body: blob,
      },
    });

    const batchResult = (await controller.handleBatch(
      {
        requests: [{ id: 'bin', method: 'GET', url: '/odata/Binary' }],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(batchResult.responses.length, 1);
    const [binaryEntry] = batchResult.responses;
    assert.deepStrictEqual(binaryEntry.headers, {
      'Content-Type': 'application/octet-stream',
      'Content-Transfer-Encoding': 'base64',
    });
    assert.equal(binaryEntry.body, blob.toString('base64'));
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

  it('rejects atomicity groups when datasource lacks transaction support', async () => {
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
      createRequestContextStub(),
      { get: async () => ({ dataSource: { name: 'db' } }) } as any,
      registry,
      noopLogger,
      defaultConfig,
    );
    (controller as any).executeSingle = async (request: { id: string }) => ({
      id: request.id,
      status: 200,
      body: { ok: true },
    });

    const result = (await controller.handleBatch(
      {
        requests: [{ id: 'x', method: 'POST', url: '/odata/Products', atomicityGroup: 'no-tx' }],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(result.responses.length, 1);
    const response = result.responses[0];
    assert.equal(response.atomicityGroup, 'no-tx');
    assert.equal(response.status, 501);
    const error = (response.body as any)?.error;
    assert.equal(error?.code, 'BatchExecutionError');
    assert.match(error?.message ?? '', /cannot be executed/i);
  });

  it('rejects atomicity groups when entity set is marked non-transactional', async () => {
    let resolvedRepository = false;
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
      supportsTransactions: false,
      transactionCapabilityLocked: true,
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => {
          resolvedRepository = true;
          return { dataSource: { name: 'db' } };
        },
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );
    (controller as any).executeSingle = async (request: { id: string }) => ({
      id: request.id,
      status: 204,
    });

    const result = (await controller.handleBatch(
      {
        requests: [{ id: 'x', method: 'POST', url: '/odata/Products', atomicityGroup: 'locked' }],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(resolvedRepository, false);
    assert.equal(result.responses.length, 1);
    const response = result.responses[0];
    assert.equal(response.status, 501);
    assert.equal(response.atomicityGroup, 'locked');
    const error = (response.body as any)?.error;
    assert.equal(error?.code, 'BatchExecutionError');
    assert.match(error?.message ?? '', /cannot be executed/i);
  });

  it('locks entity sets after refresh confirms lack of transaction support', async () => {
    let repositoryResolutions = 0;
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
      supportsTransactions: false,
      transactionCapabilityLocked: false,
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => {
          repositoryResolutions++;
          return { dataSource: { name: 'mem' } };
        },
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );

    await assert.rejects(
      (controller as any).createAtomicGroupContext('g1', [
        { method: 'POST', url: '/odata/Products' },
      ]),
      (err: unknown) => err instanceof HttpErrors.NotImplemented,
    );
    assert.equal(def.supportsTransactions, false);
    assert.equal(def.transactionCapabilityLocked, true);
    assert.equal(repositoryResolutions, 1);

    await assert.rejects(
      (controller as any).createAtomicGroupContext('g2', [
        { method: 'POST', url: '/odata/Products' },
      ]),
      (err: unknown) => err instanceof HttpErrors.NotImplemented,
    );
    assert.equal(repositoryResolutions, 1);
  });

  it('propagates repository resolution errors when refresh fails', async () => {
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
      supportsTransactions: false,
      transactionCapabilityLocked: false,
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const failure = new Error('binding missing');
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => {
          throw failure;
        },
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );

    await assert.rejects(
      (controller as any).createAtomicGroupContext('g1', [
        { method: 'POST', url: '/odata/Products' },
      ]),
      (err: unknown) => err === failure,
    );

    assert.equal(def.transactionCapabilityLocked, false);
  });

  it('marks entity sets as transactional after successfully opening transactions', async () => {
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
      supportsTransactions: undefined,
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => ({
          dataSource: {
            name: 'pg',
            async beginTransaction() {
              return {
                commit: async () => undefined,
                rollback: async () => undefined,
              } as any;
            },
          },
        }),
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );

    const context = await (controller as any).createAtomicGroupContext('g1', [
      { method: 'POST', url: '/odata/Products' },
    ]);

    assert.equal(typeof context, 'object');
    assert.equal(def.supportsTransactions, true);
    await context.commit();
  });

  it('marks entity sets as non-transactional when beginTransaction is missing', async () => {
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
      supportsTransactions: undefined,
      transactionCapabilityLocked: undefined,
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => ({ dataSource: { name: 'mem' } }),
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );

    await assert.rejects(
      (controller as any).createAtomicGroupContext('g1', [
        { method: 'POST', url: '/odata/Products' },
      ]),
      (err: unknown) => err instanceof HttpErrors.NotImplemented,
    );
    assert.equal(def.supportsTransactions, false);
    assert.equal(def.transactionCapabilityLocked, true);
  });

  it('treats unknown probe results as non-transactional to avoid repeated refreshes', async () => {
    let repositoryResolutions = 0;
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
      supportsTransactions: false,
      transactionCapabilityLocked: false,
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => {
          repositoryResolutions++;
          return {
            dataSource: {
              name: 'dbc',
              beginTransaction: async () => {
                throw new Error('timeout');
              },
            },
          };
        },
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );

    await assert.rejects(
      (controller as any).createAtomicGroupContext('g1', [
        { method: 'POST', url: '/odata/Products' },
      ]),
      (err: unknown) => err instanceof Error && err.message === 'timeout',
    );

    assert.equal(def.supportsTransactions, false);
    assert.equal(def.transactionCapabilityLocked, true);
    assert.equal(repositoryResolutions, 1);

    await assert.rejects(
      (controller as any).createAtomicGroupContext('g2', [
        { method: 'POST', url: '/odata/Products' },
      ]),
      (err: unknown) => err instanceof HttpErrors.NotImplemented,
    );
    assert.equal(repositoryResolutions, 1);
  });

  it('marks entity sets as non-transactional when beginTransaction rejects as unsupported', async () => {
    const def = {
      name: 'Products',
      modelCtor: class {},
      repositoryBindingKey: 'repositories.Products',
      supportsTransactions: undefined,
    };
    const registry = {
      findByName: (name: string) => (name === 'Products' ? def : undefined),
    } as any;
    const controller = new ODataBatchController(
      { handleRequest: async () => undefined } as any,
      'http://localhost',
      createRequestContextStub(),
      {
        get: async () => ({
          dataSource: {
            name: 'mem',
            beginTransaction: async () => {
              throw new HttpErrors.NotImplemented('Transactions not supported');
            },
          },
        }),
      } as any,
      registry,
      noopLogger,
      defaultConfig,
    );

    await assert.rejects(
      (controller as any).createAtomicGroupContext('g1', [
        { method: 'POST', url: '/odata/Products' },
      ]),
      (err: unknown) => err instanceof HttpErrors.NotImplemented,
    );
    assert.equal(def.supportsTransactions, false);
  });

  it('rejects dependsOn references to later requests', async () => {
    const controller = createController({
      first: { status: 200 },
      second: { status: 200 },
    });

    await assert.rejects(
      controller.handleBatch(
        {
          requests: [
            { id: 'first', method: 'GET', url: '/odata/Products', dependsOn: ['second'] },
            { id: 'second', method: 'GET', url: '/odata/Products?$top=1' },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest &&
        /appears later in the payload/i.test(err.message ?? ''),
    );
  });

  it('throws when Content-ID references are unknown string tokens', () => {
    const controller = createController({});
    const contentIds = new Map<string, string>([['known-token', '/odata/Products(1)']]);
    assert.throws(
      () =>
        (controller as any).assertContentIdAvailability(
          {
            url: '$missing-token',
            headers: {},
            method: 'GET',
          },
          contentIds,
        ),
      (err: unknown) => err instanceof HttpErrors.BadRequest,
    );
  });

  it('throws 400 when a changeset contains an unknown Content-ID reference', async () => {
    const controller = createController({});

    await assert.rejects(
      () =>
        controller.handleBatch(
          {
            requests: [
              { id: 'a1', method: 'POST', url: '$missing-token', atomicityGroup: 'g1' },
              { id: 'a2', method: 'POST', url: '/odata/Products', atomicityGroup: 'g1' },
            ],
          },
          responseStub,
          requestStub('application/json'),
        ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest && /Content-ID/i.test((err as Error).message ?? ''),
    );
  });

  it('allows dollar-prefixed literals and query options without Content-ID references', async () => {
    const controller = createController({
      list: { status: 200, body: { value: [] } },
    });

    await assert.doesNotReject(() =>
      controller.handleBatch(
        {
          requests: [
            {
              id: 'list',
              method: 'GET',
              url: "/odata/Products('SKU$001')?$filter=contains(description,'$100')&$expand=Categories($levels=2)",
            },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
    );
  });

  it('ignores substrings in headers and non-metadata body fields', () => {
    const controller = createController({});
    const contentIds = new Map<string, string>([['known', '/odata/Products(1)']]);

    assert.doesNotThrow(() =>
      (controller as any).assertContentIdAvailability(
        {
          url: '/odata/Products',
          method: 'GET',
          headers: {
            Authorization: 'Bearer $known',
          },
          body: {
            description: 'Costs $100',
          },
        },
        contentIds,
      ),
    );
  });

  it('allows metadata literals containing dollar signs', () => {
    const controller = createController({});
    assert.doesNotThrow(() =>
      (controller as any).assertContentIdAvailability(
        {
          url: '/odata/Products',
          method: 'PATCH',
          body: {
            '@odata.id': "/odata/Products('SKU$001')",
          },
        },
        new Map(),
      ),
    );
  });

  it('rejects placeholder references even when content ID map is empty', () => {
    const controller = createController({});

    assert.throws(
      () =>
        (controller as any).assertContentIdAvailability(
          {
            url: '/odata/Products',
            method: 'GET',
            headers: {
              'If-Match': '"$missing"',
            },
            body: {
              '@odata.id': "'$missing'",
            },
          },
          new Map(),
        ),
      (err: unknown) => err instanceof HttpErrors.BadRequest,
    );
  });

  it('resolves quoted placeholders and preserves wrappers when present', () => {
    const controller = createController({});
    const request = {
      method: 'PATCH',
      id: 'update',
      url: '"$parent"',
      headers: {
        Location: "'$REQUESTS(parent)'",
        Authorization: 'Bearer $parent',
      },
      body: {
        '@odata.id': '"$parent"',
        link: {
          '@odata.bind': '\'$REQUESTS("parent")\'',
        },
      },
    };
    const contentIds = new Map<string, string>([
      ['parent', '/odata/Products(1)'],
      ['requests(parent)', '/odata/Products(1)'],
      ['requests("parent")', '/odata/Products(1)'],
    ]);

    const result = (controller as any).applyContentIdReferences(request, contentIds);
    assert.equal(result.url, '"/odata/Products(1)"');
    assert.equal(result.headers?.Location, "'/odata/Products(1)'");
    assert.equal(result.headers?.Authorization, 'Bearer $parent');
    const body = result.body as Record<string, any>;
    assert.equal(body?.['@odata.id'], '"/odata/Products(1)"');
    assert.equal(body?.link?.['@odata.bind'], "'/odata/Products(1)'");
  });

  it('resolves case-insensitive content-id placeholders', () => {
    const controller = createController({});
    const request = {
      method: 'PATCH',
      id: 'update',
      url: '$PARENT',
      headers: {
        Location: '$REQUESTS("PARENT")',
        'If-Match': '$Requests(parent)',
      },
      body: {
        '@odata.id': '$parent',
      },
    };
    const contentIds = new Map<string, string>([
      ['parent', '/odata/Products(1)'],
      ['requests(parent)', '/odata/Products(1)'],
      ['requests("parent")', '/odata/Products(1)'],
    ]);

    const result = (controller as any).applyContentIdReferences(request, contentIds);
    assert.equal(result.url, '/odata/Products(1)');
    assert.equal(result.headers?.Location, '/odata/Products(1)');
    assert.equal(result.headers?.['If-Match'], '/odata/Products(1)');
    const body = result.body as Record<string, any>;
    assert.equal(body?.['@odata.id'], '/odata/Products(1)');
  });

  it('supports escaped quote placeholders', () => {
    const controller = createController({});
    const request = {
      method: 'PATCH',
      id: 'update',
      url: '\\"$parent\\"',
      headers: {
        ETag: "\\'$parent\\'",
      },
      body: {
        '@odata.id': '\\"$parent\\"',
      },
    };
    const contentIds = new Map<string, string>([['parent', '/odata/Products(1)']]);

    const result = (controller as any).applyContentIdReferences(request, contentIds);
    assert.equal(result.url, '\\"/odata/Products(1)\\"');
    assert.equal(result.headers?.ETag, "\\'/odata/Products(1)\\'");
    const body = result.body as Record<string, any>;
    assert.equal(body?.['@odata.id'], '\\"/odata/Products(1)\\"');
  });

  it('injects If-Match for relative JSON batch requests when ETags are known', () => {
    const controller = createController({});
    const request: any = {
      method: 'PATCH',
      url: 'Products(1)',
    };
    const etags = new Map<string, string>([['/odata/Products(1)', 'W/"etag"']]);

    (controller as any).ensureEtagPreconditions(request, etags);

    assert.equal(request.headers?.['If-Match'], 'W/"etag"');
  });

  it('does not mutate original request when substitution fails', () => {
    const controller = createController({});
    const request = {
      method: 'PATCH',
      id: 'update',
      url: '$missing',
      headers: {
        Location: '$missing',
      },
    };

    assert.throws(
      () => (controller as any).applyContentIdReferences(request, new Map()),
      (err: unknown) => err instanceof HttpErrors.BadRequest,
    );
    assert.equal(request.url, '$missing');
    assert.equal(request.headers?.Location, '$missing');
  });

  it('replaces only whole-value placeholders in urls, headers, and metadata fields', () => {
    const controller = createController({});
    const request = {
      method: 'PATCH',
      id: 'update',
      url: '$parent',
      headers: {
        Location: '$REQUESTS(parent)',
        Authorization: 'Bearer $parent',
      },
      body: {
        '@odata.id': '$parent',
        link: {
          '@odata.bind': '$REQUESTS("parent")',
        },
      },
    };
    const contentIds = new Map<string, string>([
      ['parent', '/odata/Products(1)'],
      ['requests(parent)', '/odata/Products(1)'],
      ['requests("parent")', '/odata/Products(1)'],
    ]);

    const result = (controller as any).applyContentIdReferences(request, contentIds);

    assert.equal(result.url, '/odata/Products(1)');
    assert.equal(result.headers?.Location, '/odata/Products(1)');
    assert.equal(result.headers?.Authorization, 'Bearer $parent');
    const body = result.body as Record<string, any>;
    assert.equal(body?.['@odata.id'], '/odata/Products(1)');
    assert.equal(body?.link?.['@odata.bind'], '/odata/Products(1)');
  });

  it('substitutes Content-ID references for navigation property creates', async () => {
    const registry = new EntitySetRegistry();
    registry.register({ name: 'Orders', modelCtor: Order } as any);
    registry.register({ name: 'OrderItems', modelCtor: OrderItem } as any);
    const executedUrls: Record<string, string> = {};
    const controller = createControllerWithRegistry(
      {
        'nav-create': { status: 200, body: { id: 99, orderId: 1, productId: 1 } },
        'nav-fetch': { status: 200, body: { id: 99 } },
      },
      registry,
      executedUrls,
    );

    const result = (await controller.handleBatch(
      {
        requests: [
          { id: 'nav-create', method: 'POST', url: '/odata/Orders(1)/items' },
          {
            id: 'nav-fetch',
            method: 'GET',
            url: '$nav-create',
            dependsOn: ['nav-create'],
          },
        ],
      },
      responseStub,
      requestStub('application/json'),
    )) as BatchResponsePayload;

    assert.equal(result.responses.length, 2);
    assert.equal(executedUrls['nav-fetch'], '/odata/OrderItems(99)');
  });

  it('rejects interleaved atomicity groups to preserve submission order', async () => {
    const controller = createController({
      a: { status: 200, body: { id: 'a' } },
      b: { status: 200, body: { id: 'b' } },
      c: { status: 200, body: { id: 'c' } },
    });
    await assert.rejects(
      controller.handleBatch(
        {
          requests: [
            { id: 'a', method: 'POST', url: '/odata/Products', atomicityGroup: 'set-1' },
            { id: 'b', method: 'GET', url: '/odata/Products?$top=1' },
            { id: 'c', method: 'PATCH', url: '/odata/Products(1)', atomicityGroup: 'set-1' },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest && /contiguous/i.test((err as Error).message ?? ''),
    );
  });

  it('rejects read operations inside atomicity groups', async () => {
    const controller = createController({});
    await assert.rejects(
      controller.handleBatch(
        {
          requests: [
            { id: 'a', method: 'POST', url: '/odata/Products', atomicityGroup: 'set-1' },
            { id: 'b', method: 'GET', url: '/odata/Products', atomicityGroup: 'set-1' },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest &&
        /unsupported get/i.test((err as Error).message ?? ''),
    );
  });

  it('prevents overriding sensitive headers in sub-requests', () => {
    const controller = createController({});
    const parent = requestStub('application/json', {
      headers: {
        Authorization: 'Bearer parent',
        'X-Tenant-Id': 'tenant-a',
      },
    });
    const subHeaders = (controller as any).buildHeadersForRequest(
      {
        id: 'r1',
        method: 'GET',
        url: '/odata/Products',
        headers: {
          Authorization: 'Bearer attacker',
          'X-Tenant-Id': 'tenant-b',
          Prefer: 'return=minimal',
        },
      },
      parent,
    );

    assert.equal(subHeaders.authorization, 'Bearer parent');
    assert.equal(subHeaders['x-tenant-id'], 'tenant-a');
    assert.equal(subHeaders.prefer, 'return=minimal');
  });

  it('ignores injection of new sensitive headers when parent is missing them', () => {
    const controller = createController({});
    const parent = requestStub('application/json');
    const headers = (controller as any).buildHeadersForRequest(
      {
        id: 'r1',
        method: 'GET',
        url: '/odata/Products',
        headers: {
          Authorization: 'Bearer attacker',
          'X-Forwarded-For': '10.0.0.1',
          Prefer: 'return=representation',
        },
      },
      parent,
    );

    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-forwarded-for'], undefined);
    assert.equal(headers.prefer, 'return=representation');
  });

  it('allows overriding safe content negotiation headers per sub-request', () => {
    const controller = createController({});
    const parent = requestStub('application/json', {
      headers: {
        Accept: 'application/json',
        Prefer: 'return=representation',
      },
    });
    const headers = (controller as any).buildHeadersForRequest(
      {
        id: 'r1',
        method: 'POST',
        url: '/odata/Products',
        headers: {
          Accept: 'text/plain',
          Prefer: 'return=minimal',
          'Content-Type': 'application/json;odata.metadata=minimal',
        },
      },
      parent,
    );

    assert.equal(headers.accept, 'text/plain');
    assert.equal(headers.prefer, 'return=minimal');
    assert.equal(headers['content-type'], 'application/json;odata.metadata=minimal');
  });

  it('aborts sub-requests that exceed the configured timeout and clears context afterwards', async () => {
    let clearCalled = false;
    let handlerResolve: (() => void) | undefined;
    const controller = new ODataBatchController(
      {
        async handleRequest() {
          await new Promise<void>((resolve) => {
            handlerResolve = resolve;
          });
        },
      } as any,
      'http://localhost',
      createRequestContextStub(),
      { get: async () => undefined } as any,
      { findByName: () => undefined } as any,
      noopLogger,
      {
        ...defaultConfig,
        batch: { ...defaultConfig.batch, subRequestTimeoutMs: 10 },
      },
    );

    const context = {
      applyTo: () => undefined,
      clearFrom: () => {
        clearCalled = true;
      },
    } as any;

    const limits = (controller as any).getBatchLimits();
    const result = await (controller as any).executeSingle(
      { id: 'timeout', method: 'GET', url: '/odata/Products' },
      context,
      requestStub('application/json'),
      limits,
    );

    assert.equal(result.status, 504);
    assert.equal((result.body as any)?.error?.code, 'BatchSubRequestTimeout');
    assert.equal(clearCalled, false);

    handlerResolve?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clearCalled, true);
  });

  it('rejects sub-request ids containing control characters', async () => {
    const controller = createController({});
    await assert.rejects(
      controller.handleBatch(
        {
          requests: [{ id: 'req\r\nInjected: 1', method: 'GET', url: '/odata/Products' }],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest &&
        /request id contains invalid characters/i.test((err as Error).message),
    );
  });

  it('rejects atomicity groups containing invalid characters', async () => {
    const controller = createController({});
    await assert.rejects(
      controller.handleBatch(
        {
          requests: [
            {
              id: 'a',
              method: 'POST',
              url: '/odata/Products',
              atomicityGroup: 'set-1\r\nInjected: 1',
            },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest &&
        /atomicitygroup contains invalid characters/i.test((err as Error).message),
    );
  });

  it('rejects duplicate ids after sanitization', async () => {
    const controller = createController({});
    await assert.rejects(
      controller.handleBatch(
        {
          requests: [
            { id: 'req', method: 'GET', url: '/odata/Products' },
            { id: ' req ', method: 'GET', url: '/odata/Products/$count' },
          ],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest &&
        /duplicate request id/i.test((err as Error).message),
    );
  });

  it('rejects non-array dependsOn payloads before sanitization', async () => {
    const controller = createController({});
    await assert.rejects(
      controller.handleBatch(
        {
          requests: [{ id: 'a', method: 'POST', url: '/odata/Products', dependsOn: 'root' as any }],
        },
        responseStub,
        requestStub('application/json'),
      ),
      (err: unknown) =>
        err instanceof HttpErrors.BadRequest &&
        /dependsOn must be an array/i.test((err as Error).message),
    );
  });
});

/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { RequestLoggingProvider } from '../../middleware/request-logging.provider';
import { ODataLogger } from '../../keys';

const noopLogger: ODataLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('request logging provider', () => {
  it('masks nested object properties referenced by dot paths', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    const body = { user: { password: 'secret', name: 'Ada' } };
    const masked = (provider as any).maskRequestBody(body, ['user.password']);

    assert.equal(masked.user.password, '***');
    assert.equal(masked.user.name, 'Ada');
    assert.equal(body.user.password, 'secret');
  });

  it('masks nested array paths using bracket notation', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    const body = {
      users: [
        { id: 1, token: 'abc' },
        { id: 2, token: 'def' },
      ],
    };
    const masked = (provider as any).maskRequestBody(body, ['users[0].token', 'users[1].token']);

    assert.equal(masked.users[0].token, '***');
    assert.equal(masked.users[1].token, '***');
    assert.equal(body.users[0].token, 'abc');
  });

  it('supports mixed dot/bracket paths for deeply nested values', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    const body = {
      orders: [
        {
          payments: [
            { cardNumber: '1111', status: 'ok' },
            { cardNumber: '2222', status: 'ok' },
          ],
        },
      ],
    };

    const masked = (provider as any).maskRequestBody(body, ['orders[0].payments[1].cardNumber']);

    assert.equal(masked.orders[0].payments[1].cardNumber, '***');
    assert.equal(masked.orders[0].payments[0].cardNumber, '1111');
  });

  it('ignores request-log preference unless allowClientOverride is enabled', () => {
    const provider = new RequestLoggingProvider(
      {
        basePath: '/odata',
        telemetry: {
          requestLogging: {
            enabled: false,
            allowClientOverride: false,
          },
        },
      } as any,
      noopLogger,
    );

    const state: any = { telemetryPreferences: new Set(['request-log']) };
    const resolved = (provider as any).resolveRequestLoggingConfig(state, undefined);
    assert.equal(resolved, undefined);

    const overrideProvider = new RequestLoggingProvider(
      {
        basePath: '/odata',
        telemetry: {
          requestLogging: {
            allowClientOverride: true,
          },
        },
      } as any,
      noopLogger,
    );
    const overrideResolved = (overrideProvider as any).resolveRequestLoggingConfig(
      state,
      undefined,
    );
    assert.equal(overrideResolved?.enabled, true);
  });

  it('truncates large request bodies before cloning or masking', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    const payload = { data: 'x'.repeat(5000) };
    const capture = (provider as any).captureRequestBody(payload, { maxPayloadBytes: 128 });
    assert.equal(capture?.truncated, true);
    assert.ok(typeof capture?.body === 'object');
    assert.equal(payload.data.length, 5000);
  });

  it('skips property getters when capturing request bodies', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    let getterCalls = 0;
    const payload: Record<string, unknown> = {};

    Object.defineProperty(payload, 'secret', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('getter must not run');
      },
    });

    const capture = (provider as any).captureRequestBody(payload, { maxPayloadBytes: 2048 });
    assert.equal(getterCalls, 0);
    assert.equal(capture?.truncated, true);
    assert.equal(capture?.body?.secret, '[Getter]');
  });

  it('skips array entry getters when cloning payloads', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    let getterCalls = 0;
    const records: any[] = [1, 2, 3];
    Object.defineProperty(records, '1', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('array getter must not run');
      },
    });

    const payload = { records };
    const capture = (provider as any).captureRequestBody(payload, { maxPayloadBytes: 2048 });
    assert.equal(getterCalls, 0);
    assert.equal(capture?.truncated, true);
    assert.ok(Array.isArray(capture?.body?.records));
    assert.equal(capture?.body?.records?.[1], '[Getter]');
  });

  it('clones masked bodies without invoking getters', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    let getterCalls = 0;
    const body: Record<string, unknown> = {};
    Object.defineProperty(body, 'password', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('getter must not run');
      },
    });

    const masked = (provider as any).maskRequestBody(body, [], true);
    assert.equal(getterCalls, 0);
    assert.equal(masked.password, '[Getter]');
  });

  it('caps cloned container entries to avoid deep traversal', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    const limit = RequestLoggingProvider.MAX_CONTAINER_ENTRIES;
    const payload: Record<string, string> = {};
    for (let i = 0; i < limit + 50; i += 1) {
      payload[`prop-${i}`] = `value-${i}`;
    }
    const capture = (provider as any).captureRequestBody(payload, {
      maxPayloadBytes: 1024 * 1024,
    });
    const cloned = (capture?.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(cloned);

    assert.equal(capture?.truncated, true);
    assert.equal(keys.length, limit);
    assert.equal(keys[0], 'prop-0');
    assert.equal(keys[keys.length - 1], `prop-${limit - 1}`);
  });

  it('stops evaluating properties once the entry cap is reached', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    const limit = RequestLoggingProvider.MAX_CONTAINER_ENTRIES;
    const payload: Record<string, unknown> = {};
    let readCount = 0;

    for (let i = 0; i < limit * 5; i += 1) {
      const index = i;
      Object.defineProperty(payload, `prop-${index}`, {
        configurable: true,
        enumerable: true,
        get: () => {
          readCount += 1;
          return `value-${index}`;
        },
      });
    }

    const capture = (provider as any).captureRequestBody(payload, { maxPayloadBytes: 1024 * 1024 });
    assert.ok(readCount <= limit);
    assert.equal(capture?.truncated, true);
  });

  it('limits nested JSON bodies by depth and flags truncation', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    const payload: any = { value: 'root' };
    let builder = payload;
    for (let i = 0; i < 10; i++) {
      builder.next = { value: `level-${i}` };
      builder = builder.next;
    }
    const capture = (provider as any).captureRequestBody(payload, { maxPayloadBytes: 4096 });
    assert.equal(capture?.truncated, true);
    const bodyString = JSON.stringify(capture?.body);
    assert.ok(bodyString.includes('[MaxDepth]'));
  });

  it('captures partial response bodies without exhausting memory', () => {
    const provider = new RequestLoggingProvider({ basePath: '/odata' } as any, noopLogger);
    const payload = {
      records: Array.from({ length: 1000 }).map((_, i) => ({ id: i, name: 'x'.repeat(50) })),
    };
    const capture = (provider as any).captureResponseBody(payload, 512);
    assert.equal(capture?.truncated, true);
    assert.ok(Array.isArray(capture?.body?.records));
  });
});

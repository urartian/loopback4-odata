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

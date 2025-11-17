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
});

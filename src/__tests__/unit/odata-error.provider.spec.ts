import { strict as assert } from 'assert';
import { HttpErrors } from '@loopback/rest';
import { ODataErrorProvider } from '../../providers/odata-error.provider';
import { ODataErrorCodes } from '../../odata-error-codes';

describe('ODataErrorProvider', () => {
  const responseFactory = () => {
    let statusCode: number | undefined;
    let payload: any;
    let contentType: string | undefined;
    const headers = new Map<string, string>();
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      set(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      contentType(value: string) {
        contentType = value;
        return this;
      },
      send(body: unknown) {
        payload = body;
        return this;
      },
      end(body?: unknown) {
        if (body !== undefined) {
          if (typeof body === 'string') {
            try {
              payload = JSON.parse(body);
            } catch {
              payload = body;
            }
          } else {
            payload = body;
          }
        }
        return this;
      },
    } as any;
    Object.defineProperty(response, 'statusCode', {
      get() {
        return statusCode;
      },
      set(value: number) {
        statusCode = value;
      },
      enumerable: true,
      configurable: true,
    });
    return {
      response,
      statusCode: () => statusCode,
      payload: () => payload,
      contentType: () => contentType,
      headers,
    };
  };

  it('preserves MultiDataSourceChangesetNotSupported error codes', () => {
    const provider = new ODataErrorProvider({ debug: false }, {
      tokenSecret: 'test-secret',
      basePath: '/odata',
    } as any);
    const reject = provider.value();

    let statusCode: number | undefined;
    let payload: any;
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      getHeader() {
        return undefined;
      },
      set() {
        return this;
      },
      contentType() {
        return this;
      },
      send(body: unknown) {
        payload = body;
        return this;
      },
    } as any;

    const request = { url: '/odata/Products', method: 'POST' } as any;
    const err = new HttpErrors.NotImplemented('cross-ds');
    (err as any).code = ODataErrorCodes.MultiDataSourceChangesetNotSupported;

    reject({ request, response } as any, err);

    assert.equal(statusCode, 501);
    assert.equal(payload?.error?.code, ODataErrorCodes.MultiDataSourceChangesetNotSupported);
  });

  it('preserves lambda rejection reason codes', () => {
    const provider = new ODataErrorProvider({ debug: false }, {
      tokenSecret: 'test-secret',
      basePath: '/odata',
    } as any);
    const reject = provider.value();

    let statusCode: number | undefined;
    let payload: any;
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      getHeader() {
        return undefined;
      },
      set() {
        return this;
      },
      contentType() {
        return this;
      },
      send(body: unknown) {
        payload = body;
        return this;
      },
    } as any;

    const request = { url: '/odata/Products', method: 'GET' } as any;
    const err = new HttpErrors.BadRequest('bad lambda');
    (err as any).code = ODataErrorCodes.NestedLambdaDepthExceeded;

    reject({ request, response } as any, err);

    assert.equal(statusCode, 400);
    assert.equal(payload?.error?.code, ODataErrorCodes.NestedLambdaDepthExceeded);
  });

  it('does not expose unknown err.code as error.code (copies to innererror.dbCode)', () => {
    const provider = new ODataErrorProvider({ debug: false }, {
      tokenSecret: 'test-secret',
      basePath: '/odata',
    } as any);
    const reject = provider.value();

    {
      const { response, statusCode, payload } = responseFactory();
      const request = { url: '/odata/Products', method: 'GET' } as any;
      const err = new HttpErrors.BadRequest('bad');
      (err as any).code = 'custom.badrequest';
      reject({ request, response } as any, err);
      assert.equal(statusCode(), 400);
      assert.equal(payload()?.error?.code, ODataErrorCodes.BadRequest);
      assert.equal(payload()?.error?.innererror?.dbCode, 'custom.badrequest');
    }

    {
      const { response, statusCode, payload } = responseFactory();
      const request = { url: '/odata/Products(1)', method: 'PATCH' } as any;
      const err = new HttpErrors.Conflict('conflict');
      (err as any).code = 'custom.conflict';
      reject({ request, response } as any, err);
      assert.equal(statusCode(), 409);
      assert.equal(payload()?.error?.code, ODataErrorCodes.Conflict);
      assert.equal(payload()?.error?.innererror?.dbCode, 'custom.conflict');
    }

    {
      const { response, statusCode, payload } = responseFactory();
      const request = { url: '/odata/Products(1)', method: 'PATCH' } as any;
      const err = new HttpErrors.InternalServerError('boom');
      (err as any).code = 'custom.internal';
      reject({ request, response } as any, err);
      assert.equal(statusCode(), 500);
      assert.equal(payload()?.error?.code, ODataErrorCodes.InternalServerError);
      assert.equal(payload()?.error?.innererror?.dbCode, 'custom.internal');
    }

    {
      const { response, statusCode, payload } = responseFactory();
      const request = { url: '/odata/$batch', method: 'POST' } as any;
      const err = new HttpErrors.NotImplemented('nope');
      (err as any).code = 'custom.notimplemented';
      reject({ request, response } as any, err);
      assert.equal(statusCode(), 501);
      assert.equal(payload()?.error?.code, ODataErrorCodes.NotImplemented);
      assert.equal(payload()?.error?.innererror?.dbCode, 'custom.notimplemented');
    }
  });

  it('does not collapse TransactionCommitFailed', () => {
    const provider = new ODataErrorProvider({ debug: false }, {
      tokenSecret: 'test-secret',
      basePath: '/odata',
    } as any);
    const reject = provider.value();

    let statusCode: number | undefined;
    let payload: any;
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      getHeader() {
        return undefined;
      },
      set() {
        return this;
      },
      contentType() {
        return this;
      },
      send(body: unknown) {
        payload = body;
        return this;
      },
    } as any;

    const request = { url: '/odata/Products', method: 'POST' } as any;
    const err = new HttpErrors.InternalServerError('commit failed');
    (err as any).code = ODataErrorCodes.TransactionCommitFailed;

    reject({ request, response } as any, err);

    assert.equal(statusCode, 500);
    assert.equal(payload?.error?.code, ODataErrorCodes.TransactionCommitFailed);
  });

  it('maps additional HTTP statuses to stable OData codes', () => {
    const provider = new ODataErrorProvider({ debug: false }, {
      tokenSecret: 'test-secret',
      basePath: '/odata',
    } as any);
    const reject = provider.value();

    {
      const { response, statusCode, payload } = responseFactory();
      reject(
        { request: { url: '/odata/Products', method: 'GET' }, response } as any,
        new HttpErrors.Gone('expired'),
      );
      assert.equal(statusCode(), 410);
      assert.equal(payload()?.error?.code, ODataErrorCodes.Gone);
    }

    {
      const { response, statusCode, payload } = responseFactory();
      reject(
        { request: { url: '/odata/Products', method: 'GET' }, response } as any,
        new HttpErrors.TooManyRequests('rate exceeded'),
      );
      assert.equal(statusCode(), 429);
      assert.equal(payload()?.error?.code, ODataErrorCodes.TooManyRequests);
    }

    {
      const { response, statusCode, payload } = responseFactory();
      reject(
        { request: { url: '/odata/Products', method: 'GET' }, response } as any,
        new HttpErrors.ServiceUnavailable('temporarily saturated'),
      );
      assert.equal(statusCode(), 503);
      assert.equal(payload()?.error?.code, ODataErrorCodes.ServiceUnavailable);
    }
  });

  it('preserves target, details, and explicit innerError metadata', () => {
    const provider = new ODataErrorProvider({ debug: false }, {
      tokenSecret: 'test-secret',
      basePath: '/odata',
    } as any);
    const reject = provider.value();

    let payload: any;
    const response = {
      status() {
        return this;
      },
      getHeader() {
        return undefined;
      },
      set() {
        return this;
      },
      contentType() {
        return this;
      },
      send(body: unknown) {
        payload = body;
        return this;
      },
    } as any;

    const err = new HttpErrors.BadRequest('invalid filter');
    (err as any).code = ODataErrorCodes.BadRequest;
    (err as any).target = '$filter';
    (err as any).details = [{ code: 'type', target: 'price' }];
    (err as any).innerError = { traceId: 'abc123' };

    reject({ request: { url: '/odata/Products', method: 'GET' }, response } as any, err);

    assert.deepStrictEqual(payload?.error, {
      code: ODataErrorCodes.BadRequest,
      message: 'invalid filter',
      target: '$filter',
      details: [{ code: 'type', target: 'price' }],
      innererror: { traceId: 'abc123' },
    });
  });

  it('redacts auto-derived database constraint details unless debug is enabled', () => {
    {
      const provider = new ODataErrorProvider({ debug: false }, {
        tokenSecret: 'test-secret',
        basePath: '/odata',
      } as any);
      const reject = provider.value();
      const { response, statusCode, payload } = responseFactory();

      const err = Object.assign(new Error('violates foreign key'), {
        code: '23503',
        constraint: 'orders_product_id_fkey',
        table: 'orders',
        detail: 'Key (product_id)=(1) is still referenced.',
      });

      reject({ request: { url: '/odata/Products(1)', method: 'DELETE' }, response } as any, err);

      assert.equal(statusCode(), 409);
      assert.equal(payload()?.error?.code, ODataErrorCodes.Conflict);
      assert.deepStrictEqual(payload()?.error?.innererror, { dbCode: '23503' });
    }

    {
      const provider = new ODataErrorProvider({ debug: true }, {
        tokenSecret: 'test-secret',
        basePath: '/odata',
      } as any);
      const reject = provider.value();
      const { response, statusCode, payload } = responseFactory();

      const err = Object.assign(new Error('violates foreign key'), {
        code: '23503',
        constraint: 'orders_product_id_fkey',
        table: 'orders',
        detail: 'Key (product_id)=(1) is still referenced.',
      });

      reject({ request: { url: '/odata/Products(1)', method: 'DELETE' }, response } as any, err);

      assert.equal(statusCode(), 409);
      assert.equal(payload()?.error?.code, ODataErrorCodes.Conflict);
      assert.equal(payload()?.error?.innererror?.dbCode, '23503');
      assert.equal(payload()?.error?.innererror?.constraint, 'orders_product_id_fkey');
      assert.equal(payload()?.error?.innererror?.table, 'orders');
      assert.equal(
        payload()?.error?.innererror?.detail,
        'Key (product_id)=(1) is still referenced.',
      );
    }
  });

  it('falls back to the strong-error-handler for non-OData requests', () => {
    const provider = new ODataErrorProvider({ debug: false }, {
      tokenSecret: 'test-secret',
      basePath: '/api/odata',
    } as any);
    const reject = provider.value();
    const { response, statusCode, payload } = responseFactory();
    const err = new HttpErrors.BadRequest('plain rest');

    reject(
      {
        request: { url: '/openapi.json', method: 'GET', headers: { accept: 'application/json' } },
        response,
      } as any,
      err,
    );

    assert.equal(statusCode(), 400);
    assert.equal(payload()?.error?.message, 'plain rest');
    assert.equal(payload()?.error?.statusCode, 400);
  });

  it('reuses an existing OData-Version header and emits json content type', () => {
    const provider = new ODataErrorProvider({ debug: false }, {
      tokenSecret: 'test-secret',
      basePath: '/odata',
    } as any);
    const reject = provider.value();
    const { response, headers, contentType, payload } = responseFactory();
    headers.set('odata-version', '4.0');

    reject(
      { request: { url: '/odata/Products', method: 'GET' }, response } as any,
      new HttpErrors.BadRequest('bad request'),
    );

    assert.equal(headers.get('odata-version'), '4.0');
    assert.equal(contentType(), 'application/json; charset=utf-8');
    assert.equal(payload()?.error?.code, ODataErrorCodes.BadRequest);
  });
});

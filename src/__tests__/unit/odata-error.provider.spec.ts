import { strict as assert } from 'assert';
import { HttpErrors } from '@loopback/rest';
import { ODataErrorProvider } from '../../providers/odata-error.provider';
import { ODataErrorCodes } from '../../odata-error-codes';

describe('ODataErrorProvider', () => {
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

    const responseFactory = () => {
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
      return { response, statusCode: () => statusCode, payload: () => payload };
    };

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
});

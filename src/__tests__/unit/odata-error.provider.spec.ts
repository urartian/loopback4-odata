import { strict as assert } from 'assert';
import { HttpErrors } from '@loopback/rest';
import { ODataErrorProvider } from '../../providers/odata-error.provider';

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
    (err as any).code = 'MultiDataSourceChangesetNotSupported';

    reject({ request, response } as any, err);

    assert.equal(statusCode, 501);
    assert.equal(payload?.error?.code, 'MultiDataSourceChangesetNotSupported');
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
    (err as any).code = 'nested-lambda-depth-exceeded';

    reject({ request, response } as any, err);

    assert.equal(statusCode, 400);
    assert.equal(payload?.error?.code, 'nested-lambda-depth-exceeded');
  });
});

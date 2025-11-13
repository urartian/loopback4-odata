/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { OdataPathRewriterProvider } from '../../middleware/odata-path-rewriter.provider';
import { ODataRequestContextProvider } from '../../middleware/odata-request-context.provider';
import { RequestLoggingProvider } from '../../middleware/request-logging.provider';
import { ODataLogger } from '../../keys';
import { MiddlewareContext } from '@loopback/rest';

const noopLogger: ODataLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('root basePath middleware handling', () => {
  it('rewrites root-mounted requests to /odata paths', async () => {
    const provider = new OdataPathRewriterProvider({ basePath: '/' } as any, noopLogger);
    const middleware = provider.value();
    const ctx: MiddlewareContext = {
      request: { url: '/Products' } as any,
      response: {} as any,
      // RequestContext methods used by emitTelemetryEvent
      bind: () => ctx as any,
      getSync: () => undefined,
    } as any;

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/odata/Products');
  });

  it('preserves root query URLs when rewriting', async () => {
    const provider = new OdataPathRewriterProvider({ basePath: '/' } as any, noopLogger);
    const middleware = provider.value();
    const ctx: MiddlewareContext = {
      request: { url: '/?foo=bar' } as any,
      response: {} as any,
      bind: () => ctx as any,
      getSync: () => undefined,
    } as any;

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/odata?foo=bar');
  });

  it('treats root basePath as matching any absolute path in request-context provider', () => {
    const provider = new ODataRequestContextProvider({ basePath: '/' } as any);
    const pathMatches = (provider as any).pathMatches.bind(provider);
    assert.equal(pathMatches('/Products', '/'), true);
    assert.equal(pathMatches('/?foo=1', '/'), true);
  });

  it('treats root basePath as matching any absolute path in request-logging provider', () => {
    const provider = new RequestLoggingProvider({ basePath: '/' } as any, noopLogger);
    const pathMatches = (provider as any).pathMatches.bind(provider);
    assert.equal(pathMatches('/Orders', '/'), true);
    assert.equal(pathMatches('/#fragment', '/'), true);
  });
});

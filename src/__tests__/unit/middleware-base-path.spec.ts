/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { OdataPathRewriterProvider } from '../../middleware/odata-path-rewriter.provider';
import { ODataRequestContextProvider } from '../../middleware/odata-request-context.provider';
import { RequestLoggingProvider } from '../../middleware/request-logging.provider';
import { ODataLogger } from '../../keys';
import { EntitySetRegistry } from '../../registry/entityset-registry';
import { MiddlewareContext } from '@loopback/rest';

const noopLogger: ODataLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const createMiddlewareContext = (url: string): MiddlewareContext => {
  const ctx: MiddlewareContext = {
    request: { url } as any,
    response: {} as any,
    bind: () => ctx as any,
    getSync: () => undefined,
  } as any;
  return ctx;
};

describe('root basePath middleware handling', () => {
  it('rewrites root-mounted requests to /odata paths', async () => {
    const provider = new OdataPathRewriterProvider(
      { basePath: '/' } as any,
      noopLogger,
      new EntitySetRegistry(),
    );
    const middleware = provider.value();
    const ctx = createMiddlewareContext('/Products');

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/odata/Products');
  });

  it('preserves root query URLs when rewriting', async () => {
    const provider = new OdataPathRewriterProvider(
      { basePath: '/' } as any,
      noopLogger,
      new EntitySetRegistry(),
    );
    const middleware = provider.value();
    const ctx = createMiddlewareContext('/?foo=bar');

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/odata?foo=bar');
  });

  it('treats root basePath as matching any absolute path in request-context provider', () => {
    const provider = new ODataRequestContextProvider({ basePath: '/' } as any);
    const isODataRequest = (provider as any).isODataRequest.bind(provider);
    assert.equal(isODataRequest({ url: '/Products' }, '/'), true);
    assert.equal(isODataRequest({ url: '/?foo=1' }, '/'), true);
  });

  it('treats root basePath as matching any absolute path in request-logging provider', () => {
    const provider = new RequestLoggingProvider({ basePath: '/' } as any, noopLogger);
    const isODataRequest = (provider as any).isODataRequest.bind(provider);
    assert.equal(isODataRequest({ url: '/Orders' }, '/'), true);
    assert.equal(isODataRequest({ url: '/#fragment' }, '/'), true);
  });

  it('does not rewrite non-OData routes containing parentheses', async () => {
    const provider = new OdataPathRewriterProvider(
      { basePath: '/odata' } as any,
      noopLogger,
      new EntitySetRegistry(),
    );
    const middleware = provider.value();
    const ctx = createMiddlewareContext('/assets/logo(1).png');

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/assets/logo(1).png');
  });

  it('skips rewriting when URL does not match custom service root', async () => {
    const provider = new OdataPathRewriterProvider(
      { basePath: '/api/odata' } as any,
      noopLogger,
      new EntitySetRegistry(),
    );
    const middleware = provider.value();
    const ctx = createMiddlewareContext('/public/files(2).json');

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/public/files(2).json');
  });

  it('rewrites canonical /odata URLs even when basePath is custom', async () => {
    const provider = new OdataPathRewriterProvider(
      { basePath: '/api/odata' } as any,
      noopLogger,
      new EntitySetRegistry(),
    );
    const middleware = provider.value();
    const ctx = createMiddlewareContext("/odata/Products(Key='ABC')");

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/odata/Products/Key%3DABC');
  });

  it('rewrites custom basePath requests after stripping prefix', async () => {
    const provider = new OdataPathRewriterProvider(
      { basePath: '/api/odata' } as any,
      noopLogger,
      new EntitySetRegistry(),
    );
    const middleware = provider.value();
    const ctx = createMiddlewareContext("/api/odata/Products(Key='XYZ')");

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/odata/Products/Key%3DXYZ');
  });

  it('uses originalUrl when Express strips the mounted basePath segment', async () => {
    const provider = new OdataPathRewriterProvider(
      { basePath: '/api/odata' } as any,
      noopLogger,
      new EntitySetRegistry(),
    );
    const middleware = provider.value();
    const ctx = createMiddlewareContext('/');
    (ctx.request as any).originalUrl = '/api/odata';

    await middleware(ctx, async () => undefined);

    assert.equal(ctx.request.url, '/odata/');
  });
});

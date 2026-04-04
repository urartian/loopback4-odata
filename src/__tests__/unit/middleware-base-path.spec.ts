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
  const responseHeaders = new Map<string, string>();
  const ctx: MiddlewareContext = {
    request: {
      url,
      header(name: string) {
        return (this.headers ?? {})[name.toLowerCase()];
      },
    } as any,
    response: {
      getHeader(name: string) {
        return responseHeaders.get(name.toLowerCase());
      },
      setHeader(name: string, value: string) {
        responseHeaders.set(name.toLowerCase(), value);
      },
      headersSent: false,
    } as any,
    bind: () => ctx as any,
    getSync: () => undefined,
  } as any;
  (ctx as any)._responseHeaders = responseHeaders;
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

  it('skips binding request state for non-OData requests', async () => {
    const provider = new ODataRequestContextProvider({ basePath: '/api/odata' } as any);
    const middleware = provider.value();
    const ctx = createMiddlewareContext('/health');
    let nextCalls = 0;
    let boundState: unknown;
    ctx.bind = () =>
      ({
        to(value: unknown) {
          boundState = value;
          return { inScope: () => ctx };
        },
      } as any);

    await middleware(ctx, async () => {
      nextCalls += 1;
      return 'ok';
    });

    assert.equal(nextCalls, 1);
    assert.equal(boundState, undefined);
  });

  it('captures correlation, tenant, telemetry preferences, and batch depth for OData requests', async () => {
    const provider = new ODataRequestContextProvider({
      basePath: '/api/odata',
      tenantResolver: (req: any) => req.header('x-tenant-id'),
      correlation: {
        responseHeaderName: 'x-request-id',
      },
      telemetry: {
        enabled: true,
        emitStatisticsHeader: true,
        requestLogging: { enabled: true, allowClientOverride: true },
      },
    } as any);
    const middleware = provider.value();
    const ctx = createMiddlewareContext('/api/odata/Products');
    (ctx.request as any).headers = {
      prefer: 'telemetry=statistics, telemetry="request-log"',
      'x-tenant-id': 'tenant-a',
    };
    (ctx.request as any).__odataBatchDepth = 2;

    let boundState: any;
    ctx.bind = () =>
      ({
        to(value: unknown) {
          boundState = value;
          return { inScope: () => ctx };
        },
      } as any);

    await middleware(ctx, async () => undefined);

    assert.equal(boundState.tenantId, 'tenant-a');
    assert.equal(boundState.batchDepth, 2);
    assert.equal(boundState.telemetry?.enabled, true);
    assert.equal(boundState.telemetry?.requestLoggingEnabled, true);
    assert.equal(boundState.statistics?.requested, true);
    assert.equal(typeof boundState.correlationId, 'string');
    assert.equal(
      (ctx as any)._responseHeaders.get('x-request-id'),
      boundState.correlationId,
    );
    assert.match(
      String((ctx as any)._responseHeaders.get('preference-applied')),
      /telemetry=statistics/i,
    );
  });

  it('tolerates tenant resolver failures and disabled correlation', async () => {
    const provider = new ODataRequestContextProvider({
      basePath: '/odata',
      tenantResolver: () => {
        throw new Error('boom');
      },
      correlation: { enabled: false },
    } as any);
    const middleware = provider.value();
    const ctx = createMiddlewareContext('/odata/Products');
    let boundState: any;
    ctx.bind = () =>
      ({
        to(value: unknown) {
          boundState = value;
          return { inScope: () => ctx };
        },
      } as any);

    await middleware(ctx, async () => undefined);

    assert.equal(boundState.tenantId, undefined);
    assert.equal(boundState.correlationId, undefined);
  });

  it('deduplicates Preference-Applied values and rounds telemetry payloads', () => {
    const provider = new ODataRequestContextProvider({ basePath: '/odata' } as any);
    const appendPreferenceApplied = (provider as any).appendPreferenceApplied.bind(provider);
    const roundNumber = (provider as any).roundNumber.bind(provider);
    const response = {
      value: 'telemetry=statistics',
      getHeader() {
        return this.value;
      },
      setHeader(_name: string, value: string) {
        this.value = value;
      },
    } as any;

    appendPreferenceApplied(response, 'telemetry=statistics');
    appendPreferenceApplied(response, 'telemetry=request-log');

    assert.equal(response.value, 'telemetry=statistics, telemetry=request-log');
    assert.equal(roundNumber(1.2345, 2), 1.23);
    assert.equal(roundNumber(Number.POSITIVE_INFINITY, 2), Number.POSITIVE_INFINITY);
  });
});

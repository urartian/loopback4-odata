import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataConfig } from '../../types';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { Request, Response } from '@loopback/rest';

@model()
class Product extends Entity {
  @property({ id: true })
  id!: number;
}

const def: EntitySetDef = {
  name: 'Products',
  modelCtor: Product,
  repositoryBindingKey: 'repositories.ProductRepository',
};

const noopLogger: ODataLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const throttler: ODataTenantThrottler = {
  check: async () => undefined,
  release: () => undefined,
};

function createController(
  config: Partial<ODataConfig> = {},
  requestOverrides: Partial<Request> = {},
  responseOverrides: Partial<Response> = {},
) {
  const Controller = defineODataCrudController(def);
  const overrideHeaders = (requestOverrides.headers ?? {}) as Record<
    string,
    string | string[] | undefined
  >;
  const request = {
    protocol: requestOverrides.protocol ?? 'https',
    headers: {
      host: 'example.test',
      ...overrideHeaders,
    },
    ...requestOverrides,
  } as Request;
  request.headers = {
    host: 'example.test',
    ...overrideHeaders,
  };
  const response = {
    set() {},
    status() {
      return this;
    },
    end() {},
    ...responseOverrides,
  } as Response;

  const resolvedConfig = {
    ...config,
    tokenSecret: config.tokenSecret ?? 'test-secret',
  } as ODataConfig;

  return new Controller(
    {} as any,
    request as any,
    response as any,
    {} as any,
    resolvedConfig,
    {} as any,
    noopLogger,
    throttler,
  );
}

describe('CRUD controller navigation reference parsing', () => {
  it('parses default /odata references', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference('/odata/Products(10)');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '10' });
  });

  it('parses relative references without leading slash', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference('Products(25)');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '25' });
  });

  it('strips configured basePath prefixes', () => {
    const controller = createController({ basePath: '/api/odata' });
    const result = (controller as any).parseODataIdReference('/api/odata/Products(42)');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '42' });
  });

  it('rejects /odata prefixes when basePath differs', () => {
    const controller = createController({ basePath: '/api/odata' });
    expect(() => (controller as any).parseODataIdReference('/odata/Products(7)')).to.throw(
      /Invalid @odata\.id value/,
    );
  });

  it('strips namespace and alias prefixes', () => {
    const controller = createController({
      basePath: '/api/odata',
      namespace: 'Catalog.Service',
      namespaceAlias: 'CatalogNS',
    });
    const namespaced = (controller as any).parseODataIdReference(
      '/api/odata/Catalog.Service.Products(1)',
    );
    expect(namespaced).to.deepEqual({ entitySet: 'Products', keyExpression: '1' });

    const aliased = (controller as any).parseODataIdReference('/api/odata/CatalogNS.Products(2)');
    expect(aliased).to.deepEqual({ entitySet: 'Products', keyExpression: '2' });
  });

  it('parses absolute URLs that include the basePath', () => {
    const controller = createController({ basePath: '/api/odata' });
    const result = (controller as any).parseODataIdReference(
      'https://example.test/api/odata/Products(99)',
    );
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '99' });
  });

  it('strips query strings from @odata.id references', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference('/odata/Products(5)?$select=Id');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '5' });
  });

  it('strips fragments from @odata.id references', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference('/odata/Products(6)#foo');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '6' });
  });

  it('rejects navigation path references in @odata.id', () => {
    const controller = createController();
    expect(() =>
      (controller as any).parseODataIdReference('/odata/Orders(1)/Customer(2)'),
    ).to.throw(/navigation-path/i);
  });

  it('accepts string keys containing closing parentheses', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference("/odata/Products('A)B')");
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: "'A)B'" });
  });

  it('accepts string keys containing escaped single quotes', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference("/odata/Products('A'')B')");
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: "'A'')B'" });
  });

  it('rejects trailing garbage after closing parenthesis', () => {
    const controller = createController();
    expect(() => (controller as any).parseODataIdReference('/odata/Products(1)junk')).to.throw(
      /trailing/i,
    );
  });

  it('rejects unterminated string literals in key predicates', () => {
    const controller = createController();
    expect(() => (controller as any).parseODataIdReference("/odata/Products('A)")).to.throw(
      /unterminated/i,
    );
  });

  it('accepts absolute references that match the current service root', () => {
    const controller = createController({ basePath: '/api/odata' });
    const result = (controller as any).parseODataIdReference(
      'https://example.test/api/odata/Products(30)',
    );
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '30' });
  });

  it('rejects absolute references whose origin does not match the request origin', () => {
    const controller = createController({ basePath: '/api/odata' });
    expect(() =>
      (controller as any).parseODataIdReference('https://evil.test/api/odata/Products(1)'),
    ).to.throw(/Invalid @odata\.id value/);
    expect(() =>
      (controller as any).parseODataIdReference('http://example.test/api/odata/Products(1)'),
    ).to.throw(/Invalid @odata\.id value/);
  });

  it('rejects absolute references whose paths fall outside the configured service root', () => {
    const controller = createController({ basePath: '/api/v1/odata' });
    expect(() =>
      (controller as any).parseODataIdReference('https://example.test/api/v2/odata/Products(5)'),
    ).to.throw(/Invalid @odata\.id value/);
  });

  it('ignores spoofed forwarded headers when proxies are not trusted', () => {
    const controller = createController(
      { basePath: '/api/odata', trustProxyHeaders: false },
      {
        headers: {
          host: 'tenant.test',
          forwarded: 'proto=https;host=example.test',
        },
        socket: { remoteAddress: '203.0.113.10' } as any,
      },
    );
    expect(() =>
      (controller as any).parseODataIdReference('https://example.test/api/odata/Products(1)'),
    ).to.throw(/Invalid @odata\.id value/);
  });

  it('honors forwarded headers when trustProxyHeaders is true', () => {
    const controller = createController(
      { basePath: '/api/odata', trustProxyHeaders: true },
      {
        headers: {
          host: 'tenant.test',
          forwarded: 'proto=HTTPS;host=EXAMPLE.TEST',
        },
        socket: { remoteAddress: '198.51.100.25' } as any,
      },
    );
    const result = (controller as any).parseODataIdReference(
      'https://example.test/api/odata/Products(15)',
    );
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '15' });
  });

  it('ignores Express trust proxy setting when config is unset', () => {
    const controller = createController({ basePath: '/api/odata' }, {
      headers: {
        host: 'tenant.test',
        forwarded: 'proto=HTTPS;host=EXAMPLE.TEST',
      },
      app: {
        enabled(setting: string) {
          return setting === 'trust proxy';
        },
      },
      socket: { remoteAddress: '203.0.113.11' } as any,
    } as any);
    expect(() =>
      (controller as any).parseODataIdReference('https://example.test/api/odata/Products(21)'),
    ).to.throw(/Invalid @odata\.id value/);
  });

  it('honors trusted proxy subnets when remote address matches', () => {
    const controller = createController(
      { basePath: '/api/odata', trustedProxySubnets: ['10.0.0.0/8'] },
      {
        headers: {
          host: 'tenant.test',
          forwarded: 'proto=https;host=example.test',
        },
        socket: { remoteAddress: '10.1.2.3' } as any,
      },
    );
    const result = (controller as any).parseODataIdReference(
      'https://example.test/api/odata/Products(21)',
    );
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '21' });
  });

  it('rejects headers when remote address is outside trusted subnets', () => {
    const controller = createController(
      { basePath: '/api/odata', trustedProxySubnets: ['10.0.0.0/8'] },
      {
        headers: {
          host: 'tenant.test',
          forwarded: 'proto=https;host=example.test',
        },
        socket: { remoteAddress: '198.51.100.50' } as any,
      },
    );
    expect(() =>
      (controller as any).parseODataIdReference('https://example.test/api/odata/Products(22)'),
    ).to.throw(/Invalid @odata\.id value/);
  });

  it('supports IPv6 trusted proxy subnets', () => {
    const controller = createController(
      { basePath: '/api/odata', trustedProxySubnets: ['2001:db8::/32'] },
      {
        headers: {
          host: 'tenant.test',
          forwarded: 'proto=https;host=example.test',
        },
        socket: { remoteAddress: '2001:db8::1234' } as any,
      },
    );
    const result = (controller as any).parseODataIdReference(
      'https://example.test/api/odata/Products(23)',
    );
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '23' });
  });

  it('uses X-Forwarded-* headers when trustProxyHeaders is true', () => {
    const controller = createController(
      { basePath: '/api/odata', trustProxyHeaders: true },
      {
        headers: {
          host: 'tenant.test',
          'x-forwarded-proto': 'HTTPS',
          'x-forwarded-host': 'EXAMPLE.TEST',
        },
      },
    );
    const result = (controller as any).parseODataIdReference(
      'https://example.test/api/odata/Products(22)',
    );
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '22' });
  });

  it('honors IPv6 forwarded hosts when proxies are trusted', () => {
    const controller = createController(
      { trustProxyHeaders: true },
      {
        headers: {
          host: 'tenant.test',
          forwarded: 'proto=HTTPS;host="[2001:DB8::1]:8443"',
        },
      },
    );
    const result = (controller as any).parseODataIdReference(
      'https://[2001:db8::1]:8443/odata/Products(23)',
    );
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '23' });
  });

  it('builds entity location URLs using trusted forwarded headers', () => {
    const controller = createController(
      { basePath: '/api/odata', trustProxyHeaders: true },
      {
        headers: {
          host: 'internal.local',
          forwarded: 'proto=HTTPS;host=PUBLIC.EXAMPLE',
        },
      },
    );
    const url = (controller as any).buildEntityLocationUrl(5, { id: 5 });
    expect(url).to.equal('https://public.example/api/odata/Products(5)');
  });

  it('sets Location headers with the trusted origin when emitting responses', () => {
    const headers: Record<string, string> = {};
    const controller = createController(
      { basePath: '/api/odata', trustProxyHeaders: true },
      {
        headers: {
          host: 'internal.local',
          'x-forwarded-proto': 'HTTPS',
          'x-forwarded-host': 'PUBLIC.EXAMPLE',
        },
      },
      {
        set(name: string, value: string) {
          headers[name] = value;
        },
      } as Partial<Response>,
    );
    const url = (controller as any).buildEntityLocationUrl(9, { id: 9 });
    (controller as any).setEntityLocationHeaders(url);
    expect(headers.Location).to.equal('https://public.example/api/odata/Products(9)');
    expect(headers['OData-EntityId']).to.equal(headers.Location);
  });
});

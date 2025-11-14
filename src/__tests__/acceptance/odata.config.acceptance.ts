/// <reference path="../../types/testing.globals.d.ts" />

import { Client, createRestAppClient, expect } from '@loopback/testlab';
import {
  TestApplication,
  givenODataApplication,
  seedExampleData,
} from '../fixtures/odata-app.fixture';
import { ODATA_BINDINGS } from '../../keys';
import { ODataConfig, ODataLogEntry, ODataPaginationConfig } from '../../types';
import { EntitySetRegistry } from '../../registry/entityset-registry';
import { Order } from '../fixtures/odata-app.fixture';

type ConfigOverrides = Omit<Partial<ODataConfig>, 'pagination'> & {
  pagination?: Partial<ODataPaginationConfig>;
};
type AppConfigurator = (app: TestApplication) => Promise<void> | void;

describe('OData config plumbing acceptance', () => {
  let app: TestApplication;
  let client: Client;

  const bootAppWithConfig = async (
    mochaCtx: { skip: () => void },
    overrides: ConfigOverrides = {},
    configureApp?: AppConfigurator,
  ): Promise<void> => {
    const freshApp = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const baseConfig = freshApp.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    const { pagination: paginationOverrides, ...restOverrides } = overrides;
    const mergedPagination: ODataPaginationConfig = {
      ...(baseConfig.pagination ?? {}),
      maxTop: 1,
      maxSkip: 2,
      maxPageSize: 2,
      maxApplyPageSize: 2,
      ...(paginationOverrides ?? {}),
    };

    freshApp.bind(ODATA_BINDINGS.CONFIG).to({
      ...baseConfig,
      basePath: '/api/odata',
      maxExpandDepth: 2,
      enableCount: false,
      strict: false,
      pagination: mergedPagination,
      ...restOverrides,
    });

    if (configureApp) {
      await configureApp(freshApp);
    }

    await freshApp.boot();
    await seedExampleData(freshApp);
    try {
      await freshApp.start();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const message = (err as Error).message ?? '';
      await freshApp.stop().catch(() => undefined);
      if (code === 'EPERM' || message.includes('not listening')) {
        mochaCtx.skip();
        return;
      }
      throw err;
    }

    app = freshApp;
    client = createRestAppClient(app);
  };

  const replaceApp = async (
    mochaCtx: { skip: () => void },
    overrides: ConfigOverrides,
    configureApp?: AppConfigurator,
  ) => {
    if (app?.state === 'started') {
      await app.stop();
    }
    await bootAppWithConfig(mochaCtx, overrides, configureApp);
  };

  beforeEach(async function (this: any) {
    await bootAppWithConfig(this);
  });

  afterEach(async () => {
    if (app?.state === 'started') {
      await app.stop();
    }
  });

  it('rewrites configured basePath to internal /odata and emits correct @odata.context', async () => {
    const res = await client.get('/api/odata').expect(200);
    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body['@odata.context']).to.equal('/api/odata/$metadata');
  });

  it('supports root basePath configuration', async function (this: any) {
    await replaceApp(this, { basePath: '/' });
    const res = await client.get('/').expect(200);
    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body['@odata.context']).to.equal('/$metadata');
    await client.get('/Products').expect(200);
  });

  it('clamps $top according to maxTop when strict=false', async () => {
    const res = await client.get('/api/odata/Products').query({ $top: '5' }).expect(200);
    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.lessThanOrEqual(1);
  });

  it('rejects $top above maxTop when strict=true', async function () {
    // Rebind config with strict=true and restart app to test strict behavior
    if (app.state === 'started') await app.stop();
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const baseConfig = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...baseConfig,
      basePath: '/api/odata',
      enableCount: false,
      strict: true,
      pagination: {
        ...(baseConfig.pagination ?? {}),
        maxTop: 1,
      },
    });
    await app.boot();
    await seedExampleData(app);
    await app.start();
    client = createRestAppClient(app);

    const res = await client.get('/api/odata/Products').query({ $top: '5' }).expect(400);
    expect(res.body?.error?.code).to.equal('BadRequest');
  });

  it('enforces maxExpandDepth even when strict=false', async () => {
    await client
      .get('/api/odata/Products')
      .query({ $expand: 'orders($expand=items($expand=product))' })
      .expect(400);
  });

  it('clamps $skip to maxSkip when strict=false', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({ $skip: '10', $orderby: 'id asc' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.greaterThan(0);
    expect(res.body.value[0].name).to.equal('Monitor');
  });

  it('limits server-driven paging to pagination.maxPageSize', async () => {
    const res = await client.get('/api/odata/Products').expect(200);
    expect(res.body.value.length).to.be.lessThanOrEqual(2);
    expect(res.body['@odata.nextLink']).to.be.a.String();
  });

  it('limits $apply server-driven paging to pagination.maxApplyPageSize', async function (this: any) {
    await replaceApp(this, {
      pagination: { maxApplyPageSize: 1 },
    });
    const pipeline =
      'groupby((name),aggregate(price with sum as TotalPrice))/orderby(TotalPrice desc)';
    const res = await client.get('/api/odata/Products').query({ $apply: pipeline }).expect(200);

    expect(res.body.value.length).to.be.lessThanOrEqual(1);
    expect(res.body['@odata.nextLink']).to.be.a.String();
  });

  it('limits $apply server-driven paging in strict mode', async function (this: any) {
    await replaceApp(this, {
      strict: true,
      pagination: { maxApplyPageSize: 1 },
    });
    const pipeline =
      'groupby((name),aggregate(price with sum as TotalPrice))/orderby(TotalPrice desc)';
    const res = await client.get('/api/odata/Products').query({ $apply: pipeline }).expect(200);

    expect(res.body.value.length).to.be.lessThanOrEqual(1);
    expect(res.body['@odata.nextLink']).to.be.a.String();
  });

  it('honors entity-level pagination overrides over global defaults', async function (this: any) {
    await replaceApp(
      this,
      {
        pagination: {
          maxPageSize: 3,
        },
      },
      async (freshApp) => {
        const registry = await freshApp.get<EntitySetRegistry>(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
        registry.register({
          name: 'Orders',
          modelCtor: Order,
          pagination: {
            maxPageSize: 1,
          },
        });
      },
    );

    const productsRes = await client.get('/api/odata/Products').expect(200);
    expect(productsRes.body.value.length).to.be.lessThanOrEqual(3);
    expect(productsRes.body.value.length).to.be.greaterThan(0);
    expect(productsRes.body['@odata.nextLink']).to.be.a.String();

    const ordersRes = await client.get('/api/odata/Orders').expect(200);
    expect(ordersRes.body.value.length).to.be.lessThanOrEqual(1);
    expect(ordersRes.body['@odata.nextLink']).to.be.a.String();
  });

  it('supports trim() filters when strict=false', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({ $filter: "trim(name) eq 'Laptop'" })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.map((item: any) => item.name)).to.containEql('Laptop');
  });

  it('supports concat() filters when strict=false', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({ $filter: "concat(name,'/',price) eq 'Laptop/1299'" })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.have.length(1);
    expect(res.body.value[0].name).to.equal('Laptop');
  });

  it('supports month() filters when strict=false', async () => {
    const first = await client.get('/api/odata/Products?$top=1').expect(200);
    const sample = first.body.value[0];
    const updatedAt = new Date(sample.updatedAt);
    const month = updatedAt.getUTCMonth() + 1;

    const res = await client
      .get('/api/odata/Products')
      .query({ $filter: `month(updatedAt) eq ${month}` })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.greaterThan(0);
  });

  it('rejects inline $count when disabled', async () => {
    const res = await client.get('/api/odata/Products').query({ $count: 'true' }).expect(400);
    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body?.error?.code).to.equal('BadRequest');
  });

  it('disables standalone $count endpoint when disabled', async () => {
    const res = await client.get('/api/odata/Products/$count').expect(501);
    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body?.error?.code).to.equal('NotImplemented');
  });

  it('handles entity key path under custom basePath', async () => {
    const first = await client.get('/api/odata/Products?$top=1').expect(200);
    const id = first.body.value[0]?.id;
    const res = await client.get(`/api/odata/Products(${id})`).expect(200);
    expect(res.body.id).to.equal(id);
  });

  it('rejects invalid pagination guardrails at startup', async function () {
    if (app?.state === 'started') {
      await app.stop();
    }
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const baseConfig = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...baseConfig,
      pagination: {
        ...(baseConfig.pagination ?? {}),
        maxPageSize: 0,
      },
    });
    await app.boot();
    await expect(app.start()).to.be.rejectedWith(/ODataConfig\.pagination\.maxPageSize/);
  });

  it('enforces tenant quotas when tenantResolver is configured', async function (this: any) {
    await replaceApp(this, {
      tenantResolver: (req) => req.get('x-tenant-id') ?? 'default',
      tenantQuotas: { maxRequestsPerMinute: 1 },
    });

    await client.get('/api/odata/Products').set('x-tenant-id', 'alpha').expect(200);
    await client.get('/api/odata/Products').set('x-tenant-id', 'alpha').expect(429);
    await client.get('/api/odata/Products').set('x-tenant-id', 'beta').expect(200);
  });

  it('enforces tenant quotas on entity write operations', async function (this: any) {
    await replaceApp(this, {
      tenantResolver: (req) => req.get('x-tenant-id') ?? 'default',
      tenantQuotas: {
        maxRequestsPerMinute: 10,
        overrides: {
          writer: { maxRequestsPerMinute: 1 },
        },
      },
    });

    await client
      .post('/api/odata/Products')
      .set('x-tenant-id', 'writer')
      .send({ name: 'Rate Limited Gadget', price: 123 })
      .expect(200);

    await client
      .post('/api/odata/Products')
      .set('x-tenant-id', 'writer')
      .send({ name: 'Second Gadget', price: 456 })
      .expect(429);

    await client
      .post('/api/odata/Products')
      .set('x-tenant-id', 'writer-premium')
      .send({ name: 'Premium Gadget', price: 789 })
      .expect(200);
  });

  it('enforces tenant quotas on delete operations', async function (this: any) {
    await replaceApp(this, {
      tenantResolver: (req) => req.get('x-tenant-id') ?? 'default',
      tenantQuotas: {
        maxRequestsPerMinute: 10,
        overrides: {
          deleter: { maxRequestsPerMinute: 1 },
        },
      },
    });

    const created = await client
      .post('/api/odata/Products')
      .send({ name: 'Disposable Product', price: 9 })
      .expect(200);

    const productId = created.body.id;
    expect(productId).to.be.a.Number();

    await client.del(`/api/odata/Products(${productId})`).set('x-tenant-id', 'deleter').expect(204);
    await client.del(`/api/odata/Products(${productId})`).set('x-tenant-id', 'deleter').expect(429);
  });

  it('enforces tenant quotas on navigation $ref operations', async function (this: any) {
    await replaceApp(this, {
      tenantResolver: (req) => req.get('x-tenant-id') ?? 'default',
      tenantQuotas: {
        maxRequestsPerMinute: 10,
        overrides: {
          'nav-tenant': { maxRequestsPerMinute: 1 },
        },
      },
    });

    const newOrder = await client.post('/api/odata/Orders').send({ total: 0 }).expect(200);
    const newOrderId = newOrder.body.id;
    expect(newOrderId).to.be.a.Number();

    const orderItemsRes = await client.get('/api/odata/OrderItems').expect(200);
    const existingItem = orderItemsRes.body.value[0];
    expect(existingItem).to.be.Object();
    const originalOrderId = existingItem.orderId;

    const linkPayload = { '@odata.id': `/api/odata/OrderItems(${existingItem.id})` };

    await client
      .post(`/api/odata/Orders(${newOrderId})/items/$ref`)
      .set('x-tenant-id', 'nav-tenant')
      .send(linkPayload)
      .expect(204);

    await client
      .post(`/api/odata/Orders(${newOrderId})/items/$ref`)
      .set('x-tenant-id', 'nav-tenant')
      .send(linkPayload)
      .expect(429);

    await client
      .post(`/api/odata/Orders(${originalOrderId})/items/$ref`)
      .send(linkPayload)
      .expect(204);
  });

  it('emits structured tenant throttle events via onLog', async function (this: any) {
    const events: ODataLogEntry[] = [];
    await replaceApp(this, {
      tenantResolver: (req) => req.get('x-tenant-id') ?? 'default',
      tenantQuotas: { maxRequestsPerMinute: 1 },
      onLog: (entry) => {
        if (entry.context?.event === 'tenant-throttle') {
          events.push(entry);
        }
      },
    });

    await client.get('/api/odata/Products').set('x-tenant-id', 'alpha').expect(200);
    await client.get('/api/odata/Products').set('x-tenant-id', 'alpha').expect(429);

    expect(events).to.have.length(1);
    expect(events[0].context).to.containDeep({
      event: 'tenant-throttle',
      tenantId: 'alpha',
      limitType: 'rate',
      method: 'GET',
    });
  });

  it('propagates correlation ids and generates fallback ids', async function (this: any) {
    await replaceApp(this, {
      correlation: {
        headerName: 'x-correlation-id',
        responseHeaderName: 'x-correlation-id',
        generateWhenMissing: true,
      },
    });

    const customId = 'req-custom-id';
    const withHeader = await client
      .get('/api/odata/Products')
      .set('X-Correlation-Id', customId)
      .expect(200);
    expect(withHeader.headers['x-correlation-id']).to.equal(customId);

    const generated = await client.get('/api/odata/Products').expect(200);
    expect(generated.headers['x-correlation-id']).to.be.a.String();
    expect(generated.headers['x-correlation-id']).to.not.equal('');
    expect(generated.headers['x-correlation-id']).to.not.equal(customId);
  });

  it('emits statistics header when telemetry preference is honored', async function (this: any) {
    await replaceApp(this, {
      telemetry: {
        enabled: true,
        emitStatisticsHeader: true,
        statisticsHeaderName: 'OData-Stats',
        statisticsPrecision: 3,
      },
    });

    const baseline = await client.get('/api/odata/Products').expect(200);
    expect(baseline.headers['odata-stats']).to.be.undefined();

    const res = await client
      .get('/api/odata/Products')
      .set('Prefer', 'telemetry=statistics')
      .expect(200);

    expect(res.headers['preference-applied']).to.match(/telemetry=statistics/);
    const statsHeader = res.headers['odata-stats'];
    expect(statsHeader).to.be.a.String();
    const stats = JSON.parse(statsHeader as string);
    expect(stats.processingTime).to.be.a.Number();
    expect(stats.dbTime).to.be.a.Number();
    expect(stats.roundTrips).to.be.a.Number();
    expect(stats.rows).to.be.a.Number();
  });

  it('emits apply telemetry entries when telemetry is enabled', async function (this: any) {
    const logEntries: ODataLogEntry[] = [];
    await replaceApp(this, {
      telemetry: {
        enabled: true,
        categories: ['apply'],
        sampleRate: 1,
        includeApplyPlanOnFallback: true,
      },
      onLog: (entry) => {
        if (entry.context?.telemetryCategory) {
          logEntries.push(entry);
        }
      },
    });

    await client
      .get('/api/odata/Products')
      .query({ $apply: 'groupby((name),aggregate(price with sum as TotalPrice))' })
      .expect(200);

    const fallbackEvent = logEntries.find(
      (entry) => entry.context?.telemetryEvent === 'apply-fallback',
    );
    expect(fallbackEvent).to.be.Object();
    expect(fallbackEvent?.context).to.containDeep({
      telemetryCategory: 'apply',
      entitySet: 'Products',
      reason: 'in-memory-apply',
    });
    expect(fallbackEvent?.context?.plan).to.be.an.Object();
  });

  it('emits hook telemetry entries for decorated controllers', async function (this: any) {
    const logEntries: ODataLogEntry[] = [];
    await replaceApp(this, {
      telemetry: {
        enabled: true,
        categories: ['hooks'],
        sampleRate: 1,
      },
      onLog: (entry) => {
        if (entry.context?.telemetryCategory === 'hooks') {
          logEntries.push(entry);
        }
      },
    });

    await client
      .post('/api/odata/Products')
      .send({ name: 'Telemetry Gizmo', price: 42 })
      .expect(200);

    const beforeEvent = logEntries.find((entry) => entry.context?.telemetryEvent === 'hook.before');
    expect(beforeEvent).to.be.Object();
    expect(beforeEvent?.context).to.containDeep({
      hookName: 'validateCreate',
      operation: 'CREATE',
    });
  });

  it('emits throttle telemetry entries when tenant quotas reject requests', async function (this: any) {
    const logEntries: ODataLogEntry[] = [];
    await replaceApp(this, {
      tenantResolver: (req) => req.get('x-tenant-id') ?? 'default',
      tenantQuotas: { maxRequestsPerMinute: 1 },
      telemetry: {
        enabled: true,
        categories: ['throttle'],
        sampleRate: 1,
      },
      onLog: (entry) => {
        if (entry.context?.telemetryCategory === 'throttle') {
          logEntries.push(entry);
        }
      },
    });

    await client.get('/api/odata/Products').set('x-tenant-id', 'telemetry').expect(200);
    await client.get('/api/odata/Products').set('x-tenant-id', 'telemetry').expect(429);

    const rejectionEvent = logEntries.find(
      (entry) =>
        entry.context?.telemetryEvent === 'tenant-throttle-check' &&
        entry.context?.result === 'rejected',
    );
    expect(rejectionEvent).to.be.Object();
    expect(rejectionEvent?.context).to.containDeep({
      telemetryCategory: 'throttle',
      result: 'rejected',
      tenantId: 'telemetry',
    });
  });

  it('logs every request when request logging is enabled', async function (this: any) {
    const logEntries: ODataLogEntry[] = [];
    await replaceApp(this, {
      telemetry: {
        enabled: true,
        categories: ['requests'],
        sampleRate: 1,
        requestLogging: {
          enabled: true,
          includeHeaders: true,
          includeResponseBody: false,
          maskHeaders: ['authorization'],
          maxPayloadBytes: 1024,
        },
      },
      onLog: (entry) => {
        if (entry.context?.telemetryEvent === 'request.log') {
          logEntries.push(entry);
        }
      },
    });

    await client
      .post('/api/odata/Products')
      .set('Authorization', 'Basic secret')
      .send({ name: 'RequestLogTest', price: 99 })
      .expect(200);

    const requestLog = logEntries.find((entry) => entry.context?.telemetryEvent === 'request.log');
    expect(requestLog).to.be.Object();
    expect(requestLog?.context).to.containDeep({
      method: 'POST',
      status: 200,
      telemetryCategory: 'requests',
    });
    const headers = requestLog?.context?.headers as Record<string, unknown>;
    expect(headers?.authorization).to.equal('***');
  });

  it('logs requests when clients opt in via Prefer header', async function (this: any) {
    const logEntries: ODataLogEntry[] = [];
    await replaceApp(this, {
      telemetry: { enabled: false },
      onLog: (entry) => {
        if (entry.context?.telemetryEvent === 'request.log') {
          logEntries.push(entry);
        }
      },
    });

    await client.get('/api/odata/Products').set('Prefer', 'telemetry=request-log').expect(200);

    expect(logEntries.length).to.equal(1);
    expect(logEntries[0].context).to.containDeep({
      telemetryCategory: 'requests',
      method: 'GET',
    });
  });
});

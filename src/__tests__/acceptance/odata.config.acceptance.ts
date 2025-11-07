/// <reference path="../../types/testing.globals.d.ts" />

import { Client, createRestAppClient, expect } from '@loopback/testlab';
import {
  TestApplication,
  givenODataApplication,
  seedExampleData,
} from '../fixtures/odata-app.fixture';
import { ODATA_BINDINGS } from '../../keys';
import { ODataConfig, ODataPaginationConfig } from '../../types';
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
});

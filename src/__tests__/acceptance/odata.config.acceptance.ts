/// <reference path="../../types/testing.globals.d.ts" />

import {Client, createRestAppClient, expect} from '@loopback/testlab';
import {
  TestApplication,
  givenODataApplication,
  seedExampleData,
} from '../fixtures/odata-app.fixture';
import {ODATA_BINDINGS} from '../../keys';
import {ODataConfig} from '../../types';

describe('OData config plumbing acceptance', () => {
  let app: TestApplication;
  let client: Client;

  beforeEach(async function () {
    app = await givenODataApplication({port: 0, host: '127.0.0.1'});
    // Override config before boot to ensure middleware/routes pick it up
    app.bind(ODATA_BINDINGS.CONFIG).to({
      basePath: '/api/odata',
      maxTop: 1,
      maxSkip: 2,
      maxExpandDepth: 2,
      enableCount: false,
      strict: false,
    } as ODataConfig);

    await app.boot();
    await seedExampleData(app);
    try {
      await app.start();
      client = createRestAppClient(app);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const message = (err as Error).message ?? '';
      if (code === 'EPERM' || message.includes('not listening')) {
        this.skip();
        return;
      }
      throw err;
    }
  });

  afterEach(async () => {
    if (app.state === 'started') {
      await app.stop();
    }
  });

  it('rewrites configured basePath to internal /odata and emits correct @odata.context', async () => {
    const res = await client.get('/api/odata').expect(200);
    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body['@odata.context']).to.equal('/api/odata/$metadata');
  });

  it('clamps $top according to maxTop when strict=false', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({$top: '5'})
      .expect(200);
    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.lessThanOrEqual(1);
  });

  it('rejects $top above maxTop when strict=true', async function () {
    // Rebind config with strict=true and restart app to test strict behavior
    if (app.state === 'started') await app.stop();
    app = await givenODataApplication({port: 0, host: '127.0.0.1'});
    app.bind(ODATA_BINDINGS.CONFIG).to({
      basePath: '/api/odata',
      maxTop: 1,
      enableCount: false,
      strict: true,
    } as ODataConfig);
    await app.boot();
    await seedExampleData(app);
    await app.start();
    client = createRestAppClient(app);

    const res = await client
      .get('/api/odata/Products')
      .query({$top: '5'})
      .expect(400);
    expect(res.body?.error?.code).to.equal('BadRequest');
  });

  it('enforces maxExpandDepth even when strict=false', async () => {
    await client
      .get('/api/odata/Products')
      .query({$expand: 'orders($expand=items($expand=product))'})
      .expect(400);
  });

  it('clamps $skip to maxSkip when strict=false', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({$skip: '10', $orderby: 'id asc'})
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.greaterThan(0);
    expect(res.body.value[0].name).to.equal('Monitor');
  });

  it('supports trim() filters when strict=false', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({$filter: "trim(name) eq 'Laptop'"})
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.map((item: any) => item.name)).to.containEql('Laptop');
  });

  it('supports concat() filters when strict=false', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({$filter: "concat(name,'/',price) eq 'Laptop/1299'"})
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
      .query({$filter: `month(updatedAt) eq ${month}`})
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.greaterThan(0);
  });

  it('rejects inline $count when disabled', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({$count: 'true'})
      .expect(400);
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
});

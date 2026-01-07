/// <reference path="../../types/testing.globals.d.ts" />

import { Client, createRestAppClient, expect } from '@loopback/testlab';
import {
  TestApplication,
  givenODataApplication,
  seedExampleData,
} from '../fixtures/odata-app.fixture';
import { ODATA_BINDINGS } from '../../keys';
import { ODataConfig } from '../../types';

describe('OData strict mode acceptance', () => {
  let app: TestApplication;
  let client: Client;

  beforeEach(async function () {
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const baseConfig = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...baseConfig,
      basePath: '/odata',
      strict: true,
    });
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
    if (app.state === 'started') await app.stop();
  });

  it('accepts supported $ query options such as $levels', async () => {
    await client.get('/odata/Orders').query({ $expand: 'items($levels=2)' }).expect(200);
  });

  it('rejects unknown properties in $select/$orderby/$filter', async () => {
    await client.get('/odata/Products').query({ $select: 'doesNotExist' }).expect(400);
    await client.get('/odata/Products').query({ $orderby: 'doesNotExist desc' }).expect(400);
    await client.get('/odata/Products').query({ $filter: 'doesNotExist eq 1' }).expect(400);
  });

  it('enforces Accept header for JSON on CRUD endpoints', async () => {
    const res = await client.get('/odata/Products').set('Accept', 'text/plain').expect(406);
    expect(res.body?.error?.code).to.equal('NotAcceptable');
  });

  it('enforces JSON Content-Type on write endpoints', async () => {
    const res = await client
      .post('/odata/Products')
      .set('Content-Type', 'text/plain')
      .send('name=Bad')
      .expect(415);
    expect(res.body?.error?.code).to.equal('UnsupportedMediaType');
  });

  it('enforces Accept header for $metadata content', async () => {
    const res = await client.get('/odata/$metadata').set('Accept', 'application/json').expect(406);
    expect(res.body?.error?.code).to.equal('NotAcceptable');
  });

  it('allows media requests when Accept matches stored content type', async () => {
    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = listing.body.value[0];
    await client
      .get(`/odata/MediaAssets(${asset.id})/$value`)
      .set('Accept', asset['@odata.mediaContentType'])
      .expect(200);
  });

  it('rejects media requests when Accept excludes stored content type', async () => {
    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = listing.body.value[0];
    const res = await client
      .get(`/odata/MediaAssets(${asset.id})/$value`)
      .set('Accept', 'image/png')
      .expect(406);
    expect(res.body?.error?.code).to.equal('NotAcceptable');
  });

  it('rejects conditional media requests when Accept header is incompatible', async () => {
    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = listing.body.value[0];
    const res = await client
      .get(`/odata/MediaAssets(${asset.id})/$value`)
      .set('If-None-Match', asset['@odata.mediaEtag'])
      .set('Accept', 'image/png')
      .expect(406);
    expect(res.body?.error?.code).to.equal('NotAcceptable');
  });

  it('rejects $value PUT return=representation responses when Accept excludes JSON', async () => {
    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = listing.body.value[0];
    const res = await client
      .put(`/odata/MediaAssets(${asset.id})/$value`)
      .set('Content-Type', 'text/plain')
      .set('Accept', 'text/plain')
      .set('Prefer', 'return=representation')
      .set('If-Match', asset['@odata.mediaEtag'])
      .send('Updated spec sheet')
      .expect(406);
    expect(res.body?.error?.code).to.equal('NotAcceptable');
  });

  it('rejects delete return=representation responses when Accept excludes JSON', async () => {
    const created = await client
      .post('/odata/Products')
      .send({ name: 'Strict Delete Device', price: 42 })
      .expect(201);
    const productId = created.body.id;
    const etag = created.headers['etag'] as string;

    const res = await client
      .del(`/odata/Products(${productId})`)
      .set('Prefer', 'return=representation')
      .set('Accept', 'text/plain')
      .set('If-Match', etag)
      .expect(406);
    expect(res.body?.error?.code).to.equal('NotAcceptable');

    await client.del(`/odata/Products(${productId})`).set('If-Match', etag).expect(204);
  });

  it('rejects $expand deeper than maxExpandDepth', async function () {
    if (app.state === 'started') await app.stop();
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const baseConfig = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...baseConfig,
      basePath: '/odata',
      strict: true,
      maxExpandDepth: 2,
    });
    await app.boot();
    await seedExampleData(app);
    await app.start();
    client = createRestAppClient(app);

    // Depth 3: orders -> items -> product
    await client
      .get('/odata/Products')
      .query({ $expand: 'orders($expand=items($expand=product))' })
      .expect(400);
  });

  it('rejects $skip greater than maxSkip', async function () {
    if (app.state === 'started') await app.stop();
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const baseConfig = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...baseConfig,
      basePath: '/odata',
      strict: true,
      maxSkip: 5,
    });
    await app.boot();
    await seedExampleData(app);
    await app.start();
    client = createRestAppClient(app);

    await client.get('/odata/Products').query({ $skip: '100' }).expect(400);
  });

  it('rejects trim() filters in strict mode', async () => {
    await client.get('/odata/Products').query({ $filter: "trim(name) eq 'Laptop'" }).expect(400);
  });

  it('rejects month() filters in strict mode', async () => {
    await client.get('/odata/Products').query({ $filter: 'month(updatedAt) eq 1' }).expect(400);
  });

  it('rejects hasMany navigation filters outside lambdas even after post-filter splitting', async () => {
    await client.get('/odata/OrderItems').query({ $filter: "notes/text eq 'foo'" }).expect(400);
  });

  it('rejects mixed root+navigation filters when pushdown is unavailable', async () => {
    const res = await client
      .get('/odata/OrderItems')
      .query({ $filter: 'order/total gt 0 or quantity gt 1' })
      .expect(400);
    expect(res.body?.error?.code).to.equal('navigation-filter-requires-pushdown');
  });

  it('rejects unsupported indexof comparator in strict mode', async function () {
    // default strict app from beforeEach
    await client.get('/odata/Products').query({ $filter: "indexof(name,'Lap') eq 2" }).expect(400);
  });

  it('rejects unsupported substring comparator in strict mode', async function () {
    await client.get('/odata/Products').query({ $filter: "substring(name,1) gt 'A'" }).expect(400);
  });

  it('rejects unsupported length comparator in strict mode', async function () {
    const res = await client
      .get('/odata/Products')
      .query({ $filter: 'length(name) eq 5' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.some((item: { name: string }) => item.name === 'Phone')).to.be.true();
  });
});

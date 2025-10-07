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
      enableCount: false,
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

  it('clamps $top according to maxTop', async () => {
    const res = await client
      .get('/api/odata/Products')
      .query({$top: '5'})
      .expect(200);
    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.lessThanOrEqual(1);
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


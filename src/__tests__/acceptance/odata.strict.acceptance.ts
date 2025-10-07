/// <reference path="../../types/testing.globals.d.ts" />

import {Client, createRestAppClient, expect} from '@loopback/testlab';
import {TestApplication, givenODataApplication, seedExampleData} from '../fixtures/odata-app.fixture';
import {ODATA_BINDINGS} from '../../keys';
import {ODataConfig} from '../../types';

describe('OData strict mode acceptance', () => {
  let app: TestApplication;
  let client: Client;

  beforeEach(async function () {
    app = await givenODataApplication({port: 0, host: '127.0.0.1'});
    app.bind(ODATA_BINDINGS.CONFIG).to({
      basePath: '/odata',
      strict: true,
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
    if (app.state === 'started') await app.stop();
  });

  it('rejects unknown $ query options', async () => {
    const res = await client.get('/odata/Products').query({$levels: '2'} as any).expect(400);
    expect(res.body?.error?.code).to.equal('BadRequest');
    expect(String(res.body?.error?.message || '')).to.match(/Unsupported query option/i);
  });

  it('rejects unknown properties in $select/$orderby/$filter', async () => {
    await client.get('/odata/Products').query({$select: 'doesNotExist'}).expect(400);
    await client.get('/odata/Products').query({$orderby: 'doesNotExist desc'}).expect(400);
    await client.get('/odata/Products').query({$filter: "doesNotExist eq 1"}).expect(400);
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
});

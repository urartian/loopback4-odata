import {Client, createClientForHandler, expect} from '@loopback/testlab';
import {
  TestApplication,
  givenODataApplication,
  seedExampleData,
} from '../fixtures/odata-app.fixture';

describe('OData component acceptance', () => {
  let app: TestApplication;
  let client: Client;

  beforeEach(async function () {
    app = await givenODataApplication({port: 0, host: '127.0.0.1', listenOnStart: false});
    await app.boot();
    await seedExampleData(app);
    try {
      await app.start();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        this.skip();
        return;
      }
      throw err;
    }
    client = createClientForHandler(app.requestHandler);
  });

  afterEach(async () => {
    if (app.state === 'started') {
      await app.stop();
    }
  });

  it('serves product collections with OData metadata', async () => {
    const res = await client.get('/odata/Products').expect(200);
    expect(res.body['@odata.context']).to.match(/Products$/);
    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.not.be.empty();
  });

  it('exposes action/function definitions in $metadata', async () => {
    const res = await client.get('/odata/$metadata').expect(200);
    expect(res.text.includes('<Action Name="discount"')).to.be.true();
    expect(res.text.includes('<Function Name="premiumProducts"')).to.be.true();
  });

  it('invokes bound actions through generated routes', async () => {
    const products = await client.get('/odata/Products').expect(200);
    const firstId = products.body.value[0].id;
    const response = await client
      .post(`/odata/Products(${firstId})/discount`)
      .send({percent: 10})
      .expect(200);

    expect(response.body.value.price).to.be.a.Number();
    expect(response.body['@odata.context']).to.match(/Products$/);
  });
});

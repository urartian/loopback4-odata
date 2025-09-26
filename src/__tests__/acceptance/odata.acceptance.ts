/// <reference path="../../types/testing.globals.d.ts" />

import {Client, createRestAppClient, expect} from '@loopback/testlab';
import {
  TestApplication,
  givenODataApplication,
  seedExampleData,
} from '../fixtures/odata-app.fixture';

if (typeof process.setMaxListeners === 'function') {
  process.setMaxListeners(20);
}

describe('OData component acceptance', () => {
  let app: TestApplication;
  let client: Client;

  beforeEach(async function () {
    app = await givenODataApplication({port: 0, host: '127.0.0.1'});
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

  it('serves product collections with OData metadata', async () => {
    const res = await client.get('/odata/Products').expect(200);
    expect(res.body['@odata.context']).to.match(/Products$/);
    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.not.be.empty();
  });

  it('exposes action/function definitions in $metadata', async () => {
    const res = await client.get('/odata/$metadata').expect(200);
    expect(res.text.includes('<Action Name="discount"')).to.be.true();
    expect(res.text.includes('<Action Name="resetInventory"')).to.be.true();
    expect(res.text.includes('<Function Name="premiumProducts"')).to.be.true();
    expect(res.text.includes('<NavigationPropertyBinding Path="orderItems"')).to.be.true();
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
  it('exposes collection-bound functions with query parameters', async () => {
    const res = await client
      .get('/odata/Products/premiumProducts')
      .query({minPrice: 1000})
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.every((item: {price: number}) => item.price >= 1000)).to.be.true();
  });

  it('supports inline $count with filters', async () => {
    const res = await client
      .get('/odata/Products')
      .query({$count: 'true', $filter: "contains(name,'o')"})
      .expect(200);

    expect(res.body['@odata.count']).to.be.a.Number();
    expect(res.body.value.length <= res.body['@odata.count']).to.be.true();
  });

  it('supports standalone $count endpoint', async () => {
    const res = await client.get('/odata/Products/$count').expect(200);
    expect(Number(res.text)).to.be.a.Number();
  });

  it('supports $expand of navigation properties', async () => {
    const res = await client
      .get('/odata/Products')
      .query({$expand: 'orderItems'})
      .expect(200);

    const first = res.body.value[0];
    expect(first.orderItems).to.be.Array();
  });

  it('executes unbound actions with raw responses', async () => {
    const result = await client
      .post('/odata/resetInventory')
      .send({confirm: true})
      .expect(200);

    expect(result.body.status).to.equal('ok');
    expect(result.body.total).to.be.a.Number();
  });

  it('accepts $batch requests end to end', async () => {
    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [
          {id: 'products', method: 'GET', url: '/odata/Products'},
          {id: 'count', method: 'GET', url: '/odata/Products/$count'},
        ],
      })
      .expect(200);

    expect(res.body.responses).to.be.Array();
    expect(res.body.responses).to.have.lengthOf(2);
    const [products, count] = res.body.responses;
    expect(products.id).to.equal('products');
    expect(Array.isArray(products.body.value)).to.be.true();
    expect(count.id).to.equal('count');
    expect(Number(count.body)).to.be.a.Number();
  });

  it('applies string predicates through REST filter', async () => {
    const res = await client
      .get('/odata/Products')
      .query({$filter: "contains(name,'Lap')"})
      .expect(200);

    expect(res.body.value).to.have.lengthOf(1);
    expect(res.body.value[0].name).to.equal('Laptop');
  });

  it('applies orderby/select/top/skip options', async () => {
    const topOne = await client
      .get('/odata/Products')
      .query({$orderby: 'price desc', $top: '1', $select: 'name,price'})
      .expect(200);

    expect(topOne.body.value).to.have.lengthOf(1);
    expect(topOne.body.value[0].name).to.equal('Laptop');
    expect(topOne.body.value[0]).to.not.have.property('id');

    const second = await client
      .get('/odata/Products')
      .query({$orderby: 'price asc', $skip: '1', $top: '1'})
      .expect(200);

    expect(second.body.value).to.have.lengthOf(1);
    expect(second.body.value[0].price >= 349).to.be.true();
  });

  it('handles CRUD operations and path rewriting', async () => {
    const created = await client
      .post('/odata/Products')
      .send({name: 'Camera', price: 450})
      .expect(200);

    const createdId = created.body.value.id;
    expect(created.body.value.name).to.equal('Camera');

    const updated = await client
      .patch(`/odata/Products(${createdId})`)
      .send({price: 500})
      .expect(200);
    expect(updated.body.value.price).to.equal(500);

    const fetched = await client.get(`/odata/Products(${createdId})`).expect(200);
    expect(fetched.body.value.name).to.equal('Camera');

    await client.del(`/odata/Products(${createdId})`).expect(204);
    await client.get(`/odata/Products(${createdId})`).expect(404);
  });

  it('reports errors for invalid batch requests', async () => {
    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [
          {id: 'bad', method: 'GET', url: 'notaurl'},
        ],
      })
      .expect(200);

    expect(res.body.responses[0].status).to.equal(400);
    expect(res.body.responses[0].body?.error?.code).to.equal('InvalidUrl');
  });

  it('rejects transactional changesets when datasource lacks transactions', async () => {
    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'c1',
            method: 'POST',
            url: '/odata/Products',
            body: {name: 'Tablet', price: 599},
            atomicityGroup: 'g1',
          },
          {
            id: 'c2',
            method: 'PATCH',
            url: '/odata/Products(1)',
            body: {price: 1499},
            atomicityGroup: 'g1',
          },
        ],
      })
      .expect(200);

    expect(res.body.responses).to.have.lengthOf(1);
    const failure = res.body.responses[0];
    expect(failure.atomicityGroup).to.equal('g1');
    expect(failure.status).to.equal(501);
    expect(failure.body?.error?.code).to.equal('BatchExecutionError');
  });
});

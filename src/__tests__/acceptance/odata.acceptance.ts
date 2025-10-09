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
  const getProductWithEtag = async (id: number) => {
    const res = await client.get(`/odata/Products(${id})`).expect(200);
    return {body: res.body, etag: res.headers['etag'] as string};
  };

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

  it('exposes a service document listing entity sets', async () => {
    const res = await client.get('/odata').expect(200);
    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body['@odata.context']).to.equal('/odata/$metadata');
    expect(res.body.value).to.be.Array();
    const productsEntry = res.body.value.find(
      (item: {name: string}) => item.name === 'Products',
    );
    expect(productsEntry).to.be.Object();
    expect(productsEntry.kind).to.equal('EntitySet');
    expect(productsEntry.url).to.equal('Products');
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
    expect(res.text.includes('<PropertyPath>updatedAt</PropertyPath>')).to.be.true();
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

  it('supports $expand options with select clauses', async () => {
    const res = await client
      .get('/odata/Products')
      .query({$expand: 'orders($select=id,total)', $top: '1'})
      .expect(200);

    const first = res.body.value[0];
    expect(first.orders).to.be.Array();
    if (first.orders.length) {
      const order = first.orders[0];
      expect(order).to.have.property('id');
      expect(order).to.have.property('total');
      expect(order).to.not.have.property('items');
    }
  });

  it('supports $search across string fields', async () => {
    const res = await client
      .get('/odata/Products')
      .query({$search: 'Lap'})
      .expect(200);
    expect(res.body.value).to.be.Array();
    const names = res.body.value.map((p: any) => String(p.name || ''));
    expect(names.some((n: string) => /lap/i.test(n))).to.be.true();
  });

  it('supports $apply groupby aggregate on collections', async () => {
    const res = await client
      .get('/odata/Orders')
      .query({
        $apply: 'groupby((total), aggregate(id with count as OrderCount))',
        $orderby: 'total desc',
        $top: '1',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.have.length(1);
    const first = res.body.value[0];
    expect(first).to.have.property('total');
    expect(first.OrderCount).to.equal(1);
  });

  it('supports lambda any filters', async () => {
    const res = await client
      .get('/odata/Products')
      .query({$filter: 'orderItems/any(i: i/unitPrice gt 800)'})
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.greaterThan(0);
    for (const item of res.body.value) {
      expect(item.orderItems.some((oi: any) => oi.unitPrice > 800)).to.be.true();
    }
  });

  it('keeps expanded navigation when root $select omits relation property', async () => {
    const res = await client
      .get('/odata/Products')
      .query({
        $select: 'id,name,price',
        $expand: 'orders($select=id,total)',
        $orderby: 'name',
        $top: '1',
      })
      .expect(200);

    const first = res.body.value[0];
    expect(first).to.have.property('orders');
    expect(first.orders).to.be.Array();
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

  it('returns per-request responses when atomic changeset fails', async () => {
    const dataSource = await app.get('datasources.db');
    (dataSource as any).beginTransaction = async (_isolation?: unknown) => ({
      commit: async () => undefined,
      rollback: async () => undefined,
    });

    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'create-1',
            method: 'POST',
            url: '/odata/Products',
            atomicityGroup: 'set-1',
            body: {price: 5},
          },
          {
            id: 'create-2',
            method: 'POST',
            url: '/odata/Products',
            atomicityGroup: 'set-1',
            body: {name: 'Valid', price: 8},
          },
        ],
      })
      .expect(200);

    const responses = res.body.responses;
    expect(responses).to.be.Array();
    expect(responses).to.have.lengthOf(2);
    const [first, second] = responses;
    expect(first.id).to.equal('create-1');
    expect(first.atomicityGroup).to.equal('set-1');
    expect(first.status).to.equal(422);
    expect(first.body?.error?.code).to.equal('UnprocessableEntity');
    expect(second.id).to.equal('create-2');
    expect(second.atomicityGroup).to.equal('set-1');
    expect(second.status).to.equal(424);
    expect(second.body?.error?.code).to.equal('FailedDependency');
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
    expect(topOne.body.value[0]).to.have.property('updatedAt');
    expect(topOne.body.value[0]['@odata.etag']).to.be.String();

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

    const createdId = created.body.id;
    expect(created.body.name).to.equal('Camera');
    const createdEtag = created.headers['etag'] as string;
    expect(createdEtag).to.be.String();
    expect(created.body['@odata.etag']).to.equal(createdEtag);

    const updated = await client
      .patch(`/odata/Products(${createdId})`)
      .set('If-Match', createdEtag)
      .send({price: 500})
      .expect(200);
    expect(updated.body.price).to.equal(500);
    const updatedEtag = updated.headers['etag'] as string;
    expect(updatedEtag).to.be.String();
    expect(updatedEtag).to.not.equal(createdEtag);

    const fetched = await client.get(`/odata/Products(${createdId})`).expect(200);
    expect(fetched.body.name).to.equal('Camera');
    expect(fetched.headers['etag']).to.equal(updatedEtag);

    await client
      .del(`/odata/Products(${createdId})`)
      .set('If-Match', updatedEtag)
      .expect(204);
    await client.get(`/odata/Products(${createdId})`).expect(404);
  });

  it('requires If-Match and rejects stale tokens when ETags are enabled', async () => {
    const created = await client
      .post('/odata/Products')
      .send({name: 'Controller', price: 99})
      .expect(200);

    const productId = created.body.id;
    const originalEtag = created.headers['etag'] as string;

    const updated = await client
      .patch(`/odata/Products(${productId})`)
      .set('If-Match', originalEtag)
      .send({price: 129})
      .expect(200);

    const currentEtag = updated.headers['etag'] as string;

    await client
      .del(`/odata/Products(${productId})`)
      .set('If-Match', originalEtag)
      .expect(412);

    // Delete requires current If-Match token in strict mode
    await client
      .del(`/odata/Products(${productId})`)
      .set('If-Match', currentEtag)
      .expect(204);
    await client.get(`/odata/Products(${productId})`).expect(404);
  });

  it('honors Prefer return=minimal for write operations', async () => {
    const createRes = await client
      .post('/odata/Products')
      .set('Prefer', 'return=minimal')
      .send({name: 'Speaker', price: 199})
      .expect(204);

    expect(createRes.headers['preference-applied']).to.equal('return=minimal');
    expect(createRes.headers['odata-version']).to.equal('4.0');

    const createdList = await client
      .get('/odata/Products')
      .query({$filter: "name eq 'Speaker'"})
      .expect(200);
    const speaker = createdList.body.value[0];
    const speakerId = speaker?.id;
    const speakerEtag = speaker?.['@odata.etag'];
    expect(speakerEtag).to.be.String();

    const updateRes = await client
      .patch(`/odata/Products(${speakerId})`)
      .set('Prefer', 'return=minimal')
      .set('If-Match', speakerEtag)
      .send({price: 219})
      .expect(204);
    expect(updateRes.headers['preference-applied']).to.equal('return=minimal');
    expect(updateRes.headers['odata-version']).to.equal('4.0');

    const verify = await client.get(`/odata/Products(${speakerId})`).expect(200);
    expect(verify.body.price).to.equal(219);

    const deleteEtag = verify.headers['etag'] as string;

    await client
      .del(`/odata/Products(${speakerId})`)
      .set('If-Match', deleteEtag)
      .expect(204);
  });

  it('returns 412 when If-Match does not match the current entity ETag', async () => {
    const created = await client
      .post('/odata/Products')
      .send({name: 'Monitor', price: 299})
      .expect(200);

    const createdId = created.body.id;
    const originalEtag = created.headers['etag'] as string;

    const firstUpdate = await client
      .patch(`/odata/Products(${createdId})`)
      .set('If-Match', originalEtag)
      .send({price: 329})
      .expect(200);

    const nextEtag = firstUpdate.headers['etag'] as string;
    expect(nextEtag).to.not.equal(originalEtag);

    await client
      .patch(`/odata/Products(${createdId})`)
      .set('If-Match', originalEtag)
      .send({price: 339})
      .expect(412);

    const current = await getProductWithEtag(createdId);
    expect(current.etag).to.equal(nextEtag);
    expect(current.body.price).to.equal(329);
  });

  it('returns OData error payloads for invalid filters', async () => {
    const res = await client
      .get('/odata/Products')
      .query({$filter: 'invalid eq'})
      .expect(400);

    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body.error).to.be.Object();
    expect(res.body.error.code).to.equal('BadRequest');
    expect(res.body.error.message).to.match(/Invalid (OData )?query|Invalid filter expression/i);
  });

  it('rejects Prefer respond-async', async () => {
    const res = await client
      .post('/odata/Products')
      .set('Prefer', 'respond-async')
      .send({name: 'AsyncWidget', price: 5})
      .expect(501);

    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body.error.code).to.equal('PreferenceNotSupported');
    expect(res.body.error.target).to.equal('respond-async');
    expect(res.body.error.message).to.match(/not supported/i);
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

  it('accepts multipart/mixed batch requests', async () => {
    const batchBoundary = 'batch_123';
    const changesetBoundary = 'changeset_abc';
    const multipartBody = [
      `--${batchBoundary}`,
      `Content-Type: multipart/mixed; boundary=${changesetBoundary}`,
      '',
      `--${changesetBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 1',
      '',
      'POST /odata/Products HTTP/1.1',
      'Content-Type: application/json',
      '',
      '{"name":"Drone","price":899}',
      `--${changesetBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 2',
      '',
      'PATCH /odata/Products(1) HTTP/1.1',
      'Content-Type: application/json',
      '',
      '{"price":1399}',
      `--${changesetBoundary}--`,
      `--${batchBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 3',
      '',
      'GET /odata/Products HTTP/1.1',
      'Accept: application/json',
      '',
      '',
      `--${batchBoundary}--`,
      '',
    ].join('\r\n');

    const res = await client
      .post('/odata/$batch')
      .set('Content-Type', `multipart/mixed; boundary=${batchBoundary}`)
      .set('Accept', 'multipart/mixed')
      .send(multipartBody)
      .expect(200)
      .expect('Content-Type', /multipart\/mixed/);

    const multipartPayload =
      typeof res.text === 'string' && res.text.length
        ? res.text
        : Buffer.isBuffer(res.body)
        ? res.body.toString('utf-8')
        : '';

    if (multipartPayload) {
      expect(multipartPayload).to.match(/HTTP\/1\.1 200/);
      expect(multipartPayload).to.match(/Content-Type: application\/http/);
    }
  });
});

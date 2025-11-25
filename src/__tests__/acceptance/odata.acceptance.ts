/// <reference path="../../types/testing.globals.d.ts" />

import { Client, createRestAppClient, expect } from '@loopback/testlab';
import { BindingScope } from '@loopback/core';
import { AnyObject, juggler } from '@loopback/repository';
import {
  TestApplication,
  givenODataApplication,
  seedExampleData,
  registerODataOnlyModels,
} from '../fixtures/odata-app.fixture';
import { ODATA_BINDINGS } from '../../keys';
import { ODataConfig } from '../../types';
import { EntitySetRegistry } from '../../registry/entityset-registry';
import {
  ODataApplyExecutorRegistry,
  ODataApplyExecutor,
  ODataApplyExecutorContext,
} from '../../services/odata-apply-executor.registry';

if (typeof process.setMaxListeners === 'function') {
  process.setMaxListeners(20);
}

describe('OData component acceptance', () => {
  let app: TestApplication;
  let client: Client;

  type SkipContext = { skip: () => void };

  const startOrSkip = async (mochaCtx: SkipContext) => {
    try {
      await app.start();
      client = createRestAppClient(app);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const message = (err as Error).message ?? '';
      if (code === 'EPERM' || message.includes('not listening')) {
        mochaCtx.skip();
        return;
      }
      throw err;
    }
  };

  const rebuildApp = async (
    mochaCtx: SkipContext,
    overrides: Partial<ODataConfig> = {},
    configure?: (instance: TestApplication) => Promise<void> | void,
  ) => {
    if (app?.state === 'started') {
      await app.stop();
    }
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const baseConfig = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...baseConfig,
      ...overrides,
    });
    if (configure) {
      await configure(app);
    }
    await app.boot();
    await seedExampleData(app);
    await startOrSkip(mochaCtx);
  };

  const enableProductsDelta = async (target: TestApplication) => {
    const registry = await target.get<EntitySetRegistry>(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const def = registry.findByName('Products');
    if (def) {
      def.deltaEnabled = true;
      def.deltaField = def.deltaField ?? 'updatedAt';
    }
  };

  const getProductWithEtag = async (id: number) => {
    const res = await client.get(`/odata/Products(${id})`).expect(200);
    return { body: res.body, etag: res.headers['etag'] as string };
  };

  beforeEach(async function () {
    await rebuildApp(this as SkipContext);
  });

  it('supports multi-segment lambda navigation paths', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $filter: 'orders/items/any(i: i/quantity gt 2)' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    const names = res.body.value.map((item: any) => item.name);
    expect(names).to.containEql('Monitor');
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
    const productsEntry = res.body.value.find((item: { name: string }) => item.name === 'Products');
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

  it('serializes DateTimeOffset properties using ISO 8601 format', async () => {
    const res = await client.get('/odata/Products').expect(200);
    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.not.be.empty();
    const sample = res.body.value[0];
    expect(sample).to.have.property('updatedAt');
    expect(sample.updatedAt).to.be.a.String();
    expect(sample.updatedAt).to.match(/T/);
    expect(sample.updatedAt).to.match(/(Z|[+-]\d{2}:\d{2})$/);
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
      .send({ percent: 10 })
      .expect(200);

    expect(response.body.value.price).to.be.a.Number();
    expect(response.body['@odata.context']).to.match(/Products$/);
  });
  it('exposes collection-bound functions with query parameters', async () => {
    const res = await client
      .get('/odata/Products/premiumProducts')
      .query({ minPrice: 1000 })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.every((item: { price: number }) => item.price >= 1000)).to.be.true();
  });

  it('invokes collection-bound functions using canonical syntax', async () => {
    const res = await client
      .get('/odata/Products/Default.premiumProducts(minPrice=1000)')
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.every((item: { price: number }) => item.price >= 1000)).to.be.true();
  });

  it('supports inline $count with filters', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $count: 'true', $filter: "contains(name,'o')" })
      .expect(200);

    expect(res.body['@odata.count']).to.be.a.Number();
    expect(res.body.value.length <= res.body['@odata.count']).to.be.true();
  });

  it('supports filtering on structured properties', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $filter: 'dimensions/width gt 300' })
      .expect(200);

    const names = res.body.value.map((item: AnyObject) => item.name);
    expect(names).to.containEql('Laptop');
    expect(names).to.containEql('Monitor');
  });

  it('allows selecting structured properties without enumerating children', async () => {
    const res = await client.get('/odata/Products').query({ $select: 'id,dimensions' }).expect(200);

    expect(res.body.value).to.be.Array();
    expect(
      res.body.value.every(
        (item: AnyObject) => item.dimensions && typeof item.dimensions === 'object',
      ),
    ).to.be.true();
  });

  it('returns @odata.nextLink with $skiptoken for server-driven paging', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 2,
    });

    const first = await client.get('/odata/Products').expect(200);
    expect(first.body.value).to.be.Array();
    expect(first.body.value.length).to.be.lessThanOrEqual(2);
    const nextLink = first.body['@odata.nextLink'];
    expect(nextLink).to.be.a.String();
    const decodedLink = decodeURIComponent(String(nextLink));
    expect(decodedLink).to.match(/\$skiptoken=/);

    const second = await client.get(String(nextLink)).expect(200);
    expect(second.body.value).to.be.Array();
    expect(second.body.value).to.not.be.empty();
    expect(second.body.value.every((item: AnyObject) => item != null)).to.be.true();
    const firstIds = first.body.value.map((item: AnyObject) => item.id);
    const secondIds = second.body.value.map((item: AnyObject) => item.id);
    expect(secondIds.some((id: number) => !firstIds.includes(id))).to.be.true();
  });

  it('creates related entities for @odataModel-only definitions', async function (this: SkipContext) {
    await rebuildApp(this, {}, async (instance: TestApplication) => {
      registerODataOnlyModels(instance);
    });

    const incident = await client
      .post('/odata/OdataOnlyIncidents')
      .send({ title: 'New incident' })
      .expect(201);
    const incidentId = incident.body.id;
    expect(incidentId).to.be.a.String();
    expect(incident.headers['location']).to.be.String();
    expect(incident.headers['odata-entityid']).to.equal(incident.headers['location']);

    const conversation = await client
      .post('/odata/OdataOnlyConversations')
      .send({ message: 'First reply', incidentId })
      .expect(201);
    expect(conversation.body.incidentId).to.equal(incidentId);

    const spec = await client.get('/openapi.json').expect(200);
    expect(JSON.stringify(spec.body)).to.not.match(/components\/schemas\/undefined/);
  });

  it('rejects invalid $skiptoken values', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 2,
    });

    await client.get('/odata/Products').expect(200); // ensure controller initialization
    await client.get('/odata/Products?$skiptoken=invalid-token').expect(400);
  });

  it('rejects tampered $skiptoken payloads', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 2,
    });

    const first = await client.get('/odata/Products').expect(200);
    const nextLink = String(first.body['@odata.nextLink']);
    const nextUrl = new URL(nextLink, 'http://localhost');
    const original = nextUrl.searchParams.get('$skiptoken');
    expect(original).to.be.String();
    if (!original) {
      throw new Error('Expected $skiptoken in next link.');
    }
    const tampered = original.charAt(0) === 'A' ? `B${original.slice(1)}` : `A${original.slice(1)}`;
    nextUrl.searchParams.set('$skiptoken', tampered);

    await client.get(`${nextUrl.pathname}?${nextUrl.searchParams.toString()}`).expect(400);
  });

  it('fails when tokenSecret is missing while issuing $skiptoken values', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      tokenSecret: undefined,
      pageSize: 2,
    });

    const res = await client.get('/odata/Products').expect(500);
    expect(res.body?.error?.message).to.match(/tokenSecret must be configured/i);

    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
    });
  });

  it('expires $skiptoken after configured TTL', async function (this: Mocha.Context) {
    this.timeout(5000);
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      tokenSecret: 'ttl-secret',
      pageSize: 1,
      skipTokenTtl: 1,
    });

    const first = await client.get('/odata/Products').expect(200);
    const nextLink = String(first.body['@odata.nextLink']);
    expect(nextLink).to.match(/(%24|\$)skiptoken=/);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    await client.get(nextLink).expect(400);

    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
    });
  });

  it('treats $skip/$top requests as manual paging and clamps the slice', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 1,
    });

    const first = await client.get('/odata/Products').query({ $skip: '0', $top: '5' }).expect(200);
    expect(first.body.value).to.have.length(1);
    expect(first.body['@odata.nextLink']).to.be.undefined();

    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
    });
  });

  it('continues emitting @odata.nextLink when $skip lacks $top', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 1,
    });

    const serverDriven = await client.get('/odata/Products').query({ $skip: '0' }).expect(200);
    expect(serverDriven.body.value).to.have.length(1);
    expect(serverDriven.body['@odata.nextLink']).to.match(/(%24|\$)skiptoken=/);

    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
    });
  });

  it('preserves client $top for $skip=0 and enforces deterministic manual paging', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 2,
    });

    const premiumOne = await client
      .post('/odata/Products')
      .send({ name: 'Premium One', price: 9000 })
      .expect(201);
    const premiumTwo = await client
      .post('/odata/Products')
      .send({ name: 'Premium Two', price: 9000 })
      .expect(201);

    const first = await client
      .get('/odata/Products')
      .query({ $orderby: 'price desc', $skip: '0', $top: '2', $select: 'id,price' })
      .expect(200);

    expect(first.body.value).to.have.length(2);
    expect(first.body.value[0].price).to.equal(9000);
    expect(first.body.value[1].price).to.equal(9000);
    expect(first.body.value.map((item: AnyObject) => item.id)).to.eql([
      premiumOne.body.id,
      premiumTwo.body.id,
    ]);

    const third = await client
      .get('/odata/Products')
      .query({ $orderby: 'price desc', $skip: '2', $top: '1', $select: 'id,price' })
      .expect(200);

    expect(third.body.value).to.have.length(1);
    expect(third.body.value[0].price).to.be.below(9000);

    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
    });
  });

  it('clamps manual $top to pagination guardrails', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 10,
      strict: false,
      pagination: {
        ...(current.pagination ?? {}),
        maxTop: 2,
      },
    });

    const res = await client
      .get('/odata/Products')
      .query({ $skip: '0', $top: '1000', $orderby: 'id asc', $select: 'id' })
      .expect(200);

    expect(res.body.value).to.have.length(2);
    expect(res.body['@odata.nextLink']).to.be.undefined();

    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
    });
  });

  it('honors $format=json even when Accept header excludes JSON', async () => {
    const res = await client
      .get('/odata/Products')
      .set('Accept', 'text/plain')
      .query({ $format: 'json' })
      .expect(200);

    expect(res.headers['content-type']).to.match(/application\/json/i);
    expect(res.body.value).to.be.Array();
  });

  it('rejects unsupported $format values', async () => {
    await client.get('/odata/Products').query({ $format: 'application/xml' }).expect(406);
  });

  it('returns @odata.nextLink with $apply pipelines and skiptoken support', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 2,
    });

    const pipeline =
      'groupby((name),aggregate(price with sum as TotalPrice))/orderby(TotalPrice desc)';

    const first = await client.get('/odata/Products').query({ $apply: pipeline }).expect(200);

    expect(first.body.value).to.be.Array();
    expect(first.body.value.length).to.be.lessThanOrEqual(2);
    const firstNames = first.body.value.map((item: AnyObject) => item.name);
    const applyNextLink = first.body['@odata.nextLink'];
    expect(applyNextLink).to.be.a.String();

    const second = await client.get(String(applyNextLink)).expect(200);
    expect(second.body.value).to.be.Array();
    const secondNames = second.body.value.map((item: AnyObject) => item.name);
    expect(secondNames.some((name: string) => !firstNames.includes(name))).to.be.true();
  });

  it('serves $value payloads for scalar properties', async () => {
    const res = await client.get('/odata/Products(1)/name/$value').expect(200);
    expect(res.text).to.equal('Laptop');
    expect(res.headers['content-type']).to.match(/text\/plain/);
  });

  it('returns ISO strings for date $value properties', async () => {
    const entity = await client.get('/odata/Products(1)').expect(200);
    const updatedAt = entity.body.updatedAt;
    expect(updatedAt).to.be.String();

    const res = await client.get('/odata/Products(1)/updatedAt/$value').expect(200);
    expect(res.headers['content-type']).to.match(/text\/plain/);
    expect(res.text).to.equal(new Date(updatedAt).toISOString());
  });

  it('computes derived properties with $compute', async () => {
    const res = await client
      .get('/odata/OrderItems')
      .query({
        $top: '1',
        $compute: 'quantity mul unitPrice as LineTotal',
        $select: 'id,LineTotal',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value[0].LineTotal).to.equal(2598);
  });

  it('returns computed aliases for entity lookups', async () => {
    const res = await client
      .get('/odata/OrderItems(1)')
      .query({ $compute: 'quantity mul unitPrice as LineTotal' })
      .expect(200);

    expect(res.body.LineTotal).to.equal(2598);
  });

  it('rejects $compute combined with $apply pipelines', async () => {
    await client
      .get('/odata/Products')
      .query({
        $apply: 'groupby((name),aggregate(price with sum as TotalPrice))',
        $compute: 'price add 1 as Increased',
      })
      .expect(400);
  });

  it('supports $levels within $expand options', async () => {
    const res = await client
      .get('/odata/Orders')
      .query({ $expand: 'items($levels=2;$expand=product)' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    const first = res.body.value[0];
    expect(first.items).to.be.Array();
    expect(first.items[0].product).to.be.Object();
  });

  it('rejects invalid $skiptoken for $apply pipelines', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      pageSize: 2,
    });

    const pipeline =
      'groupby((name),aggregate(price with sum as TotalPrice))/orderby(TotalPrice desc)';

    await client
      .get('/odata/Products')
      .query({ $apply: pipeline, $skiptoken: 'invalid-token' })
      .expect(400);
  });

  it('returns @odata.deltaLink for entity collections', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, { enableDelta: true, pageSize: 2 });
    const registry = app.getSync(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const productsDef = registry.findByName('Products');
    if (productsDef) {
      productsDef.deltaEnabled = true;
      productsDef.deltaField = productsDef.deltaField ?? 'updatedAt';
    }

    const first = await client.get('/odata/Products').expect(200);
    expect(first.body['@odata.deltaLink']).to.be.String();
    const deltaLink = String(first.body['@odata.deltaLink']);
    expect(decodeURIComponent(deltaLink)).to.match(/\$deltatoken=/);

    const second = await client.get(deltaLink).expect(200);
    expect(second.body['@odata.deltaLink']).to.be.String();
  });

  it('emits tombstones when entities are deleted between delta requests', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, { enableDelta: true, pageSize: 2 });
    const registry = app.getSync(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const productsDef = registry.findByName('Products');
    if (productsDef) {
      productsDef.deltaEnabled = true;
      productsDef.deltaField = productsDef.deltaField ?? 'updatedAt';
    }

    const first = await client.get('/odata/Products').expect(200);
    const deltaLink = String(first.body['@odata.deltaLink']);

    const productRes = await client.get('/odata/Products(1)').expect(200);
    const etag = productRes.headers['etag'] as string;
    await client.del('/odata/Products(1)').set('If-Match', etag).expect(204);

    const delta = await client.get(deltaLink).expect(200);
    const removed = delta.body.value.find((entry: AnyObject) => entry?.['@removed']);
    expect(removed).to.be.Object();
    expect(removed.id).to.equal(1);
    expect(removed['@removed']?.reason).to.equal('deleted');
  });

  it('$apply pipelines emit delta links', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, { enableDelta: true, pageSize: 2 });
    const registry = app.getSync(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const productsDef = registry.findByName('Products');
    if (productsDef) {
      productsDef.deltaEnabled = true;
      productsDef.deltaField = productsDef.deltaField ?? 'updatedAt';
    }

    const pipeline =
      'groupby((name),aggregate(price with sum as TotalPrice))/orderby(TotalPrice desc)';

    const first = await client.get('/odata/Products').query({ $apply: pipeline }).expect(200);

    expect(first.body['@odata.deltaLink']).to.be.String();
    const deltaLink = String(first.body['@odata.deltaLink']);

    const { etag } = await getProductWithEtag(1);
    await client
      .patch('/odata/Products(1)')
      .set('If-Match', etag)
      .send({ price: 1400 })
      .expect(200);

    const delta = await client.get(deltaLink).expect(200);
    expect(delta.body['@odata.deltaLink']).to.be.String();
    const names = delta.body.value.map((entry: AnyObject) => entry.name);
    expect(names).to.containEql('Laptop');
  });

  it('returns aggregated tombstones with snapshot data for $apply delta feeds', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, { enableDelta: true, pageSize: 2 });
    const registry = app.getSync(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const productsDef = registry.findByName('Products');
    if (productsDef) {
      productsDef.deltaEnabled = true;
      productsDef.deltaField = productsDef.deltaField ?? 'updatedAt';
    }

    const pipeline =
      'groupby((name),aggregate(price with sum as TotalPrice))/orderby(TotalPrice desc)';

    const initial = await client.get('/odata/Products').query({ $apply: pipeline }).expect(200);

    const deltaLink = String(initial.body['@odata.deltaLink']);

    const { etag } = await getProductWithEtag(1);
    await client.del('/odata/Products(1)').set('If-Match', etag).expect(204);

    const delta = await client.get(deltaLink).expect(200);
    const tombstone = delta.body.value.find((entry: AnyObject) => entry?.['@removed']);
    expect(tombstone).to.be.Object();
    expect(tombstone.name).to.equal('Laptop');
    expect(tombstone.TotalPrice).to.equal(1299);
    expect(tombstone['@removed']?.reason).to.equal('deleted');
  });

  it('rejects tampered $deltatoken payloads', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, { enableDelta: true, pageSize: 2 });
    const registry = app.getSync(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const productsDef = registry.findByName('Products');
    if (productsDef) {
      productsDef.deltaEnabled = true;
      productsDef.deltaField = productsDef.deltaField ?? 'updatedAt';
    }

    const first = await client.get('/odata/Products').expect(200);
    const deltaLink = String(first.body['@odata.deltaLink']);
    const deltaUrl = new URL(deltaLink, 'http://localhost');
    const original = deltaUrl.searchParams.get('$deltatoken');
    expect(original).to.be.String();
    if (!original) {
      throw new Error('Expected $deltatoken in delta link.');
    }
    const tampered = original.charAt(0) === 'A' ? `B${original.slice(1)}` : `A${original.slice(1)}`;
    deltaUrl.searchParams.set('$deltatoken', tampered);

    await client.get(`${deltaUrl.pathname}?${deltaUrl.searchParams.toString()}`).expect(400);
  });

  it('returns 410 Gone when $deltatoken expires', async function (this: Mocha.Context) {
    this.timeout(6000);
    const events: Array<{ code: string; entitySet: string }> = [];
    await rebuildApp(
      this as SkipContext,
      { enableDelta: true, deltaTokenTtl: 1, onDeltaTokenInvalid: (event) => events.push(event) },
      async (instance) => {
        await enableProductsDelta(instance);
      },
    );

    const first = await client.get('/odata/Products').expect(200);
    const deltaLink = String(first.body['@odata.deltaLink']);
    expect(deltaLink).to.be.String();

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const expired = await client.get(deltaLink).expect(410);
    expect(expired.body?.error?.message).to.match(/expired/i);
    expect(
      events.some((event) => event.code === 'expired' && event.entitySet === 'Products'),
    ).to.be.true();
  });

  it('rejects stale $deltatoken after tokenSecret rotation and emits telemetry', async function (this: Mocha.Context) {
    this.timeout(6000);
    const events: Array<{ code: string; entitySet: string }> = [];
    const capture = (event: { code: string; entitySet: string }) => events.push(event);

    await rebuildApp(
      this as SkipContext,
      { enableDelta: true, onDeltaTokenInvalid: capture },
      async (instance) => {
        await enableProductsDelta(instance);
      },
    );
    const first = await client.get('/odata/Products').expect(200);
    const deltaLink = String(first.body['@odata.deltaLink']);

    await rebuildApp(
      this as SkipContext,
      { enableDelta: true, tokenSecret: 'rotated-secret', onDeltaTokenInvalid: capture },
      async (instance) => {
        await enableProductsDelta(instance);
      },
    );
    const res = await client.get(deltaLink).expect(400);
    expect(res.body?.error?.message).to.match(/Invalid \$deltatoken value/i);
    expect(
      events.some((event) => event.code === 'invalid' && event.entitySet === 'Products'),
    ).to.be.true();
  });

  it('rejects $deltatoken when delta support is disabled', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, { enableDelta: false });
    const registry = app.getSync(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const productsDef = registry.findByName('Products');
    if (productsDef) {
      productsDef.deltaEnabled = false;
    }

    await client.get('/odata/Products?$deltatoken=v1:Zm9v').expect(400);
  });

  it('rejects $deltatoken together with $apply', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, { enableDelta: true });
    const registry = app.getSync(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const productsDef = registry.findByName('Products');
    if (productsDef) {
      productsDef.deltaEnabled = true;
      productsDef.deltaField = productsDef.deltaField ?? 'updatedAt';
    }

    const pipeline = 'groupby((name),aggregate(price with sum as TotalPrice))';

    await client
      .get('/odata/Products')
      .query({ $apply: pipeline, $deltatoken: 'v1:Zm9v' })
      .expect(400);
  });

  it('supports standalone $count endpoint', async () => {
    const res = await client.get('/odata/Products/$count').expect(200);
    expect(Number(res.text)).to.be.a.Number();
  });

  it('supports deep insert for related entities when enabled', async () => {
    const orderId = 9801;
    const createRes = await client
      .post('/odata/Orders')
      .send({
        id: orderId,
        total: 1234,
        items: [
          {
            productId: 1,
            quantity: 2,
            unitPrice: 499,
            notes: [{ text: 'bulk discount requested' }],
          },
          {
            productId: 2,
            quantity: 1,
            unitPrice: 299,
            notes: [{ text: 'gift wrap' }, { text: 'urgent delivery' }],
          },
        ],
      })
      .expect(201);

    expect(createRes.body.id).to.equal(orderId);

    const fetched = await client
      .get(`/odata/Orders(${orderId})`)
      .query({ $expand: 'items($expand=notes)' })
      .expect(200);

    expect(Array.isArray(fetched.body.items)).to.be.true();
    expect(fetched.body.items.length).to.equal(2);
    const itemIds = fetched.body.items.map((item: AnyObject) => item.productId);
    expect(itemIds).to.containEql(1);
    expect(itemIds).to.containEql(2);
    const firstNotes = fetched.body.items[0].notes ?? [];
    const secondNotes = fetched.body.items[1].notes ?? [];
    expect(firstNotes.map((n: AnyObject) => n.text)).to.containEql('bulk discount requested');
    expect(secondNotes.map((n: AnyObject) => n.text)).to.containEql('gift wrap');
    expect(secondNotes.map((n: AnyObject) => n.text)).to.containEql('urgent delivery');
  });

  it('rejects deep insert when collection navigation payload is not an array', async () => {
    const res = await client
      .post('/odata/Orders')
      .send({
        total: 200,
        items: {
          productId: 1,
          quantity: 1,
          unitPrice: 499,
        },
      })
      .expect(422);

    const details = (res.body?.error?.details ?? []) as AnyObject[];
    const hasTypeError = details.some(
      (d: AnyObject) =>
        String(d.path ?? '').includes('/items') &&
        (d.code === 'type' || /must be array/i.test(String(d.message ?? ''))),
    );
    expect(hasTypeError).to.be.true();
  });

  it('supports deep update for related entities when enabled', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, { enableDeepInsert: true, enableDeepUpdate: true });
    const registry = app.getSync(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
    const ordersDef = registry.findByName('Orders');
    if (ordersDef) {
      ordersDef.deepInsert = true;
      ordersDef.deepUpdate = true;
    }
    const orderItemsDef = registry.findByName('OrderItems');
    if (orderItemsDef) {
      orderItemsDef.deepUpdate = true;
    }

    const orderId = 9802;
    await client
      .post('/odata/Orders')
      .send({
        id: orderId,
        total: 500,
        items: [
          {
            productId: 1,
            quantity: 1,
            unitPrice: 499,
            notes: [{ text: 'original note' }],
          },
          {
            productId: 2,
            quantity: 1,
            unitPrice: 299,
          },
        ],
      })
      .expect(201);

    const fetched = await client
      .get(`/odata/Orders(${orderId})`)
      .query({ $expand: 'items($expand=notes)' })
      .expect(200);
    const etag = fetched.headers['etag'] as string | undefined;
    const firstItem = fetched.body.items[0];
    const secondItem = fetched.body.items[1];
    const firstNote = firstItem.notes?.[0];

    // Unlink the second item via navigation $ref endpoint (CAP-style)
    if (secondItem?.id != null) {
      await client.del(`/odata/Orders(${orderId})/items(${secondItem.id})/$ref`).expect(204);
    }

    let patchRequest = client.patch(`/odata/Orders(${orderId})`);
    if (etag) {
      patchRequest = patchRequest.set('If-Match', etag);
    }
    const patchResponse = await patchRequest.send({
      total: fetched.body.total + 200,
      items: [
        {
          id: firstItem.id,
          quantity: firstItem.quantity + 2,
          notes: [
            ...(firstNote ? [{ id: firstNote.id, text: 'updated note' }] : []),
            { text: 'additional note' },
          ],
        },
        {
          productId: 3,
          quantity: 1,
          unitPrice: 799,
          notes: [{ text: 'new line note' }],
        },
      ],
    });

    if (patchResponse.status !== 200) {
      // surface the response for easier debugging when expectations fail
      // eslint-disable-next-line no-console
      console.error(
        'Deep update patch failed',
        patchResponse.status,
        patchResponse.body?.error ?? patchResponse.body,
      );
    }
    expect(patchResponse.status).to.equal(200);

    const updated = await client
      .get(`/odata/Orders(${orderId})`)
      .query({ $expand: 'items($expand=notes)' })
      .expect(200);

    expect(updated.body.total).to.equal(fetched.body.total + 200);
    const updatedItems = updated.body.items as AnyObject[];
    const retained = updatedItems.find((item) => item.productId === firstItem.productId);
    expect(retained).to.be.Object();
    if (!retained) throw new Error('Expected retained line item to be present');
    expect(retained.quantity).to.equal(firstItem.quantity + 2);
    expect(retained.notes.map((n: AnyObject) => n.text)).to.containEql('updated note');
    expect(retained.notes.map((n: AnyObject) => n.text)).to.containEql('additional note');
    expect(updatedItems.some((item) => item.id === secondItem.id)).to.be.false();
    const added = updatedItems.find((item) => item.productId === 3);
    expect(added).to.be.Object();
    if (!added) throw new Error('Expected newly added line item');
    expect(Array.isArray(added.notes)).to.be.true();
    expect(added.notes[0]?.text).to.equal('new line note');
  });

  it('rejects deep update when collection navigation payload is not an array', async () => {
    const newOrder = await client.post('/odata/Orders').send({ total: 0 }).expect(201);

    const orderId = newOrder.body.id;
    const createdItem = await client
      .post(`/odata/OrderItems`)
      .send({ orderId, productId: 1, quantity: 1, unitPrice: 199 })
      .expect(201);

    const fetched = await client
      .get(`/odata/Orders(${orderId})`)
      .query({ $expand: 'items' })
      .expect(200);
    const etag = fetched.headers['etag'] as string | undefined;

    let patchRequest = client.patch(`/odata/Orders(${orderId})`);
    if (etag) patchRequest = patchRequest.set('If-Match', etag);

    const response = await patchRequest
      .send({
        items: {
          id: createdItem.body.id,
          quantity: 2,
        },
      })
      .expect(422);

    const details = (response.body?.error?.details ?? []) as AnyObject[];
    const hasTypeError = details.some(
      (d: AnyObject) =>
        String(d.path ?? '').includes('/items') &&
        (d.code === 'type' || /must be array/i.test(String(d.message ?? ''))),
    );
    expect(hasTypeError).to.be.true();
  });

  it('supports navigation $ref linking of existing entities', async () => {
    const newOrder = await client.post('/odata/Orders').send({ total: 0 }).expect(201);
    const newOrderId = newOrder.body.id;
    expect(newOrderId).to.be.a.Number();

    const orderItemsRes = await client.get('/odata/OrderItems').expect(200);
    const existingItem = orderItemsRes.body.value[0];
    expect(existingItem).to.be.Object();
    const originalOrderId = existingItem.orderId;

    await client
      .post(`/odata/Orders(${newOrderId})/items/$ref`)
      .send({ '@odata.id': `/odata/OrderItems(${existingItem.id})` })
      .expect(204);

    const verifyList = await client.get('/odata/OrderItems').expect(200);
    expect(
      verifyList.body.value.some(
        (item: AnyObject) => item.id === existingItem.id && item.orderId === newOrderId,
      ),
    ).to.be.true();

    // restore link for data consistency
    await client
      .post(`/odata/Orders(${originalOrderId})/items/$ref`)
      .send({ '@odata.id': `/odata/OrderItems(${existingItem.id})` })
      .expect(204);
  });

  it('returns 404 when unlinking a non-existent navigation target', async () => {
    // Create two orders and pick an item from the first
    const orderA = await client.post('/odata/Orders').send({ total: 0 }).expect(201);
    const orderB = await client.post('/odata/Orders').send({ total: 0 }).expect(201);
    const item = await client
      .post('/odata/OrderItems')
      .send({ orderId: orderA.body.id, productId: 1, quantity: 1, unitPrice: 100 })
      .expect(201);

    // Attempt to unlink the item from the second order where it is not linked
    await client.del(`/odata/Orders(${orderB.body.id})/items(${item.body.id})/$ref`).expect(404);
  });

  it('returns 404 when deleting a non-existent entity', async () => {
    await client.del('/odata/OrderItems(99999999)').expect(404);
  });

  it('allows navigation $ref hooks to veto link operations', async () => {
    const orderItemsRes = await client.get('/odata/OrderItems').expect(200);
    const existingItem = orderItemsRes.body.value[0];

    await client
      .post('/odata/Orders(1)/items/$ref')
      .set('x-block-link', 'true')
      .send({ '@odata.id': `/odata/OrderItems(${existingItem.id})` })
      .expect(409);
  });

  it('includes navigation $ref routes in the generated OpenAPI spec', async () => {
    const spec = await app.restServer.getApiSpec();
    expect(spec.paths?.['/odata/Orders/{id}/items/$ref']).to.be.Object();
    expect(spec.paths?.['/odata/Orders/{id}/items/{targetKey}/$ref']).to.be.Object();
  });

  it('supports $expand of navigation properties', async () => {
    const res = await client.get('/odata/Products').query({ $expand: 'orderItems' }).expect(200);

    const first = res.body.value[0];
    expect(first.orderItems).to.be.Array();
  });

  it('supports $expand options with select clauses', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $expand: 'orders($select=id,total)', $top: '1' })
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
    const res = await client.get('/odata/Products').query({ $search: 'Lap' }).expect(200);
    expect(res.body.value).to.be.Array();
    const names = res.body.value.map((p: any) => String(p.name || ''));
    expect(names.some((n: string) => /lap/i.test(n))).to.be.true();
  });

  it('supports boolean operators in $search', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $search: 'coffee AND grinder' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    const names = res.body.value.map((p: any) => String(p.name || ''));
    expect(names).to.containEql('Coffee Grinder');
    expect(names.every((n: string) => /coffee/i.test(n) && /grinder/i.test(n))).to.be.true();
  });

  it('supports quoted phrases and NOT operators in $search', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $search: '"coffee beans" AND NOT decaf' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    const names = res.body.value.map((p: any) => String(p.name || ''));
    expect(names).to.containEql('Coffee Beans');
    expect(names.some((n: string) => /decaf/i.test(n))).to.be.false();
  });

  it('enforces the configured $search term limit', async () => {
    const res = await client
      .get('/odata/Products')
      .query({
        $search: 'espresso OR latte OR cappuccino OR mocha OR macchiato OR ristretto',
      })
      .expect(400);

    expect(res.body.error).to.be.Object();
    expect(res.body.error.code).to.equal('BadRequest');
    expect(res.body.error.message).to.match(/at most 5 terms/i);
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

  it('supports multi-stage $apply pipelines with filter and orderby', async () => {
    const res = await client
      .get('/odata/Orders')
      .query({
        $apply:
          'filter(total gt 2500)/groupby((total), aggregate(id with count as OrderCount))/orderby(OrderCount desc)/top(1)',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.have.length(1);
    const only = res.body.value[0];
    expect(only.total).to.be.a.Number();
    expect(only.total).to.be.greaterThan(2500);
    expect(only.OrderCount).to.equal(1);
  });

  it('supports multi-stage $apply pipelines with successive aggregate stages', async () => {
    const res = await client
      .get('/odata/Orders')
      .query({
        $apply:
          'groupby((total), aggregate(id with count as OrderCount))/aggregate(OrderCount with sum as OverallCount)',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.have.length(1);
    const first = res.body.value[0];
    expect(first.OverallCount).to.be.a.Number();
    expect(first.OverallCount).to.be.greaterThan(0);
  });

  it('executes non-aggregate $apply pipelines with filter and top stages', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $apply: 'filter(price gt 200)/top(2)' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.lessThanOrEqual(2);
    expect(res.body.value.every((item: any) => item.price > 200)).to.be.true();
  });

  it('supports $apply pipelines that use concat transformations', async () => {
    const pipeline =
      'concat(aggregate(quantity with sum as TotalQuantity),groupby((product/name), aggregate(quantity with sum as TotalQuantity))/concat(aggregate($count as UI5__count),top(3)))';

    const res = await client.get('/odata/OrderItems').query({ $apply: pipeline }).expect(200);

    expect(res.body.value).to.be.Array();
    const rows: AnyObject[] = res.body.value;
    expect(rows.length).to.equal(5);

    const [summary, countRow, ...detail] = rows;
    expect(summary.TotalQuantity).to.equal(12);
    expect(countRow.UI5__count).to.equal(5);
    expect(detail).to.have.length(3);
    detail.forEach((row: AnyObject) => {
      expect(row).to.have.property('product/name');
      expect(row.TotalQuantity).to.be.a.Number();
    });
  });

  it('aggregates arithmetic operands inside $apply', async () => {
    const res = await client
      .get('/odata/OrderItems')
      .query({
        $apply: 'aggregate(quantity mul unitPrice with sum as TotalRevenue)',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.have.length(1);
    expect(res.body.value[0].TotalRevenue).to.equal(5138);
  });

  it('supports concat pipelines followed by filter and orderby stages', async () => {
    const pipeline =
      'concat(aggregate(unitPrice with sum as price),aggregate(unitPrice with sum as price)/concat(aggregate($count as UI5__count),top(5)))/filter(price ge 0)/orderby(price desc)';

    const res = await client.get('/odata/OrderItems').query({ $apply: pipeline }).expect(200);

    const rows: AnyObject[] = res.body.value;
    expect(rows).to.be.Array();
    expect(rows.length).to.be.greaterThan(1);

    const [summary, countRow, ...detail] = rows;
    expect(summary.price).to.be.a.Number();
    expect(summary.price).to.be.greaterThan(0);
    expect(countRow.UI5__count).to.equal(detail.length);
    detail.forEach((item: AnyObject, index: number, list: AnyObject[]) => {
      expect(item.price).to.be.a.Number();
      if (index > 0) {
        expect(list[index - 1].price >= item.price).to.be.true();
      }
    });
  });

  it('supports $apply pipelines with post-aggregate filter stages', async () => {
    const res = await client
      .get('/odata/Orders')
      .query({
        $apply:
          'groupby((total), aggregate(id with count as OrderCount))/filter(OrderCount ge 1)/orderby(OrderCount desc)/top(1)',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.have.length(1);
    const first = res.body.value[0];
    expect(first.OrderCount).to.be.a.Number();
    expect(first.OrderCount).to.be.greaterThan(0);
  });

  it('supports navigation-path groupby aggregates', async () => {
    const res = await client
      .get('/odata/OrderItems')
      .query({
        $apply:
          'groupby((order/id), aggregate(order/total with sum as TotalOrderValue))/orderby(TotalOrderValue desc)/top(1)',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.have.length(1);
    const first = res.body.value[0];
    expect(first).to.have.property('order/id');
    expect(first['order/id']).to.be.a.Number();
    expect(first.TotalOrderValue).to.be.a.Number();
    expect(first.TotalOrderValue).to.be.greaterThan(0);
  });

  it('aggregates navigation paths in fallback execution', async () => {
    const res = await client
      .get('/odata/Products')
      .query({
        $apply: 'groupby((id), aggregate(orderItems/quantity with sum as TotalQuantity))',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    const laptop = res.body.value.find((item: any) => item.id === 1);
    expect(laptop).to.be.Object();
    expect(laptop.TotalQuantity).to.equal(2);
  });

  it('enforces navigation fanout guardrail during fallback execution', async function () {
    if (app.state === 'started') await app.stop();
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      maxApplyNavigationFanout: 1,
      logApplyFallbacks: false,
    } as ODataConfig);
    await app.boot();
    await seedExampleData(app);
    await app.start();
    client = createRestAppClient(app);

    await client
      .get('/odata/Products')
      .query({
        $apply: 'groupby((id), aggregate(orderItems/quantity with sum as TotalQuantity))',
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.error.message).to.match(/navigation expansion exceeds/i);
      });
  });

  it('enforces maxApplyResultSize limits during fallback execution', async function () {
    if (app.state === 'started') await app.stop();
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    app.bind(ODATA_BINDINGS.CONFIG).to({
      maxApplyResultSize: 1,
      logApplyFallbacks: false,
      capabilities: {
        aggregation: true,
      },
    } as ODataConfig);
    await app.boot();
    await seedExampleData(app);
    await app.start();
    client = createRestAppClient(app);

    const res = await client
      .get('/odata/OrderItems')
      .query({
        $apply: 'groupby((order/id), aggregate(order/total with sum as TotalRevenue))',
      })
      .expect(400);

    expect(String(res.body?.error?.message ?? '')).to.match(/exceeds the server limit/i);
  });

  it('executes $apply via a registered pushdown executor when available', async function (this: Mocha.Context) {
    if (app.state === 'started') await app.stop();
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });

    const fallbackEvents: string[] = [];
    const sentinel = [{ TotalProducts: 999 }];

    class MemoryApplyExecutor implements ODataApplyExecutor {
      readonly id = 'memory-test';

      supports(dataSource: juggler.DataSource): boolean {
        const connectorName = (dataSource.connector as AnyObject | undefined)?.name;
        return connectorName === 'memory';
      }

      async execute(ctx: ODataApplyExecutorContext) {
        executedContext = ctx;
        executionCount++;
        return { rows: sentinel };
      }
    }

    let executedContext: ODataApplyExecutorContext | undefined;
    let executionCount = 0;

    app.bind(ODATA_BINDINGS.CONFIG).to({
      enableApplyPushdown: true,
      onApplyFallback: (event) => fallbackEvents.push(event.event),
      capabilities: {
        aggregation: true,
      },
    } as ODataConfig);

    app
      .bind(ODATA_BINDINGS.APPLY_EXECUTOR_REGISTRY)
      .toDynamicValue(() => {
        const registry = new ODataApplyExecutorRegistry();
        registry.register(new MemoryApplyExecutor());
        return registry;
      })
      .inScope(BindingScope.SINGLETON);

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

    const res = await client
      .get('/odata/Products')
      .query({ $apply: 'aggregate(id with count as TotalProducts)' })
      .expect(200);

    expect(res.body.value).to.deepEqual(sentinel);
    expect(executionCount).to.equal(1);
    expect(executedContext).to.be.Object();
    expect(fallbackEvents).to.be.empty();
  });

  it('supports lambda any filters', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $filter: 'orderItems/any(i: i/unitPrice gt 800)' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value.length).to.be.greaterThan(0);
    for (const item of res.body.value) {
      expect(item.orderItems.some((oi: any) => oi.unitPrice > 800)).to.be.true();
    }
  });

  it('supports lambda filters combined with additional predicates', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $filter: 'orderItems/any(i: i/unitPrice gt 800) and price gt 1000' })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.have.length(1);
    const [first] = res.body.value;
    expect(first.price).to.be.greaterThan(1000);
    expect(first.orderItems.some((oi: any) => oi.unitPrice > 800)).to.be.true();
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

  it('returns expanded relation data when combining $select and $expand on Orders', async () => {
    const res = await client
      .get('/odata/Orders')
      .query({
        $expand: 'items($select=id,quantity,unitPrice)',
        $select: 'id,total',
        $skip: '0',
        $top: '100',
      })
      .expect(200);

    expect(res.body.value).to.be.Array();
    expect(res.body.value).to.not.be.empty();
    for (const order of res.body.value) {
      expect(order).to.have.property('items');
      expect(order.items).to.be.Array();
      for (const item of order.items as AnyObject[]) {
        expect(item).to.have.property('id');
        expect(item).to.have.property('quantity');
        expect(item).to.have.property('unitPrice');
      }
    }
  });

  it('executes unbound actions with raw responses', async () => {
    const result = await client.post('/odata/resetInventory').send({ confirm: true }).expect(200);

    expect(result.body.status).to.equal('ok');
    expect(result.body.total).to.be.a.Number();
  });

  it('accepts $batch requests end to end', async () => {
    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [
          { id: 'products', method: 'GET', url: '/odata/Products' },
          { id: 'count', method: 'GET', url: '/odata/Products/$count' },
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
            body: { price: 5 },
          },
          {
            id: 'create-2',
            method: 'POST',
            url: '/odata/Products',
            atomicityGroup: 'set-1',
            body: { name: 'Valid', price: 8 },
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

  it('allows service-root-relative URLs in JSON $batch requests', async () => {
    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [{ id: 'relative', method: 'GET', url: 'Products?$top=1' }],
      })
      .expect(200);

    const [responseEntry] = res.body.responses;
    expect(responseEntry.status).to.equal(200);
    expect(Array.isArray(responseEntry.body.value)).to.be.true();
    expect(responseEntry.body.value).to.have.length(1);
  });

  it('rejects dependsOn references to later requests', async () => {
    await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'first',
            method: 'GET',
            url: '/odata/Products',
            dependsOn: ['second'],
          },
          {
            id: 'second',
            method: 'GET',
            url: '/odata/Products?$top=1',
          },
        ],
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.error?.message).to.match(/appears later/i);
      });
  });

  it('skips dependent requests when dependencies fail', async () => {
    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'invalid-create',
            method: 'POST',
            url: '/odata/Products',
            body: { price: 10 },
          },
          {
            id: 'should-skip',
            method: 'GET',
            url: '/odata/Products',
            dependsOn: ['invalid-create'],
          },
          {
            id: 'independent',
            method: 'GET',
            url: '/odata/Products?$top=1',
          },
        ],
      })
      .expect(200);

    const responses = res.body.responses;
    const failing = responses.find((entry: AnyObject) => entry.id === 'invalid-create');
    const skipped = responses.find((entry: AnyObject) => entry.id === 'should-skip');
    const independent = responses.find((entry: AnyObject) => entry.id === 'independent');
    expect(failing).to.be.Object();
    expect(skipped).to.be.Object();
    expect(independent).to.be.Object();
    expect(failing.status).to.equal(422);
    expect(skipped.status).to.equal(424);
    expect(skipped.body?.error?.code).to.equal('FailedDependency');
    expect(independent.status).to.equal(200);
    expect(Array.isArray(independent.body?.value)).to.be.true();
  });

  it('substitutes Content-ID references within JSON changesets', async () => {
    const dataSource = await app.get('datasources.db');
    (dataSource as AnyObject).beginTransaction = async (_isolation?: unknown) => ({
      commit: async () => undefined,
      rollback: async () => undefined,
    });

    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'create-product',
            atomicityGroup: 'set-2',
            method: 'POST',
            url: '/odata/Products',
            body: { name: 'Batch Camera', price: 899 },
          },
          {
            id: 'update-product',
            atomicityGroup: 'set-2',
            method: 'PATCH',
            url: '$create-product',
            body: { price: 999 },
          },
          {
            id: 'fetch-product',
            method: 'GET',
            url: '$requests(1)',
            dependsOn: ['create-product', 'update-product'],
          },
        ],
      })
      .expect(200);

    const responses = res.body.responses;
    const create = responses.find((entry: AnyObject) => entry.id === 'create-product');
    const update = responses.find((entry: AnyObject) => entry.id === 'update-product');
    const fetch = responses.find((entry: AnyObject) => entry.id === 'fetch-product');
    expect(create.status).to.equal(201);
    expect(create.headers?.['location']).to.be.String();
    expect(create.headers?.['odata-entityid']).to.equal(create.headers?.['location']);
    expect(update.status).to.equal(200);
    expect(fetch.status).to.equal(200);
    const productId = create.body?.id;
    expect(productId).to.be.ok();
    expect(fetch.body?.price).to.equal(999);
    const persisted = await client.get(`/odata/Products(${productId})`).expect(200);
    expect(persisted.body.price).to.equal(999);
  });

  it('resolves Content-ID references across JSON requests', async () => {
    const res = await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'create-product-json',
            method: 'POST',
            url: '/odata/Products',
            body: { name: 'Json Batch Camera', price: 512 },
          },
          {
            id: 'fetch-product-json',
            method: 'GET',
            url: '$create-product-json',
            dependsOn: ['create-product-json'],
          },
        ],
      })
      .expect(200);

    const responses = res.body.responses;
    const create = responses.find((entry: AnyObject) => entry.id === 'create-product-json');
    const fetch = responses.find((entry: AnyObject) => entry.id === 'fetch-product-json');
    expect(create.status).to.equal(201);
    expect(create.headers?.['location']).to.be.String();
    expect(create.headers?.['odata-entityid']).to.equal(create.headers?.['location']);
    expect(fetch.status).to.equal(200);
    expect(fetch.body?.price).to.equal(512);
    expect(fetch.body?.id).to.equal(create.body?.id);
  });

  it('rejects JSON $batch payloads with non-contiguous atomicity groups', async () => {
    const dataSource = await app.get('datasources.db');
    (dataSource as AnyObject).beginTransaction = async (_isolation?: unknown) => ({
      commit: async () => undefined,
      rollback: async () => undefined,
    });

    await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'first',
            atomicityGroup: 'set-alpha',
            method: 'POST',
            url: '/odata/Products',
            body: { name: 'A1', price: 1 },
          },
          {
            id: 'middle',
            method: 'GET',
            url: '/odata/Products?$top=1',
          },
          {
            id: 'second',
            atomicityGroup: 'set-alpha',
            method: 'PATCH',
            url: '$first',
            dependsOn: ['first'],
            body: { price: 10 },
          },
        ],
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.error?.message).to.match(/contiguous/i);
      });
  });

  it('rejects change sets that contain read operations', async () => {
    await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'writer',
            atomicityGroup: 'set-beta',
            method: 'POST',
            url: '/odata/Products',
            body: { name: 'Writer', price: 1 },
          },
          {
            id: 'reader',
            atomicityGroup: 'set-beta',
            method: 'GET',
            url: '/odata/Products',
            dependsOn: ['writer'],
          },
        ],
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.error?.message).to.match(/unsupported/i);
      });
  });

  it('rejects JSON changesets that reference unknown Content-ID tokens', async () => {
    const dataSource = await app.get('datasources.db');
    (dataSource as AnyObject).beginTransaction = async (_isolation?: unknown) => ({
      commit: async () => undefined,
      rollback: async () => undefined,
    });

    await client
      .post('/odata/$batch')
      .send({
        requests: [
          {
            id: 'create-product',
            atomicityGroup: 'set-unknown',
            method: 'POST',
            url: '/odata/Products',
            body: { name: 'Camera', price: 199 },
          },
          {
            id: 'broken-reference',
            atomicityGroup: 'set-unknown',
            method: 'PATCH',
            url: '$missing-token',
            body: { price: 299 },
          },
        ],
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.error?.message).to.match(/Content-ID/i);
      });
  });

  it('applies string predicates through REST filter', async () => {
    const res = await client
      .get('/odata/Products')
      .query({ $filter: "contains(name,'Lap')" })
      .expect(200);

    expect(res.body.value).to.have.lengthOf(1);
    expect(res.body.value[0].name).to.equal('Laptop');
  });

  it('applies orderby/select/top/skip options', async () => {
    const topOne = await client
      .get('/odata/Products')
      .query({ $orderby: 'price desc', $top: '1', $select: 'name,price' })
      .expect(200);

    expect(topOne.body.value).to.have.lengthOf(1);
    expect(topOne.body.value[0].name).to.equal('Laptop');
    expect(topOne.body.value[0]).to.have.property('id');
    expect(topOne.body.value[0]).to.have.property('updatedAt');
    expect(topOne.body.value[0]['@odata.etag']).to.be.String();

    const second = await client
      .get('/odata/Products')
      .query({ $orderby: 'price asc', $skip: '1', $top: '1' })
      .expect(200);

    expect(second.body.value).to.have.lengthOf(1);
    expect(second.body.value[0].name).to.equal('Decaf Coffee Beans');
    expect(second.body.value[0]).to.have.property('id');
  });

  it('handles CRUD operations and path rewriting', async () => {
    const created = await client
      .post('/odata/Products')
      .send({ name: 'Camera', price: 450 })
      .expect(201);

    const createdId = created.body.id;
    expect(created.body.name).to.equal('Camera');
    const createdEtag = created.headers['etag'] as string;
    expect(createdEtag).to.be.String();
    expect(created.body['@odata.etag']).to.equal(createdEtag);

    const updated = await client
      .patch(`/odata/Products(${createdId})`)
      .set('If-Match', createdEtag)
      .send({ price: 500 })
      .expect(200);
    expect(updated.body.price).to.equal(500);
    const updatedEtag = updated.headers['etag'] as string;
    expect(updatedEtag).to.be.String();
    expect(updatedEtag).to.not.equal(createdEtag);

    const fetched = await client.get(`/odata/Products(${createdId})`).expect(200);
    expect(fetched.body.name).to.equal('Camera');
    expect(fetched.headers['etag']).to.equal(updatedEtag);

    await client.del(`/odata/Products(${createdId})`).set('If-Match', updatedEtag).expect(204);
    await client.get(`/odata/Products(${createdId})`).expect(404);
  });

  it('returns 201 with Location and OData-EntityId headers for create responses', async () => {
    const res = await client
      .post('/odata/Products')
      .send({ name: 'Tripod', price: 49 })
      .expect(201);

    const createdId = res.body.id;
    expect(createdId).to.be.Number();
    const location = res.headers['location'] as string;
    const entityIdHeader = res.headers['odata-entityid'] as string;
    expect(location).to.be.String();
    expect(entityIdHeader).to.equal(location);
    const expectedPath = `/odata/Products(${createdId})`;
    try {
      const parsed = new URL(location);
      expect(parsed.pathname).to.equal(expectedPath);
    } catch {
      expect(location).to.equal(expectedPath);
    }
    const etag = res.headers['etag'] as string;
    expect(etag).to.be.String();

    await client.del(`/odata/Products(${createdId})`).set('If-Match', etag).expect(204);
  });

  it('requires If-Match and rejects stale tokens when ETags are enabled', async () => {
    const created = await client
      .post('/odata/Products')
      .send({ name: 'Controller', price: 99 })
      .expect(201);

    const productId = created.body.id;
    const originalEtag = created.headers['etag'] as string;

    const updated = await client
      .patch(`/odata/Products(${productId})`)
      .set('If-Match', originalEtag)
      .send({ price: 129 })
      .expect(200);

    const currentEtag = updated.headers['etag'] as string;

    await client.del(`/odata/Products(${productId})`).set('If-Match', originalEtag).expect(412);

    // Delete requires current If-Match token in strict mode
    await client.del(`/odata/Products(${productId})`).set('If-Match', currentEtag).expect(204);
    await client.get(`/odata/Products(${productId})`).expect(404);
  });

  it('honors Prefer return=minimal for write operations', async () => {
    const createRes = await client
      .post('/odata/Products')
      .set('Prefer', 'return=minimal')
      .send({ name: 'Speaker', price: 199 })
      .expect(204);

    expect(createRes.headers['preference-applied']).to.equal('return=minimal');
    expect(createRes.headers['odata-version']).to.equal('4.0');
    expect(createRes.headers['odata-entityid']).to.be.String();
    expect(createRes.headers['location']).to.equal(createRes.headers['odata-entityid']);

    const createdList = await client
      .get('/odata/Products')
      .query({ $filter: "name eq 'Speaker'" })
      .expect(200);
    const speaker = createdList.body.value[0];
    const speakerId = speaker?.id;
    const speakerEtag = speaker?.['@odata.etag'];
    expect(speakerEtag).to.be.String();

    const updateRes = await client
      .patch(`/odata/Products(${speakerId})`)
      .set('Prefer', 'return=minimal')
      .set('If-Match', speakerEtag)
      .send({ price: 219 })
      .expect(204);
    expect(updateRes.headers['preference-applied']).to.equal('return=minimal');
    expect(updateRes.headers['odata-version']).to.equal('4.0');

    const verify = await client.get(`/odata/Products(${speakerId})`).expect(200);
    expect(verify.body.price).to.equal(219);

    const deleteEtag = verify.headers['etag'] as string;

    await client.del(`/odata/Products(${speakerId})`).set('If-Match', deleteEtag).expect(204);
  });

  it('returns deleted entities when Prefer return=representation is requested', async () => {
    const created = await client
      .post('/odata/Products')
      .send({ name: 'Legacy Phone', price: 15 })
      .expect(201);

    const productId = created.body.id;
    const etag = created.headers['etag'] as string;

    const deleteRes = await client
      .del(`/odata/Products(${productId})`)
      .set('Prefer', 'return=representation')
      .set('If-Match', etag)
      .expect(200);

    expect(deleteRes.headers['preference-applied']).to.equal('return=representation');
    expect(deleteRes.body.id).to.equal(productId);
    expect(deleteRes.body.name).to.equal('Legacy Phone');
    expect(deleteRes.body['@odata.etag']).to.equal(deleteRes.headers['etag']);
    expect(deleteRes.body['@odata.context']).to.match(/Products\/\$entity$/);

    await client.get(`/odata/Products(${productId})`).expect(404);
  });

  it('acknowledges Prefer return=minimal on delete responses', async () => {
    const created = await client
      .post('/odata/Products')
      .send({ name: 'Disposable Camera', price: 29 })
      .expect(201);

    const productId = created.body.id;
    const etag = created.headers['etag'] as string;

    const deleteRes = await client
      .del(`/odata/Products(${productId})`)
      .set('Prefer', 'return=minimal')
      .set('If-Match', etag)
      .expect(204);

    expect(deleteRes.headers['preference-applied']).to.equal('return=minimal');
    await client.get(`/odata/Products(${productId})`).expect(404);
  });

  it('returns 412 when If-Match does not match the current entity ETag', async () => {
    const created = await client
      .post('/odata/Products')
      .send({ name: 'Monitor', price: 299 })
      .expect(201);

    const createdId = created.body.id;
    const originalEtag = created.headers['etag'] as string;

    const firstUpdate = await client
      .patch(`/odata/Products(${createdId})`)
      .set('If-Match', originalEtag)
      .send({ price: 329 })
      .expect(200);

    const nextEtag = firstUpdate.headers['etag'] as string;
    expect(nextEtag).to.not.equal(originalEtag);

    await client
      .patch(`/odata/Products(${createdId})`)
      .set('If-Match', originalEtag)
      .send({ price: 339 })
      .expect(412);

    const current = await getProductWithEtag(createdId);
    expect(current.etag).to.equal(nextEtag);
    expect(current.body.price).to.equal(329);
  });

  it('returns OData error payloads for invalid filters', async () => {
    const res = await client.get('/odata/Products').query({ $filter: 'invalid eq' }).expect(400);

    expect(res.headers['odata-version']).to.equal('4.0');
    expect(res.body.error).to.be.Object();
    expect(res.body.error.code).to.equal('BadRequest');
    expect(res.body.error.message).to.match(/Invalid (OData )?query|Invalid filter expression/i);
  });

  it('rejects Prefer respond-async', async () => {
    const res = await client
      .post('/odata/Products')
      .set('Prefer', 'respond-async')
      .send({ name: 'AsyncWidget', price: 5 })
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
        requests: [{ id: 'bad', method: 'GET', url: '' }],
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
            body: { name: 'Tablet', price: 599 },
            atomicityGroup: 'g1',
          },
          {
            id: 'c2',
            method: 'PATCH',
            url: '/odata/Products(1)',
            body: { price: 1499 },
            atomicityGroup: 'g1',
          },
        ],
      })
      .expect(200);

    const failures = res.body.responses.filter((entry: AnyObject) => entry.atomicityGroup === 'g1');
    expect(failures).to.have.lengthOf(2);
    failures.forEach((failure: AnyObject) => {
      expect(failure.status).to.equal(501);
      expect(failure.body?.error?.code).to.equal('BatchExecutionError');
    });
  });

  it('rejects $batch requests that exceed maxOperations', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    const original = {
      ...current,
      batch: { ...(current.batch ?? {}) },
    } satisfies ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...original,
      batch: {
        ...(original.batch ?? {}),
        maxOperations: 1,
      },
    });

    await client
      .post('/odata/$batch')
      .set('Content-Type', 'application/json')
      .send({
        requests: [
          { id: '1', method: 'GET', url: '/odata/Products' },
          { id: '2', method: 'GET', url: '/odata/Orders' },
        ],
      })
      .expect(400);

    app.bind(ODATA_BINDINGS.CONFIG).to(original);
  });

  it('rejects multipart $batch requests that exceed part size limit', async () => {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    const original = {
      ...current,
      batch: { ...(current.batch ?? {}) },
    } satisfies ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...original,
      batch: {
        ...(original.batch ?? {}),
        maxPartBodyBytes: 64,
      },
    });

    const batchBoundary = 'batch_part_limit';
    const payload = [
      `--${batchBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'POST /odata/Products HTTP/1.1',
      'Content-Type: application/json',
      '',
      `{"name":"${'X'.repeat(200)}"}`,
      '',
      `--${batchBoundary}--`,
      '',
    ].join('\r\n');

    await client
      .post('/odata/$batch')
      .set('Content-Type', `multipart/mixed; boundary=${batchBoundary}`)
      .send(payload)
      .expect(413);

    app.bind(ODATA_BINDINGS.CONFIG).to(original);
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

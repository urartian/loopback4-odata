/// <reference path="../../types/testing.globals.d.ts" />

import { Client, createRestAppClient, expect } from '@loopback/testlab';
import { BootMixin } from '@loopback/boot';
import { RepositoryMixin } from '@loopback/repository';
import { RestApplication, RestServerConfig } from '@loopback/rest';
import { inject } from '@loopback/core';
import {
  AnyObject,
  DefaultCrudRepository,
  Entity,
  juggler,
  model,
  property,
  repository,
} from '@loopback/repository';
import {
  ODataComponent,
  odataController,
  odataModel,
  odata,
  CrudHookContext,
  CrudOnContext,
} from '../../index';

class HookTestApp extends BootMixin(RepositoryMixin(RestApplication)) {
  constructor(config: RestServerConfig = {}) {
    super({ rest: config });
    this.projectRoot = __dirname;
  }
}

@odataModel({ etag: 'updatedAt' })
@model()
class HookItem extends Entity {
  @property({ id: true })
  id!: number;

  @property({ required: true })
  name!: string;

  @property({ type: 'date', required: true, defaultFn: 'now' })
  updatedAt!: Date;
}

class HookItemRepository extends DefaultCrudRepository<HookItem, typeof HookItem.prototype.id> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(HookItem, dataSource);
  }
}

@odataController(HookItem)
class HookItemController {
  static auditLog: string[] = [];

  constructor(@repository(HookItemRepository) private repo: HookItemRepository) {}

  // BEFORE CREATE: normalize name if header present
  @odata.before('CREATE')
  beforeCreate(ctx: CrudHookContext) {
    if (ctx.request.get('x-use-hooks') !== '1') return;
    const body = ctx.payload as AnyObject;
    if (body?.name) body.name = String(body.name).trim().toUpperCase();
  }

  // AFTER READ (entity): add a marker
  @odata.after('READ', 'entity')
  afterReadEntity(ctx: CrudHookContext) {
    if (ctx.request.get('x-use-hooks') !== '1') return;
    const result = ctx.result as AnyObject | undefined;
    if (result) (result as AnyObject).hook = 'after';
  }

  // ON UPDATE: optionally override default behavior
  @odata.on('UPDATE')
  async overrideUpdate(ctx: CrudOnContext, next: () => Promise<any>) {
    if (ctx.request.get('x-override') !== '1') return next();
    // Full override: perform repo update and return decorated entity
    await (this.repo as any).updateById(ctx.id as number, ctx.payload, ctx.options);
    const updated = await (this.repo as any).findById(ctx.id as number, undefined, ctx.options);
    return ctx.helpers.entity(updated as AnyObject);
  }

  // ON READ (collection): custom listing when header present
  @odata.on('READ', 'collection')
  async overrideList(ctx: CrudOnContext, next: () => Promise<any>) {
    if (ctx.request.get('x-override') !== '1') return next();
    const items = await (this.repo as any).find({ order: ['name DESC'] }, ctx.options);
    return ctx.helpers.collection(items);
  }

  // BEFORE CREATE & UPDATE: mark the payload with active operation
  @odata.before(['CREATE', 'UPDATE'])
  beforeCreateAndUpdate(ctx: CrudHookContext) {
    if (ctx.request.get('x-multi-hook') !== '1') return;
    const payload = ctx.payload as AnyObject;
    if (typeof payload?.name === 'string') {
      payload.name = `${ctx.operation}:${payload.name}`;
    }
  }

  // BEFORE *: track every operation when header is present
  @odata.before('*')
  trackAllOps(ctx: CrudHookContext) {
    if (ctx.request.get('x-track-hooks') !== '1') return;
    HookItemController.auditLog.push(ctx.operation);
  }
}

describe('OData controller hooks & overrides', () => {
  let app: HookTestApp;
  let client: Client;

  beforeEach(async function () {
    HookItemController.auditLog = [];
    app = new HookTestApp({ port: 0, host: '127.0.0.1' });
    const ds = new juggler.DataSource({ name: 'db', connector: 'memory' });
    app.dataSource(ds, 'db');
    app.repository(HookItemRepository);
    app.component(ODataComponent);
    app.controller(HookItemController);
    await app.boot();
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
    if (app?.state === 'started') await app.stop();
  });

  it('runs @odata.before on CREATE and mutates payload', async () => {
    const res = await client
      .post('/odata/HookItems')
      .set('x-use-hooks', '1')
      .send({ name: '  hello  ' })
      .expect(201);

    expect(res.body['@odata.context']).to.match(/HookItems/);
    expect(res.body.name).to.equal('HELLO');
    expect(res.headers['location']).to.be.String();
    expect(res.headers['odata-entityid']).to.equal(res.headers['location']);
  });

  it('allows @odata.on to override UPDATE flow', async () => {
    const created = await client.post('/odata/HookItems').send({ name: 'orig' }).expect(201);
    const id = created.body.id;

    const updated = await client
      .patch(`/odata/HookItems(${id})`)
      .set('x-override', '1')
      .send({ name: 'changed' })
      .expect(200);

    expect(updated.body['@odata.context']).to.match(/HookItems\/\$entity/);
    expect(updated.body.name).to.equal('changed');
  });

  it('runs @odata.after on READ entity', async () => {
    const created = await client.post('/odata/HookItems').send({ name: 'after-test' }).expect(201);
    const id = created.body.id;

    const res = await client.get(`/odata/HookItems(${id})`).set('x-use-hooks', '1').expect(200);

    expect(res.body.hook).to.equal('after');
  });

  it('supports @odata.on override for READ collection', async () => {
    await client.post('/odata/HookItems').send({ name: 'a' }).expect(201);
    await client.post('/odata/HookItems').send({ name: 'b' }).expect(201);

    const res = await client.get('/odata/HookItems').set('x-override', '1').expect(200);

    expect(res.body['@odata.context']).to.match(/HookItems$/);
    expect(Array.isArray(res.body.value)).to.be.true();
    expect(res.body.value.length).to.be.greaterThanOrEqual(2);
  });

  it('runs @odata.before when array syntax targets multiple operations', async () => {
    const created = await client
      .post('/odata/HookItems')
      .set('x-multi-hook', '1')
      .send({ name: 'multi-create' })
      .expect(201);

    expect(created.body.name).to.equal('CREATE:multi-create');
    const id = created.body.id;
    const createEtag = created.body['@odata.etag'] ?? created.headers.etag;
    expect(createEtag).to.be.String();

    const updated = await client
      .patch(`/odata/HookItems(${id})`)
      .set('x-multi-hook', '1')
      .set('If-Match', createEtag)
      .send({ name: 'multi-update' })
      .expect(200);

    expect(updated.body.name).to.equal('UPDATE:multi-update');
  });

  it('runs wildcard @odata.before hooks on non-read operations', async () => {
    const created = await client.post('/odata/HookItems').send({ name: 'to-delete' }).expect(201);
    const id = created.body.id;
    const etag = created.body['@odata.etag'] ?? created.headers.etag;
    expect(etag).to.be.String();

    await client
      .del(`/odata/HookItems(${id})`)
      .set('x-track-hooks', '1')
      .set('If-Match', etag)
      .expect(204);

    expect(HookItemController.auditLog).to.containEql('DELETE');
  });
});

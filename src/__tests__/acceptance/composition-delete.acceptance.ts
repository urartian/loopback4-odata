/// <reference path="../../types/testing.globals.d.ts" />

import { Client, createRestAppClient, expect } from '@loopback/testlab';
import {
  givenODataApplication,
  TestApplication,
  OrderRepository,
  OrderItemRepository,
  OrderItemNoteRepository,
  ProductRepository,
} from '../fixtures/odata-app.fixture';
import { ODATA_BINDINGS } from '../../keys';
import { ODataConfig } from '../../types';

describe('Composition delete acceptance', () => {
  let app: TestApplication;
  let client: Client;

  const startOrSkip = async (mochaCtx: { skip: () => void }) => {
    try {
      await app.start();
      client = createRestAppClient(app);
    } catch (err) {
      if (['EADDRNOTAVAIL', 'EPERM'].includes(String((err as any)?.code))) {
        mochaCtx.skip();
        return;
      }
      throw err;
    }
  };

  beforeEach(async function () {
    app = await givenODataApplication({ port: 0, host: '127.0.0.1' });
    const baseConfig = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...baseConfig,
      tokenSecret: 'test-secret',
      composition: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: false, // memory datasource doesn't support tx
        maxDepth: 8,
        maxEntities: 5000,
        entitySets: {
          Orders: {
            relations: {
              items: { delete: 'cascade' },
            },
          },
          OrderItems: {
            relations: {
              notes: { delete: 'cascade' },
            },
          },
        },
      },
    } satisfies ODataConfig);
    await app.boot();
    await startOrSkip(this as any);
  });

  afterEach(async () => {
    if (app?.state === 'started') {
      await app.stop();
    }
  });

  it('deletes Orders -> OrderItems -> OrderItemNotes depth-first', async () => {
    const productRepo = await app.getRepository(ProductRepository);
    const orderRepo = await app.getRepository(OrderRepository);
    const itemRepo = await app.getRepository(OrderItemRepository);
    const noteRepo = await app.getRepository(OrderItemNoteRepository);

    const product = await productRepo.create({ name: 'Test product', price: 10 });
    const order = await orderRepo.create({ total: 10 });
    const item = await itemRepo.create({
      orderId: order.id!,
      productId: product.id!,
      quantity: 1,
      unitPrice: 10,
    });
    await noteRepo.create({ orderItemId: item.id!, text: 'hello' });

    await client.del(`/odata/Orders(${order.id})`).expect(204);
    await expect(orderRepo.findById(order.id as any)).to.be.rejected();
    expect((await itemRepo.count({ orderId: order.id })).count).to.equal(0);
    expect((await noteRepo.count({ orderItemId: item.id })).count).to.equal(0);
  });
});

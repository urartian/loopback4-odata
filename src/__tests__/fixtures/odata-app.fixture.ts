import 'reflect-metadata';
import {BootMixin} from '@loopback/boot';
import {RestApplication, RestServerConfig} from '@loopback/rest';
import {inject} from '@loopback/core';
import {
  DefaultCrudRepository,
  Entity,
  RepositoryMixin,
  belongsTo,
  hasMany,
  juggler,
  model,
  property,
  repository,
} from '@loopback/repository';
import {
  ODataComponent,
  odataAction,
  odataController,
  odataFunction,
  odataModel,
} from '../../index';

const MEMORY_DS_CONFIG = {
  name: 'db',
  connector: 'memory',
};

export class TestApplication extends BootMixin(RepositoryMixin(RestApplication)) {
  constructor(config: RestServerConfig = {}) {
    super({rest: config});
    this.projectRoot = __dirname;
  }
}

@odataModel()
@model()
export class Product extends Entity {
  @property({id: true})
  id!: number;

  @property()
  name!: string;

  @property()
  price!: number;

  @hasMany(() => OrderItem)
  orderItems?: OrderItem[];

  @hasMany(() => Order, {
    through: {model: () => OrderItem, keyFrom: 'productId', keyTo: 'orderId'},
  })
  orders?: Order[];
}

@odataModel()
@model()
export class Order extends Entity {
  @property({id: true})
  id!: number;

  @property({required: true})
  total!: number;

  @hasMany(() => OrderItem)
  items?: OrderItem[];

  @hasMany(() => Product, {
    through: {model: () => OrderItem, keyFrom: 'orderId', keyTo: 'productId'},
  })
  products?: Product[];
}

@odataModel()
@model()
export class OrderItem extends Entity {
  @property({id: true, generated: true})
  id?: number;

  @belongsTo(() => Order)
  orderId!: number;

  @belongsTo(() => Product)
  productId!: number;

  @property({required: true})
  quantity!: number;

  @property({required: true})
  unitPrice!: number;
}

export class ProductRepository extends DefaultCrudRepository<
  Product,
  typeof Product.prototype.id
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(Product, dataSource);
  }
}

export class OrderRepository extends DefaultCrudRepository<
  Order,
  typeof Order.prototype.id
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(Order, dataSource);
  }
}

export class OrderItemRepository extends DefaultCrudRepository<
  OrderItem,
  typeof OrderItem.prototype.id
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(OrderItem, dataSource);
  }
}

@odataController(Product)
class ProductODataController {
  constructor(
    @repository(ProductRepository) private readonly products: ProductRepository,
  ) {}

  @odataAction({
    binding: 'entity',
    params: [{name: 'percent', type: 'Edm.Double'}],
    returnType: 'Default.Product',
  })
  async discount(id: typeof Product.prototype.id, body: {percent: number}) {
    const entity = await this.products.findById(id);
    const percent = Number(body?.percent ?? 0);
    const factor = 1 - percent / 100;
    const newPrice = Number((entity.price ?? 0) * factor);
    await this.products.updateById(id, {price: newPrice});
    return this.products.findById(id);
  }

  @odataFunction({
    binding: 'collection',
    params: [{name: 'minPrice', type: 'Edm.Double'}],
    returnType: 'Collection(Default.Product)',
  })
  async premiumProducts(query: {minPrice?: string}) {
    const minPrice = Number(query?.minPrice ?? 1000);
    return this.products.find({where: {price: {gte: minPrice}}});
  }
}

@odataController(Order)
class OrderODataController {}

@odataController(OrderItem)
class OrderItemODataController {}

export async function givenODataApplication(config: RestServerConfig = {}): Promise<TestApplication> {
  const app = new TestApplication(config);
  const dataSource = new juggler.DataSource(MEMORY_DS_CONFIG);
  app.dataSource(dataSource, MEMORY_DS_CONFIG.name);
  app.repository(OrderItemRepository);
  app.repository(ProductRepository);
  app.repository(OrderRepository);
  app.component(ODataComponent);
  app.controller(ProductODataController);
  app.controller(OrderODataController);
  app.controller(OrderItemODataController);
  return app;
}

export async function seedExampleData(app: TestApplication) {
  const productRepo = await app.getRepository(ProductRepository);
  const orderRepo = await app.getRepository(OrderRepository);
  const orderItemRepo = await app.getRepository(OrderItemRepository);

  const existingProducts = await productRepo.count();
  if (existingProducts.count > 0) return;

  const [laptop, phone, monitor] = await productRepo.createAll([
    {name: 'Laptop', price: 1299},
    {name: 'Phone', price: 799},
    {name: 'Monitor', price: 349},
  ]);

  const [orderOne, orderTwo] = await orderRepo.createAll([
    {total: 0},
    {total: 0},
  ]);

  const items = [
    {orderId: orderOne.id!, productId: laptop.id!, quantity: 2, unitPrice: laptop.price},
    {orderId: orderOne.id!, productId: monitor.id!, quantity: 1, unitPrice: monitor.price},
    {orderId: orderTwo.id!, productId: phone.id!, quantity: 1, unitPrice: phone.price},
    {orderId: orderTwo.id!, productId: monitor.id!, quantity: 3, unitPrice: monitor.price},
  ];

  await orderItemRepo.createAll(items);

  const totals = items.reduce<Record<number, number>>((acc, item) => {
    const itemTotal = item.quantity * item.unitPrice;
    acc[item.orderId] = (acc[item.orderId] ?? 0) + itemTotal;
    return acc;
  }, {});

  await Promise.all(
    Object.entries(totals).map(([orderId, total]) =>
      orderRepo.updateById(Number(orderId), {total}),
    ),
  );
}

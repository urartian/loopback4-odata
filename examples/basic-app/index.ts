import 'reflect-metadata';
import { RestApplication } from '@loopback/rest';
import { BootMixin } from '@loopback/boot';
import { Getter, inject } from '@loopback/core';
import {
  BelongsToAccessor,
  AnyObject,
  DataObject,
  DefaultCrudRepository,
  Entity,
  HasManyRepositoryFactory,
  HasManyThroughRepositoryFactory,
  Options,
  RepositoryMixin,
  belongsTo,
  hasMany,
  juggler,
  model,
  property,
  repository,
} from '@loopback/repository';
import {
  ODATA_BINDINGS,
  ODataComponent,
  ODataConfig,
  odataAction,
  odataController,
  odataFunction,
  odataModel,
} from '../../src';

const MEMORY_DS_CONFIG = {
  name: 'db',
  connector: 'memory',
};

// use the following config if you want to test out with PostgreSQL
const POSTGRES_DS_CONFIG = {
  name: 'db',
  connector: 'postgresql',
  host: process.env.PG_HOST ?? '127.0.0.1',
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASSWORD ?? 'pass',
  database: process.env.PG_DATABASE ?? 'odata_dev',
  ssl: process.env.PG_SSL === 'true',
};

const MYSQL_DS_CONFIG = {
  name: 'db',
  connector: 'mysql',
  host: process.env.MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? 'pass',
  database: process.env.MYSQL_DATABASE ?? 'odata_dev',
};

export class ExampleApp extends BootMixin(RepositoryMixin(RestApplication)) {
  constructor() {
    super({ rest: { port: 3001, host: '127.0.0.1' } });
    this.projectRoot = __dirname;

    const usePostgres = process.env.USE_POSTGRES === 'true';
    const useMysql = process.env.USE_MYSQL === 'true';
    const dsConfig = usePostgres
      ? POSTGRES_DS_CONFIG
      : useMysql
        ? MYSQL_DS_CONFIG
        : MEMORY_DS_CONFIG;
    this.dataSource(new juggler.DataSource(dsConfig), dsConfig.name);
    this.repository(OrderItemRepository);
    this.repository(ProductRepository);
    this.repository(OrderRepository);

    this.component(ODataComponent);

    const maxApply = Number(process.env.MAX_APPLY_RESULT_SIZE ?? '');
    if (Number.isFinite(maxApply) && maxApply > 0) {
      const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
      this.bind(ODATA_BINDINGS.CONFIG).to({
        ...current,
        maxApplyResultSize: maxApply,
        logApplyFallbacks: true, // optional so you see the warning
      });
    }

    const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    const enablePushdown = process.env.ENABLE_APPLY_PUSHDOWN === 'true';
    const logTelemetry = process.env.LOG_APPLY_TELEMETRY === 'true';
    const tokenSecret = process.env.ODATA_TOKEN_SECRET ?? 'dev-example-secret';
    const maxOps = Number(process.env.BATCH_MAX_OPERATIONS ?? '');
    const maxPartBytes = Number(process.env.BATCH_MAX_PART_BYTES ?? '');
    const batchConfig: ODataConfig['batch'] = {
      ...(current.batch ?? {}),
      ...(Number.isFinite(maxOps) && maxOps > 0 ? { maxOperations: maxOps } : {}),
      ...(Number.isFinite(maxPartBytes) && maxPartBytes > 0
        ? { maxPartBodyBytes: maxPartBytes }
        : {}),
    };
    this.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      enableApplyPushdown: enablePushdown,
      logApplyFallbacks: true, // optional so you see the warning
      ...(logTelemetry ? { logApplyTelemetry: true } : {}),
      tokenSecret,
      documentInOpenApiDefault: false,
      ...(batchConfig ? { batch: batchConfig } : {}),
    });
  }
}

@odataModel({ etag: 'updatedAt' })
export class Product extends Entity {
  @property({
    type: 'number',
    id: true,
    generated: true,
  })
  id!: number;

  @property()
  name!: string;

  @property()
  price!: number;

  @property({ type: 'date', required: true, defaultFn: 'now' })
  updatedAt!: Date;

  @hasMany(() => OrderItem)
  orderItems?: OrderItem[];

  @hasMany(() => Order, {
    through: { model: () => OrderItem, keyFrom: 'productId', keyTo: 'orderId' },
  })
  orders?: Order[];
}

@odataModel({ deepInsert: true, deepUpdate: true })
export class Order extends Entity {
  @property({
    type: 'number',
    id: true,
    generated: true,
  })
  id!: number;

  @property({ required: true })
  total!: number;

  @hasMany(() => OrderItem)
  items?: OrderItem[];

  @hasMany(() => Product, {
    through: { model: () => OrderItem, keyFrom: 'orderId', keyTo: 'productId' },
  })
  products?: Product[];
}

@odataModel({ documentInOpenApi: true })
export class OrderItem extends Entity {
  @property({
    type: 'number',
    id: true,
    generated: true,
  })
  id?: number;

  @belongsTo(() => Order)
  orderId!: number;

  @belongsTo(() => Product)
  productId!: number;

  @property({ required: true })
  quantity!: number;

  @property({ required: true })
  unitPrice!: number;
}

export class ProductRepository extends DefaultCrudRepository<Product, typeof Product.prototype.id> {
  public readonly orderItems: HasManyRepositoryFactory<OrderItem, typeof Product.prototype.id>;
  public readonly orders: HasManyThroughRepositoryFactory<
    Order,
    typeof Order.prototype.id,
    OrderItem,
    typeof Product.prototype.id
  >;
  private touch(entity?: AnyObject) {
    if (!entity) return;
    entity.updatedAt = new Date();
  }

  constructor(
    @inject('datasources.db') dataSource: juggler.DataSource,
    @repository.getter('OrderRepository')
    protected orderRepositoryGetter: Getter<OrderRepository>,
    @repository.getter('OrderItemRepository')
    protected orderItemRepositoryGetter: Getter<OrderItemRepository>,
  ) {
    super(Product, dataSource);
    this.orderItems = this.createHasManyRepositoryFactoryFor(
      'orderItems',
      orderItemRepositoryGetter,
    );
    this.registerInclusionResolver('orderItems', this.orderItems.inclusionResolver);
    this.orders = this.createHasManyThroughRepositoryFactoryFor(
      'orders',
      orderRepositoryGetter,
      orderItemRepositoryGetter,
    );
    this.registerInclusionResolver('orders', this.orders.inclusionResolver);
  }

  async create(entity: DataObject<Product>, options?: Options): Promise<Product> {
    this.touch(entity);
    return super.create(entity, options);
  }

  async createAll(entities: DataObject<Product>[], options?: Options): Promise<Product[]> {
    const now = new Date();
    for (const entity of entities) {
      if (entity && entity.updatedAt == null) {
        (entity as AnyObject).updatedAt = now;
      }
    }
    return super.createAll(entities, options);
  }

  async updateById(
    id: typeof Product.prototype.id,
    data: DataObject<Product>,
    options?: Options,
  ): Promise<void> {
    this.touch(data);
    return super.updateById(id, data, options);
  }

  async updateAll(
    data: DataObject<Product>,
    where?: AnyObject,
    options?: Options,
  ): Promise<{ count: number }> {
    this.touch(data);
    return super.updateAll(data, where, options);
  }

  async replaceById(
    id: typeof Product.prototype.id,
    data: DataObject<Product>,
    options?: Options,
  ): Promise<void> {
    this.touch(data);
    return super.replaceById(id, data, options);
  }
}

export class OrderRepository extends DefaultCrudRepository<Order, typeof Order.prototype.id> {
  public readonly items: HasManyRepositoryFactory<OrderItem, typeof Order.prototype.id>;
  public readonly products: HasManyThroughRepositoryFactory<
    Product,
    typeof Product.prototype.id,
    OrderItem,
    typeof Order.prototype.id
  >;

  constructor(
    @inject('datasources.db') dataSource: juggler.DataSource,
    @repository.getter('ProductRepository')
    protected productRepositoryGetter: Getter<ProductRepository>,
    @repository.getter('OrderItemRepository')
    protected orderItemRepositoryGetter: Getter<OrderItemRepository>,
  ) {
    super(Order, dataSource);
    this.items = this.createHasManyRepositoryFactoryFor('items', orderItemRepositoryGetter);
    this.registerInclusionResolver('items', this.items.inclusionResolver);
    this.products = this.createHasManyThroughRepositoryFactoryFor(
      'products',
      productRepositoryGetter,
      orderItemRepositoryGetter,
    );
    this.registerInclusionResolver('products', this.products.inclusionResolver);
  }
}

export class OrderItemRepository extends DefaultCrudRepository<
  OrderItem,
  typeof OrderItem.prototype.id
> {
  public readonly order: BelongsToAccessor<Order, typeof OrderItem.prototype.id>;
  public readonly product: BelongsToAccessor<Product, typeof OrderItem.prototype.id>;

  constructor(
    @inject('datasources.db') dataSource: juggler.DataSource,
    @repository.getter('OrderRepository')
    protected orderRepositoryGetter: Getter<OrderRepository>,
    @repository.getter('ProductRepository')
    protected productRepositoryGetter: Getter<ProductRepository>,
  ) {
    super(OrderItem, dataSource);
    this.order = this.createBelongsToAccessorFor('order', orderRepositoryGetter);
    this.registerInclusionResolver('order', this.order.inclusionResolver);
    this.product = this.createBelongsToAccessorFor('product', productRepositoryGetter);
    this.registerInclusionResolver('product', this.product.inclusionResolver);
  }
}

@odataController(Product)
class ProductODataController {
  constructor(@repository(ProductRepository) private readonly products: ProductRepository) { }

  @odataAction({
    binding: 'entity',
    params: [{ name: 'percent', type: 'Edm.Double' }],
    returnType: 'Default.Product',
  })
  async discount(id: typeof Product.prototype.id, body: { percent: number }) {
    const entity = await this.products.findById(id);
    const percent = Number(body?.percent ?? 0);
    const factor = 1 - percent / 100;
    const newPrice = Number((entity.price ?? 0) * factor);
    await this.products.updateById(id, { price: newPrice });
    return this.products.findById(id);
  }

  @odataFunction({
    binding: 'collection',
    params: [{ name: 'minPrice', type: 'Edm.Double' }],
    returnType: 'Collection(Default.Product)',
  })
  async premiumProducts(query: { minPrice?: string }) {
    const minPrice = Number(query?.minPrice ?? 1000);
    return this.products.find({ where: { price: { gte: minPrice } } });
  }
}

@odataController(Order)
class OrderODataController { }

@odataController(OrderItem)
class OrderItemODataController { }

export async function main() {
  const app = new ExampleApp();
  app.controller(ProductODataController);
  app.controller(OrderODataController);
  app.controller(OrderItemODataController);
  await app.boot();
  await seedData(app);
  await app.start();
  const { url } = app.restServer;
  console.log(`OData example server running at ${url}`);
}

async function seedData(app: ExampleApp) {
  const productRepo = await app.getRepository(ProductRepository);
  const orderRepo = await app.getRepository(OrderRepository);
  const orderItemRepo = await app.getRepository(OrderItemRepository);

  const existingProducts = await productRepo.count();
  if (existingProducts.count === 0) {
    const [laptop, phone, monitor] = await productRepo.createAll([
      { name: 'Laptop', price: 1299 },
      { name: 'Phone', price: 799 },
      { name: 'Monitor', price: 349 },
    ]);

    const [orderOne, orderTwo] = await orderRepo.createAll([{ total: 0 }, { total: 0 }]);

    const items = [
      { orderId: orderOne.id!, productId: laptop.id!, quantity: 2, unitPrice: laptop.price },
      { orderId: orderOne.id!, productId: monitor.id!, quantity: 1, unitPrice: monitor.price },
      { orderId: orderTwo.id!, productId: phone.id!, quantity: 1, unitPrice: phone.price },
      { orderId: orderTwo.id!, productId: monitor.id!, quantity: 3, unitPrice: monitor.price },
    ];

    await orderItemRepo.createAll(items);

    const totals = items.reduce<Record<number, number>>((acc, item) => {
      const itemTotal = item.quantity * item.unitPrice;
      acc[item.orderId] = (acc[item.orderId] ?? 0) + itemTotal;
      return acc;
    }, {});

    await Promise.all(
      Object.entries(totals).map(([orderId, total]) =>
        orderRepo.updateById(Number(orderId), { total }),
      ),
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start example app', err);
    process.exit(1);
  });
}

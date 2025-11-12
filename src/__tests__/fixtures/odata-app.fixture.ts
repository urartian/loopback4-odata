import 'reflect-metadata';
import { BootMixin } from '@loopback/boot';
import { HttpErrors, RestApplication, RestServerConfig } from '@loopback/rest';
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
  ODataComponent,
  odata,
  odataAction,
  odataController,
  odataFunction,
  odataModel,
  CrudHookContext,
  odataSearchable,
} from '../../index';
import { ODATA_BINDINGS } from '../../keys';
import { ODataConfig } from '../../types';

const MEMORY_DS_CONFIG = {
  name: 'db',
  connector: 'memory',
};

export class TestApplication extends BootMixin(RepositoryMixin(RestApplication)) {
  constructor(config: RestServerConfig = {}) {
    super({ rest: config, shutdown: { signals: [] } });
    this.projectRoot = __dirname;
  }
}

@odataModel({ etag: 'updatedAt' })
@model()
export class Product extends Entity {
  @property({ id: true })
  id!: number;

  @property()
  @odataSearchable()
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
@model()
export class Order extends Entity {
  @property({ id: true })
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

@odataModel()
@model()
export class OrderItem extends Entity {
  @property({ id: true, generated: true })
  id?: number;

  @belongsTo(() => Order)
  orderId!: number;

  @belongsTo(() => Product)
  productId!: number;

  @property({ required: true })
  quantity!: number;

  @property({ required: true })
  unitPrice!: number;

  @hasMany(() => OrderItemNote)
  notes?: OrderItemNote[];
}

@odataModel()
@model()
export class OrderItemNote extends Entity {
  @property({ id: true, generated: true })
  id?: number;

  @belongsTo(() => OrderItem)
  orderItemId!: number;

  @property({ required: true })
  text!: string;
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
  public readonly notes: HasManyRepositoryFactory<OrderItemNote, typeof OrderItem.prototype.id>;

  constructor(
    @inject('datasources.db') dataSource: juggler.DataSource,
    @repository.getter('OrderRepository')
    protected orderRepositoryGetter: Getter<OrderRepository>,
    @repository.getter('ProductRepository')
    protected productRepositoryGetter: Getter<ProductRepository>,
    @repository.getter('OrderItemNoteRepository')
    protected noteRepositoryGetter: Getter<OrderItemNoteRepository>,
  ) {
    super(OrderItem, dataSource);
    this.order = this.createBelongsToAccessorFor('order', orderRepositoryGetter);
    this.registerInclusionResolver('order', this.order.inclusionResolver);
    this.product = this.createBelongsToAccessorFor('product', productRepositoryGetter);
    this.registerInclusionResolver('product', this.product.inclusionResolver);
    this.notes = this.createHasManyRepositoryFactoryFor('notes', noteRepositoryGetter);
    this.registerInclusionResolver('notes', this.notes.inclusionResolver);
  }
}

export class OrderItemNoteRepository extends DefaultCrudRepository<
  OrderItemNote,
  typeof OrderItemNote.prototype.id
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(OrderItemNote, dataSource);
  }
}

@odataController(Product)
class ProductODataController {
  constructor(@repository(ProductRepository) private readonly products: ProductRepository) {}

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

  @odataAction({
    name: 'resetInventory',
    binding: 'unbound',
    rawResponse: true,
  })
  async resetInventory(body: { confirm?: boolean } = {}) {
    if (!body.confirm) return { status: 'skipped' };
    const count = await this.products.count();
    return { status: 'ok', total: count.count };
  }

  @odata.before('CREATE')
  validateCreate(ctx: CrudHookContext) {
    const payload = ctx.payload as AnyObject | undefined;
    const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      throw new HttpErrors.UnprocessableEntity('Product name is required.');
    }
  }
}

@odataController(Order)
class OrderODataController {
  @odata.before('LINK_NAVIGATION')
  guardNavigationLinks(ctx: CrudHookContext) {
    if (ctx.relationName !== 'items') return;
    const flag = ctx.request.get('x-block-link');
    if (flag && flag.toLowerCase() === 'true') {
      throw new HttpErrors.Conflict('Navigation link blocked by hook.');
    }
  }
}

@odataController(OrderItem)
class OrderItemODataController {}

@odataController(OrderItemNote)
class OrderItemNoteODataController {}

@odataModel({ entitySetName: 'OdataOnlyIncidents' })
export class OdataOnlyIncident extends Entity {
  @property({ type: 'string', id: true, defaultFn: 'uuid' })
  id?: string;

  @property({ type: 'string' })
  title?: string;

  @hasMany(() => OdataOnlyConversation, { keyTo: 'incidentId' })
  conversations?: OdataOnlyConversation[];
}

@odataModel({ entitySetName: 'OdataOnlyConversations' })
export class OdataOnlyConversation extends Entity {
  @property({ type: 'string', id: true, defaultFn: 'uuid' })
  id?: string;

  @property({ type: 'string' })
  message?: string;

  @belongsTo(() => OdataOnlyIncident, { name: 'incident' })
  incidentId!: string;
}

export class OdataOnlyIncidentRepository extends DefaultCrudRepository<
  OdataOnlyIncident,
  typeof OdataOnlyIncident.prototype.id
> {
  public readonly conversations: HasManyRepositoryFactory<
    OdataOnlyConversation,
    typeof OdataOnlyIncident.prototype.id
  >;

  constructor(
    @inject('datasources.db') dataSource: juggler.DataSource,
    @repository.getter('OdataOnlyConversationRepository')
    protected conversationRepositoryGetter: Getter<OdataOnlyConversationRepository>,
  ) {
    super(OdataOnlyIncident, dataSource);
    this.conversations = this.createHasManyRepositoryFactoryFor(
      'conversations',
      conversationRepositoryGetter,
    );
    this.registerInclusionResolver('conversations', this.conversations.inclusionResolver);
  }
}

export class OdataOnlyConversationRepository extends DefaultCrudRepository<
  OdataOnlyConversation,
  typeof OdataOnlyConversation.prototype.id
> {
  public readonly incident: BelongsToAccessor<
    OdataOnlyIncident,
    typeof OdataOnlyConversation.prototype.id
  >;

  constructor(
    @inject('datasources.db') dataSource: juggler.DataSource,
    @repository.getter('OdataOnlyIncidentRepository')
    protected incidentRepositoryGetter: Getter<OdataOnlyIncidentRepository>,
  ) {
    super(OdataOnlyConversation, dataSource);
    this.incident = this.createBelongsToAccessorFor('incident', incidentRepositoryGetter);
    this.registerInclusionResolver('incident', this.incident.inclusionResolver);
  }
}

@odataController(OdataOnlyIncident)
class OdataOnlyIncidentODataController {}

@odataController(OdataOnlyConversation)
class OdataOnlyConversationODataController {}

export function registerODataOnlyModels(app: TestApplication) {
  app.repository(OdataOnlyIncidentRepository);
  app.repository(OdataOnlyConversationRepository);
  app.controller(OdataOnlyIncidentODataController);
  app.controller(OdataOnlyConversationODataController);
}

export async function givenODataApplication(
  config: RestServerConfig = {},
): Promise<TestApplication> {
  const app = new TestApplication(config);
  const dataSource = new juggler.DataSource(MEMORY_DS_CONFIG);
  app.dataSource(dataSource, MEMORY_DS_CONFIG.name);
  app.repository(OrderItemRepository);
  app.repository(ProductRepository);
  app.repository(OrderRepository);
  app.repository(OrderItemNoteRepository);
  app.component(ODataComponent);
  const currentConfig = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
  app.bind(ODATA_BINDINGS.CONFIG).to({
    ...currentConfig,
    tokenSecret: 'test-secret',
  });
  app.controller(ProductODataController);
  app.controller(OrderODataController);
  app.controller(OrderItemODataController);
  app.controller(OrderItemNoteODataController);
  return app;
}

export async function seedExampleData(app: TestApplication) {
  const productRepo = await app.getRepository(ProductRepository);
  const orderRepo = await app.getRepository(OrderRepository);
  const orderItemRepo = await app.getRepository(OrderItemRepository);

  const existingProducts = await productRepo.count();
  if (existingProducts.count > 0) return;

  const [laptop, phone, monitor, coffeeGrinder, coffeeBeans] = await productRepo.createAll([
    { name: 'Laptop', price: 1299 },
    { name: 'Phone', price: 799 },
    { name: 'Monitor', price: 349 },
    { name: 'Coffee Grinder', price: 249 },
    { name: 'Coffee Beans', price: 24 },
    { name: 'Decaf Coffee Beans', price: 26 },
    { name: 'Espresso Machine', price: 899 },
  ]);

  const [orderOne, orderTwo] = await orderRepo.createAll([{ total: 0 }, { total: 0 }]);

  const items = [
    { orderId: orderOne.id!, productId: laptop.id!, quantity: 2, unitPrice: laptop.price },
    { orderId: orderOne.id!, productId: monitor.id!, quantity: 1, unitPrice: monitor.price },
    {
      orderId: orderOne.id!,
      productId: coffeeBeans.id!,
      quantity: 4,
      unitPrice: coffeeBeans.price,
    },
    { orderId: orderTwo.id!, productId: phone.id!, quantity: 1, unitPrice: phone.price },
    { orderId: orderTwo.id!, productId: monitor.id!, quantity: 3, unitPrice: monitor.price },
    {
      orderId: orderTwo.id!,
      productId: coffeeGrinder.id!,
      quantity: 1,
      unitPrice: coffeeGrinder.price,
    },
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

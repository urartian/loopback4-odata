import { RestApplication } from '@loopback/rest';
import { BootMixin } from '@loopback/boot';
import { Getter, inject } from '@loopback/core';
import {
    BelongsToAccessor,
    DefaultCrudRepository,
    Entity,
    HasManyRepositoryFactory,
    HasManyThroughRepositoryFactory,
    RepositoryMixin,
    belongsTo,
    hasMany,
    juggler,
    model,
    property,
    repository,
} from '@loopback/repository';
import { ODataComponent } from './component';
import { odataModel } from './decorators/model.decorator';
import { odataAction, odataFunction } from './decorators/action.function.decorators';
import { odataController } from './decorators/controller.decorator';

const MEMORY_DS_CONFIG = {
    name: 'db',
    connector: 'memory',
};

class DevApp extends BootMixin(RepositoryMixin(RestApplication)) {
    constructor() {
        super({ rest: { port: 3001, host: '127.0.0.1' } });
        this.projectRoot = __dirname; // Required for BootMixin

        this.dataSource(new juggler.DataSource(MEMORY_DS_CONFIG), MEMORY_DS_CONFIG.name);
        this.repository(OrderItemRepository);
        this.repository(ProductRepository);
        this.repository(OrderRepository);

        this.component(ODataComponent);
    }
}

@odataModel()
@model()
export class Product extends Entity {
    @property({ id: true })
    id!: number;   // Required, assigned at runtime

    @property()
    name!: string;

    @property()
    price!: number;

    @hasMany(() => OrderItem)
    orderItems?: OrderItem[];

    @hasMany(() => Order, {
        through: { model: () => OrderItem, keyFrom: 'productId', keyTo: 'orderId' },
    })
    orders?: Order[];
}

@odataModel()
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
}


export class ProductRepository extends DefaultCrudRepository<
    Product,
    typeof Product.prototype.id
> {
    public readonly orderItems: HasManyRepositoryFactory<OrderItem, typeof Product.prototype.id>;
    public readonly orders: HasManyThroughRepositoryFactory<Order, typeof Order.prototype.id, OrderItem, typeof Product.prototype.id>;

    constructor(
        @inject('datasources.db') dataSource: juggler.DataSource,
        @repository.getter('OrderRepository')
        protected orderRepositoryGetter: Getter<OrderRepository>,
        @repository.getter('OrderItemRepository')
        protected orderItemRepositoryGetter: Getter<OrderItemRepository>,
    ) {
        super(Product, dataSource);
        this.orderItems = this.createHasManyRepositoryFactoryFor('orderItems', orderItemRepositoryGetter);
        this.registerInclusionResolver('orderItems', this.orderItems.inclusionResolver);
        this.orders = this.createHasManyThroughRepositoryFactoryFor('orders', orderRepositoryGetter, orderItemRepositoryGetter);
        this.registerInclusionResolver('orders', this.orders.inclusionResolver);
    }
}

export class OrderRepository extends DefaultCrudRepository<
    Order,
    typeof Order.prototype.id
> {
    public readonly items: HasManyRepositoryFactory<OrderItem, typeof Order.prototype.id>;
    public readonly products: HasManyThroughRepositoryFactory<Product, typeof Product.prototype.id, OrderItem, typeof Order.prototype.id>;

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
        this.products = this.createHasManyThroughRepositoryFactoryFor('products', productRepositoryGetter, orderItemRepositoryGetter);
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
    constructor(
        @repository(ProductRepository) private readonly products: ProductRepository,
    ) { }

    @odataAction({ binding: 'entity', params: [{ name: 'percent', type: 'Edm.Double' }], returnType: 'Default.Product' })
    async discount(id: typeof Product.prototype.id, body: { percent: number }) {
        const entity = await this.products.findById(id);
        const percent = Number(body?.percent ?? 0);
        const factor = 1 - percent / 100;
        const newPrice = Number((entity.price ?? 0) * factor);
        await this.products.updateById(id, { price: newPrice });
        return await this.products.findById(id);
    }

    @odataFunction({ binding: 'collection', params: [{ name: 'minPrice', type: 'Edm.Double' }], returnType: 'Collection(Default.Product)' })
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
    const app = new DevApp();
    // Explicitly register the OData controller
    app.controller(ProductODataController);
    app.controller(OrderODataController);
    app.controller(OrderItemODataController);
    await app.boot();   // runs the ODataBooter
    await seedData(app);
    await app.start();
    const { url } = app.restServer;
    console.log(`OData dev server running at ${url}`);
}

async function seedData(app: DevApp) {
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

        const [orderOne, orderTwo] = await orderRepo.createAll([
            { total: 0 },
            { total: 0 },
        ]);

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
    main().catch(err => {
        console.error('Failed to start dev app', err);
        process.exit(1);
    });
}

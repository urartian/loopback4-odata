import { RestApplication } from '@loopback/rest';
import { BootMixin } from '@loopback/boot';
import { inject } from '@loopback/core';
import { DefaultCrudRepository, Entity, RepositoryMixin, juggler, model, property } from '@loopback/repository';
import { ODataComponent } from './component';
import { odataModel } from './decorators/model.decorator';
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
}

@odataModel()
@model()
export class Order extends Entity {
    @property({ id: true })
    id!: number;

    @property({ required: true })
    productId!: number;

    @property({ required: true })
    quantity!: number;

    @property({ required: true })
    total!: number;
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

@odataController(Product)
class ProductODataController { }

@odataController(Order)
class OrderODataController { }

export async function main() {
    const app = new DevApp();
    // Explicitly register the OData controller
    app.controller(ProductODataController);
    app.controller(OrderODataController);
    await app.boot();   // runs the ODataBooter
    await seedData(app);
    await app.start();
    const { url } = app.restServer;
    console.log(`OData dev server running at ${url}`);
}

async function seedData(app: DevApp) {
    const productRepo = await app.getRepository(ProductRepository);
    const orderRepo = await app.getRepository(OrderRepository);

    const existingProducts = await productRepo.count();
    if (existingProducts.count === 0) {
        const [laptop, phone, monitor] = await productRepo.createAll([
            { name: 'Laptop', price: 1299 },
            { name: 'Phone', price: 799 },
            { name: 'Monitor', price: 349 },
        ]);

        await orderRepo.createAll([
            { productId: laptop.id!, quantity: 2, total: 2598 },
            { productId: phone.id!, quantity: 1, total: 799 },
            { productId: monitor.id!, quantity: 3, total: 1047 },
            { productId: laptop.id!, quantity: 1, total: 1299 },
        ]);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Failed to start dev app', err);
        process.exit(1);
    });
}

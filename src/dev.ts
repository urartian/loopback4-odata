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


export class ProductRepository extends DefaultCrudRepository<
    Product,
    typeof Product.prototype.id
> {
    constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
        super(Product, dataSource);
    }
}

@odataController(Product)
class ProductODataController { }

async function main() {
    const app = new DevApp();
    // Explicitly register the OData controller
    app.controller(ProductODataController);
    await app.boot();   // runs the ODataBooter
    await app.start();
    const { url } = app.restServer;
    console.log(`OData dev server running at ${url}`);
}

main().catch(err => {
    console.error('Failed to start dev app', err);
    process.exit(1);
});

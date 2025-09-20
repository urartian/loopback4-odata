import { RestApplication } from '@loopback/rest';
import { BootMixin } from '@loopback/boot';
import { ODataComponent } from './component';
import { Entity, model, property } from '@loopback/repository';

// FIX: import decorators from correct files
import { odataModel } from './decorators/model.decorator';
import { odataController } from './decorators/controller.decorator';

class DevApp extends BootMixin(RestApplication) {
    constructor() {
        super({ rest: { port: 3001, host: '127.0.0.1' } });
        this.projectRoot = __dirname; // Required for BootMixin
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


@odataController(Product)
class ProductODataController { }

async function main() {
    const app = new DevApp();
    // Explicitly register the OData controller
    app.controller(ProductODataController);
    await app.boot();   // runs the ODataBooter
    await app.start();
    console.log('OData dev server running at http://127.0.0.1:3001');
}

main();

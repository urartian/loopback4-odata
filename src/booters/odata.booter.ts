import { injectable, CoreBindings, inject, Application } from '@loopback/core';
import { Booter } from '@loopback/boot';
import { ControllerClass } from '@loopback/rest';
import { EntitySetRegistry } from '../registry/entityset-registry';
import { getODataControllerModel } from '../decorators/controller.decorator';
import { defineODataCrudController } from '../controllers/crud-controller-factory';

@injectable({ tags: { booters: 'odata' } })
export class ODataBooter implements Booter {
    constructor(
        @inject(CoreBindings.APPLICATION_INSTANCE) private app: Application,
        @inject('odata.registry') private registry: EntitySetRegistry,
    ) { }

    async load(): Promise<void> {
        const bindings = this.app.find('controllers.*');

        for (const binding of bindings) {
            const ctor = binding.valueConstructor as ControllerClass<{ [key: string]: any }>;
            if (!ctor) continue;

            const modelCtor = getODataControllerModel(ctor);
            if (!modelCtor) continue;

            const setName = modelCtor.name + 's'; // TODO: pluralize
            const def = { name: setName, modelCtor };
            this.registry.register(def);

            const CrudController = defineODataCrudController(def);
            this.app.controller(CrudController);
        }
    }
}

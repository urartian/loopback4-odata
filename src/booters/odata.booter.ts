import { Application, Binding, CoreBindings, inject, injectable } from '@loopback/core';
import { Booter } from '@loopback/boot';
import { ControllerClass } from '@loopback/rest';
import { EntitySetRegistry } from '../registry/entityset-registry';
import { getODataControllerModel } from '../decorators/controller.decorator';
import { defineODataCrudController } from '../controllers/crud-controller-factory';
import { getODataModelMeta } from '../decorators/model.decorator';
import { ODATA_BINDINGS } from '../keys';
import { Entity } from '@loopback/repository';

@injectable({ tags: { booters: 'odata' } })
export class ODataBooter implements Booter {
    constructor(
        @inject(CoreBindings.APPLICATION_INSTANCE) private app: Application,
        @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY) private registry: EntitySetRegistry,
    ) { }

    async load(): Promise<void> {
        const repositoryMap = await this.buildRepositoryMap();
        const bindings = this.app.find('controllers.*');

        for (const binding of bindings) {
            const ctor = binding.valueConstructor as ControllerClass<{ [key: string]: any }>;
            if (!ctor) continue;

            const modelCtor = getODataControllerModel(ctor) as (typeof Entity | undefined);
            if (!modelCtor) continue;

            const setName = this.getEntitySetName(modelCtor);
            const repoBinding = repositoryMap.get(modelCtor);

            if (!repoBinding) {
                throw new Error(
                    `OData controller for model ${modelCtor.name} requires a DefaultCrudRepository instance. ` +
                    `Ensure a repository for ${modelCtor.name} is registered via app.repository(${modelCtor.name}Repository) ` +
                    `or mounted through a component before booting the OData component.`,
                );
            }

            const def = this.registry.register({
                name: setName,
                modelCtor,
                repositoryBindingKey: repoBinding.key,
                repositoryCtor: repoBinding.valueConstructor ?? undefined,
            });

            const CrudController = defineODataCrudController(def);
            this.app.controller(CrudController);
        }
    }

    private async buildRepositoryMap(): Promise<Map<typeof Entity, Readonly<Binding<unknown>>>> {
        const repoBindings = this.app.find('repositories.*');
        const map = new Map<typeof Entity, Readonly<Binding<unknown>>>();

        for (const binding of repoBindings) {
            try {
                const repoInstance = await binding.getValue(this.app);
                const entityCtor = (repoInstance as { entityClass?: typeof Entity }).entityClass;
                if (entityCtor) {
                    map.set(entityCtor, binding);
                }
            } catch (err) {
                // Ignore bindings that cannot be resolved at boot time.
            }
        }

        return map;
    }

    private getEntitySetName(modelCtor: typeof Entity): string {
        const meta = getODataModelMeta(modelCtor);
        if (meta?.entitySetName) return meta.entitySetName;
        return `${modelCtor?.name ?? 'Entity'}s`; // TODO: pluralize properly
    }
}

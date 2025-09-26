import { BindingScope, injectable } from '@loopback/core';
import { Entity } from '@loopback/repository';
import { OperationMeta } from '../decorators/action.function.decorators';

export interface EntitySetDef<T extends Entity = Entity> {
    name: string;                                      // e.g. "Products"
    modelCtor: typeof Entity & { prototype: T };       // LB4 model constructor
    controllerCtor?: Function;                         // generated controller
    repositoryBindingKey?: string;                     // app.binding key for the repository
    repositoryCtor?: Function;                         // repository class constructor
    actions?: OperationMeta[];
    functions?: OperationMeta[];
}

@injectable({ scope: BindingScope.SINGLETON })
export class EntitySetRegistry {
    private readonly sets = new Map<typeof Entity, EntitySetDef>();

    register<T extends Entity>(def: EntitySetDef<T>): EntitySetDef<T> {
        const existing = this.sets.get(def.modelCtor);
        const merged = { ...(existing ?? {}), ...def } as EntitySetDef;
        this.sets.set(def.modelCtor, merged);
        return merged as EntitySetDef<T>;
    }

    attachRepository(modelCtor: typeof Entity, bindingKey: string, repositoryCtor?: Function) {
        const def = this.sets.get(modelCtor);
        if (!def) {
            throw new Error(`Attempted to attach repository for unregistered model ${modelCtor.name ?? '[Anonymous]'}.`);
        }
        def.repositoryBindingKey = bindingKey;
        def.repositoryCtor = repositoryCtor;
    }

    get(modelCtor: typeof Entity): EntitySetDef | undefined {
        return this.sets.get(modelCtor);
    }

    list(): EntitySetDef[] {
        return Array.from(this.sets.values());
    }

    findByName(name: string): EntitySetDef | undefined {
        const normalized = name.toLowerCase();
        for (const def of this.sets.values()) {
            if (def.name.toLowerCase() === normalized) return def;
        }
        return undefined;
    }
}

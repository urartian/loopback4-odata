import { injectable, BindingScope } from '@loopback/core';

export interface EntitySetDef {
    name: string;            // e.g. "Products"
    modelCtor: Function;     // LB4 model constructor
    controllerCtor?: Function; // generated controller
}

@injectable({ scope: BindingScope.SINGLETON })
export class EntitySetRegistry {
    private sets: EntitySetDef[] = [];

    register(def: EntitySetDef) {
        this.sets.push(def);
    }

    list(): EntitySetDef[] {
        return this.sets;
    }
}

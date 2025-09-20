import 'reflect-metadata';

const ODATA_CTRL_MODEL_KEY = 'odata:controller:model';

export function odataController(modelCtor: Function) {
    return (target: Function) => {
        Reflect.defineMetadata(ODATA_CTRL_MODEL_KEY, modelCtor, target);
    };
}

export function getODataControllerModel(target: Function) {
    return Reflect.getMetadata(ODATA_CTRL_MODEL_KEY, target) as Function | undefined;
}

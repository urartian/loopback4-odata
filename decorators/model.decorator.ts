import 'reflect-metadata';
const ODATA_MODEL_KEY = 'odata:model';

export function odataModel(opts: { entitySetName?: string } = {}) {
    return (target: Function) => {
        Reflect.defineMetadata(ODATA_MODEL_KEY, opts, target);
    };
}

export function getODataModelMeta(target: Function) {
    return Reflect.getMetadata(ODATA_MODEL_KEY, target) as { entitySetName?: string } | undefined;
}

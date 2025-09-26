import 'reflect-metadata';
const ODATA_MODEL_KEY = 'odata:model';

export interface ODataModelOptions {
    entitySetName?: string;
    etag?: string;
}

export function odataModel(opts: ODataModelOptions = {}) {
    return (target: Function) => {
        Reflect.defineMetadata(ODATA_MODEL_KEY, opts, target);
    };
}

export function getODataModelMeta(target: Function): ODataModelOptions | undefined {
    return Reflect.getMetadata(ODATA_MODEL_KEY, target) as ODataModelOptions | undefined;
}

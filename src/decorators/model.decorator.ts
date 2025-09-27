import 'reflect-metadata';
const ODATA_MODEL_KEY = 'odata:model';

export interface ODataModelOptions {
    entitySetName?: string;
    etag?: string[];
}

export interface ODataModelDecoratorOptions {
    entitySetName?: string;
    etag?: string | string[];
}

function normalizeOptions(opts: ODataModelDecoratorOptions = {}): ODataModelOptions {
    const normalized: ODataModelOptions = {};
    if (opts.entitySetName) normalized.entitySetName = opts.entitySetName;
    if (opts.etag != null) {
        const values = Array.isArray(opts.etag) ? opts.etag : [opts.etag];
        const filtered = values
            .map(value => (value == null ? '' : String(value).trim()))
            .filter((value): value is string => Boolean(value.length));
        if (filtered.length) {
            normalized.etag = Array.from(new Set(filtered));
        }
    }
    return normalized;
}

export function odataModel(opts: ODataModelDecoratorOptions = {}) {
    const normalized = normalizeOptions(opts);
    return (target: Function) => {
        Reflect.defineMetadata(ODATA_MODEL_KEY, normalized, target);
    };
}

export function getODataModelMeta(target: Function): ODataModelOptions | undefined {
    const meta = Reflect.getMetadata(ODATA_MODEL_KEY, target) as ODataModelDecoratorOptions | undefined;
    if (!meta) return undefined;
    return normalizeOptions(meta);
}

import { inject } from '@loopback/core';
import {
    HttpErrors,
    del,
    get,
    getModelSchemaRef,
    param,
    patch,
    post,
    requestBody,
    Request,
    RestBindings,
    RequestContext,
} from '@loopback/rest';
import {
    DefaultCrudRepository,
    Entity,
    Filter,
    FilterExcludingWhere,
    InclusionFilter,
    Options,
    RelationDefinitionMap,
    PropertyDefinition,
    AnyObject,
} from '@loopback/repository';
import { EntitySetDef } from '../registry/entityset-registry';
import { parseODataQuery } from '../services/odata-query-parser.service';
import { ODATA_ATOMICITY_STATE, ODATA_VERSION } from '../constants';
import { AtomicityRequestState } from '../types/batch';
import { Response } from '@loopback/rest';
import {
    decodeIfMatchValues,
    encodeEtagToken,
    ensureEtagField,
    matchesEtag,
    normalizeEtagProperties,
    parseIfMatch,
    parseIfNoneMatch,
    readEtagValue,
} from '../util/etag';
import {
    applyControllerSecurityMetadata,
    mergeMethodAliasMaps,
    MethodAliasMap,
    ControllerSecurityMetadata,
} from '../util/security-metadata';
import {CrudHookBundle, CrudHookContext, CrudOnContext, CrudOperation, CrudScope} from '../types/crud-hooks';
import { ODATA_BINDINGS } from '../keys';
import { ODataConfig } from '../types';
type CrudEntity = Entity & { [key: string]: unknown };
type CrudRepo = DefaultCrudRepository<CrudEntity, unknown>;

function inferIdParamType(definition: any): 'string' | 'number' | 'boolean' {
    const idName = definition?.idProperties?.()[0];
    const property = definition?.properties?.[idName ?? ''] ?? {};
    const type = property.type ?? 'string';

    if (type === Number || type === 'number') return 'number';
    if (type === Boolean || type === 'boolean') return 'boolean';
    if (typeof type === 'function') {
        const typeName = type.name.toLowerCase();
        if (typeName === 'number') return 'number';
        if (typeName === 'boolean') return 'boolean';
    }
    return 'string';
}

function getIdProperties(definition: any): string[] {
    return definition?.idProperties?.() ?? ['id'];
}

/**
 * Factory that creates a dedicated CRUD controller for an entity set.
 */
export function defineODataCrudController(def: EntitySetDef) {
    const { name: setName, modelCtor, repositoryBindingKey } = def;
    if (!repositoryBindingKey) {
        throw new HttpErrors.InternalServerError(
            `Entity set ${setName} does not have an associated repository binding.`,
        );
    }

    const repoBindingKey = repositoryBindingKey;

    const contextBase = `/odata/$metadata#${setName}`;
    const entityContext = `${contextBase}/$entity`;
    const modelDefinition = (modelCtor as { definition?: unknown }).definition as any;
    const idType = inferIdParamType(modelDefinition);
    const idParam = idType === 'number'
        ? param.path.number('id')
        : idType === 'boolean'
            ? param.path.boolean('id')
            : param.path.string('id');
    const filterParam = param.filter(modelCtor);
    const filterExcludingWhereParam = param.filter(modelCtor, { exclude: 'where' });
    const idProperties = getIdProperties(modelDefinition);
    const modelRelations = (modelDefinition?.relations ?? {}) as RelationDefinitionMap;
    const etagProperties = normalizeEtagProperties(def.etagProperties);
    const etagPropertyDefs = (etagProperties ?? []).reduce<Record<string, PropertyDefinition | undefined>>(
        (acc, prop) => {
            acc[prop] = modelDefinition?.properties?.[prop] as PropertyDefinition | undefined;
            return acc;
        },
        {},
    );
    const primaryEtagProperty = etagProperties?.[0];
    const optionalProperties = Array.from(
        new Set([
            ...idProperties,
            ...(etagProperties ?? []),
        ]),
    );

    const collectionResponseSchema = {
        type: 'object',
        required: ['@odata.context', 'value'],
        properties: {
            '@odata.context': { type: 'string' },
            '@odata.count': { type: 'integer', format: 'int64' },
            value: {
                type: 'array',
                items: getModelSchemaRef(modelCtor, { includeRelations: true }),
            },
        },
    };

    const entityResponseSchema = {
        allOf: [
            {
                type: 'object',
                required: ['@odata.context'],
                properties: {
                    '@odata.context': { type: 'string' },
                    '@odata.etag': { type: 'string' },
                },
            },
            getModelSchemaRef(modelCtor, { includeRelations: true }),
        ],
    };

    const mergeIncludes = (
        target: InclusionFilter[] = [],
        source: InclusionFilter[] = [],
    ): InclusionFilter[] => {
        type NormalizedInclude = Exclude<InclusionFilter, string>;
        const normalize = (include: InclusionFilter): NormalizedInclude =>
            (typeof include === 'string' ? { relation: include } : include);

        const merged = new Map<string, NormalizedInclude>();

        for (const include of target) {
            const normalized = normalize(include);
            if (normalized.relation) {
                merged.set(normalized.relation, { ...normalized });
            }
        }

        for (const include of source) {
            const normalized = normalize(include);
            if (!normalized.relation) continue;
            const existing = merged.get(normalized.relation);
            merged.set(normalized.relation, existing ? { ...existing, ...normalized } : { ...normalized });
        }

        return Array.from(merged.values());
    };

    const hooks: CrudHookBundle | undefined = def.hooks;
    const sourceCtrlBindingKey: string | undefined = def.sourceControllerBindingKey;

    class ODataCrudController {
        constructor(
            @inject(repoBindingKey)
            public readonly repository: CrudRepo,
            @inject(RestBindings.Http.REQUEST)
            public readonly request: Request,
            @inject(RestBindings.Http.RESPONSE)
            public readonly response: Response,
            @inject(RestBindings.Http.CONTEXT)
            public readonly httpCtx: RequestContext,
            @inject(ODATA_BINDINGS.CONFIG)
            public readonly cfg: ODataConfig,
        ) { }

        etagEnabled(): boolean {
            return Boolean(etagProperties?.length);
        }

        toPlainEntity(entity: CrudEntity | AnyObject | undefined): AnyObject | undefined {
            if (!entity) return undefined;
            const candidate = entity as AnyObject & {
                toObject?: (options?: AnyObject) => AnyObject;
                toJSON?: () => AnyObject;
            };

            if (typeof candidate.toObject === 'function') {
                return candidate.toObject({}) ?? undefined;
            }
            if (typeof candidate.toJSON === 'function') {
                return candidate.toJSON() ?? undefined;
            }
            if (typeof entity === 'object') {
                return { ...(entity as AnyObject) };
            }
            return undefined;
        }

        computeEtagFromPlain(plain: AnyObject | undefined): string | undefined {
            if (!this.etagEnabled() || !plain) return undefined;
            const value = readEtagValue(plain, etagProperties);
            if (value === undefined) return undefined;
            return encodeEtagToken(value, etagProperties);
        }

        decoratePlainEntity(plain: AnyObject, etag?: string): AnyObject {
            if (!etag) return { ...plain };
            return { ...plain, '@odata.etag': etag };
        }

        decoratePlainEntities(plainEntities: AnyObject[]): AnyObject[] {
            if (!this.etagEnabled()) {
                return plainEntities.map(entity => ({ ...entity }));
            }
            return plainEntities.map(plain => this.decoratePlainEntity(plain, this.computeEtagFromPlain(plain)));
        }

        ensureEtagField(filter: Filter<CrudEntity>) {
            if (!this.etagEnabled()) return;
            const nextFields = ensureEtagField(filter.fields as any, etagProperties);
            if (nextFields !== filter.fields) {
                filter.fields = nextFields as Filter<CrudEntity>['fields'];
            }
        }

        allowedProperties(): {props: Set<string>; relations: Set<string>} {
            const props = new Set<string>(Object.keys(modelDefinition?.properties ?? {}));
            const relations = new Set<string>(Object.keys(modelRelations ?? {}));
            return {props, relations};
        }

        collectWhereFields(where: AnyObject | undefined, out: Set<string>) {
            if (!where || typeof where !== 'object') return;
            for (const [key, value] of Object.entries(where)) {
                if (key === 'and' || key === 'or') {
                    const list = Array.isArray(value) ? value : [];
                    for (const entry of list) this.collectWhereFields(entry as AnyObject, out);
                    continue;
                }
                out.add(key);
            }
        }

        validateFieldsStrict(filter: Filter<CrudEntity>) {
            if (!this.cfg?.strict) return;
            const {props, relations} = this.allowedProperties();

            if (filter.fields && typeof filter.fields === 'object' && !Array.isArray(filter.fields)) {
                for (const key of Object.keys(filter.fields as AnyObject)) {
                    if (!props.has(key) && !relations.has(key)) {
                        throw new HttpErrors.BadRequest(`Unknown property in $select: ${key}`);
                    }
                }
            }

            if (filter.order) {
                const list = Array.isArray(filter.order) ? filter.order : [filter.order];
                for (const item of list) {
                    const raw = String(item ?? '').trim();
                    const field = raw.split(/\s+/)[0];
                    if (field && !props.has(field)) {
                        throw new HttpErrors.BadRequest(`Unknown property in $orderby: ${field}`);
                    }
                }
            }

            if (filter.where) {
                const used = new Set<string>();
                this.collectWhereFields(filter.where as AnyObject, used);
                for (const field of used) {
                    if (!props.has(field)) {
                        throw new HttpErrors.BadRequest(`Unknown property in $filter: ${field}`);
                    }
                }
            }
        }

        ensureAcceptsJson() {
            if (!this.cfg?.strict) return;
            const accept = this.request.get('Accept') ?? (this.request.headers?.['accept'] as string | undefined);
            if (!accept || !accept.trim()) return; // no Accept means accept anything
            const lower = accept.toLowerCase();
            const ok = lower.includes('application/json') || lower.includes('*/*') || /application\s*\/\s*\*/.test(lower);
            if (!ok) {
                const err = new HttpErrors.NotAcceptable('Accept header must allow application/json.');
                (err as any).code = 'NotAcceptable';
                throw err;
            }
        }

        ensureJsonContentType() {
            if (!this.cfg?.strict) return;
            const type = this.request.get('Content-Type') ?? (this.request.headers?.['content-type'] as string | undefined);
            if (!type || !type.trim()) return; // let framework handle missing content-type
            const lower = type.toLowerCase();
            const ok = lower.includes('application/json') || lower.endsWith('+json');
            if (!ok) {
                const err = new HttpErrors.UnsupportedMediaType('Content-Type must be application/json.');
                (err as any).code = 'UnsupportedMediaType';
                throw err;
            }
        }

        buildIdWhere(id: unknown): Filter<CrudEntity>['where'] {
            const primary = idProperties[0] ?? 'id';
            return { [primary]: id } as Filter<CrudEntity>['where'];
        }

        buildConditionalWhere(
            id: unknown,
            expected: unknown[],
            allowAny: boolean,
        ): Filter<CrudEntity>['where'] {
            const idWhere = this.buildIdWhere(id);
            if (!this.etagEnabled() || allowAny || !expected.length) return idWhere;
            if ((etagProperties?.length ?? 0) <= 1) {
                const property = primaryEtagProperty!;
                const condition = expected.length > 1
                    ? { [property]: { inq: expected } }
                    : { [property]: expected[0] };
                return { and: [idWhere, condition] } as Filter<CrudEntity>['where'];
            }

            const compositeConditions = expected
                .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
                .map(token => {
                    const clauses = (etagProperties ?? []).map(prop => ({ [prop]: (token as Record<string, unknown>)[prop] }));
                    if (!clauses.length) return undefined;
                    if (clauses.length === 1) return clauses[0];
                    return { and: clauses };
                })
                .filter((value): value is Record<string, unknown> => Boolean(value));

            if (!compositeConditions.length) this.throwPreconditionFailed();

            const condition = compositeConditions.length === 1
                ? compositeConditions[0]
                : { or: compositeConditions };

            return { and: [idWhere, condition] } as Filter<CrudEntity>['where'];
        }

        parseIfMatchHeader() {
            const raw = this.request.get('If-Match') ?? (this.request.headers?.['if-match'] as string | undefined);
            return parseIfMatch(raw);
        }

        parseIfNoneMatchHeader() {
            const raw = this.request.get('If-None-Match') ?? (this.request.headers?.['if-none-match'] as string | undefined);
            return parseIfNoneMatch(raw);
        }

        throwPreconditionFailed(message = 'ETag does not match the current resource version.') {
            const error = new HttpErrors.PreconditionFailed(message);
            (error as any).code = 'PreconditionFailed';
            throw error;
        }

        setEtagHeaderFromPlain(plain?: AnyObject) {
            const etag = this.computeEtagFromPlain(plain);
            if (etag) {
                this.response.set('ETag', etag);
            }
            return etag;
        }

        async resolveSourceController(): Promise<any | undefined> {
            if (!sourceCtrlBindingKey) return undefined;
            try {
                return await this.httpCtx.get(sourceCtrlBindingKey as any);
            } catch {
                return undefined;
            }
        }

        hookMatches(op: CrudOperation, scope: CrudScope | undefined, meta: {op: CrudOperation; scope?: CrudScope}): boolean {
            if (meta.op !== op) return false;
            if (op !== 'READ') return true;
            if (!meta.scope) return true;
            return meta.scope === scope;
        }

        getHookMethods(op: CrudOperation, scope?: CrudScope) {
            const before = (hooks?.before ?? []).filter(h => this.hookMatches(op, scope, h)).map(h => h.methodName);
            const after = (hooks?.after ?? []).filter(h => this.hookMatches(op, scope, h)).map(h => h.methodName);
            const on = (hooks?.on ?? []).find(h => this.hookMatches(op, scope, h))?.methodName;
            return {before, after, on};
        }

        buildHookContext(base: Partial<CrudHookContext>): CrudHookContext {
            return {
                operation: base.operation!,
                scope: base.scope,
                entitySet: (def as unknown) as any,
                repository: this.repository,
                options: base.options,
                request: this.request,
                response: this.response,
                state: {},
                id: (base as any).id,
                payload: (base as any).payload,
                filter: (base as any).filter,
                result: undefined,
            } as CrudHookContext;
        }

        buildOnContext(ctx: CrudHookContext, helpers: CrudOnContext['helpers']): CrudOnContext {
            return Object.assign({} as CrudOnContext, ctx, {helpers});
        }

        helpersForEntity(entityContextStr: string) {
            const self = this;
            return {
                entity(plain: AnyObject | undefined) {
                    self.ensureODataHeaders();
                    if (plain) self.setEtagHeaderFromPlain(plain);
                    const decorated = self.decoratePlainEntity(plain ?? {}, self.computeEtagFromPlain(plain));
                    return {
                        '@odata.context': entityContextStr,
                        ...decorated,
                    } as AnyObject;
                },
                collection(items: Array<AnyObject | Entity>, totalCount?: number) {
                    self.ensureODataHeaders();
                    const values = items.map(it => self.toPlainEntity(it as any) ?? (it as AnyObject));
                    const decorated = self.decoratePlainEntities(values);
                    return {
                        '@odata.context': contextBase,
                        ...(totalCount !== undefined ? {'@odata.count': totalCount} : {}),
                        value: decorated,
                    } as AnyObject;
                },
                count(n: number) {
                    self.ensureODataHeaders();
                    return String(n);
                },
                noContent() {
                    self.ensureODataHeaders();
                    self.response.status(204).end();
                },
            };
        }

        async runBefore(op: CrudOperation, scope: CrudScope | undefined, ctx: CrudHookContext) {
            if (!hooks || (!hooks.before?.length)) return;
            const source = await this.resolveSourceController();
            if (!source) return;
            const names = this.getHookMethods(op, scope).before;
            for (const name of names) {
                if (typeof source[name] === 'function') {
                    await source[name](ctx);
                }
            }
        }

        async runOn(
            op: CrudOperation,
            scope: CrudScope | undefined,
            onCtx: CrudOnContext,
            next: () => Promise<unknown>,
        ): Promise<unknown> {
            const source = await this.resolveSourceController();
            const name = this.getHookMethods(op, scope).on;
            if (!source || !name || typeof source[name] !== 'function') {
                return next();
            }
            let nextCalled = false;
            const wrappedNext = async () => {
                nextCalled = true;
                return next();
            };
            const result = await source[name](onCtx, wrappedNext);
            if (!nextCalled) return result;
            return result ?? onCtx.result;
        }

        async runAfter(op: CrudOperation, scope: CrudScope | undefined, ctx: CrudHookContext) {
            if (this.response.headersSent) return; // don't mutate after commit
            if (!hooks || (!hooks.after?.length)) return;
            const source = await this.resolveSourceController();
            if (!source) return;
            const names = this.getHookMethods(op, scope).after;
            for (const name of names) {
                if (typeof source[name] !== 'function') continue;
                const maybe = await source[name](ctx);
                if (maybe !== undefined) {
                    ctx.result = maybe;
                }
            }
        }

        @get(`/odata/${setName}`, {
            responses: {
                '200': {
                    description: `List ${setName}`,
                    content: { 'application/json': { schema: collectionResponseSchema } },
                },
            },
        })
        async list(@filterParam filter?: Filter<CrudEntity>) {
            const preferences = this.parsePreferenceHeader();
            if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

            const baseFilter: Filter<CrudEntity> = filter ? { ...filter } : {};

            let inlineCountRequested = false;
            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
                );
                inlineCountRequested = parsed.inlineCount === true;
                if (inlineCountRequested && this.cfg && this.cfg.enableCount === false) {
                    throw new HttpErrors.BadRequest('The $count option is disabled by server configuration.');
                }
                const parsedFilter = { ...parsed } as Filter<CrudEntity> & { inlineCount?: boolean };
                delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
                this.mergeFilters(baseFilter, parsedFilter);
                this.ensureEtagField(baseFilter);
            } catch (error) {
                const message = (error as Error).message ?? 'Invalid OData query.';
                throw new HttpErrors.BadRequest(message);
            }

            // Enforce maxTop if configured
            const maxTop = this.cfg?.maxTop;
            if (Number.isFinite(maxTop as number) && (maxTop as number) > 0) {
                const cap = Number(maxTop);
                const requestedTopRaw = (this.request.query?.['$top'] as string | undefined) ?? undefined;
                const requested = requestedTopRaw != null ? Number(requestedTopRaw) : undefined;
                if (this.cfg?.strict && Number.isFinite(requested) && (requested as number) > cap) {
                    throw new HttpErrors.BadRequest(`The $top value (${requested}) exceeds the maximum allowed (${cap}).`);
                }
                if (!this.cfg?.strict) {
                    const current = typeof baseFilter.limit === 'number' ? baseFilter.limit : undefined;
                    baseFilter.limit = current == null ? cap : Math.min(current, cap);
                }
            }

            this.ensureEtagField(baseFilter);
            this.ensureAcceptsJson();
            this.validateFieldsStrict(baseFilter);

            const op: CrudOperation = 'READ';
            const scope: CrudScope = 'collection';
            const ctx = this.buildHookContext({operation: op, scope, filter: baseFilter as any, options: this.repositoryOptions()});
            await this.runBefore(op, scope, ctx);

            const execDefault = async () => {
                const options = this.repositoryOptions();
                const results = await this.repository.find(baseFilter, options);
                const plainResults = results.map(entity => this.toPlainEntity(entity) ?? {});
                let totalCount: number | undefined;

                if (inlineCountRequested) {
                    const where = baseFilter.where as Filter<CrudEntity>['where'];
                    const { count } = await this.repository.count(where as any, options);
                    totalCount = count;
                }

                this.ensureODataHeaders();
                const result = {
                    '@odata.context': contextBase,
                    ...(inlineCountRequested ? { '@odata.count': totalCount ?? results.length } : {}),
                    value: this.decoratePlainEntities(plainResults),
                } as AnyObject;
                ctx.result = result;
                return result;
            };

            const helpers = this.helpersForEntity(entityContext);
            const onCtx = this.buildOnContext(ctx, helpers);
            const res = await this.runOn(op, scope, onCtx, execDefault);
            ctx.result = res;
            await this.runAfter(op, scope, ctx);
            return ctx.result as AnyObject;
        }

        @get(`/odata/${setName}/$count`, {
            responses: {
                '200': {
                    description: `Count ${setName}`,
                    content: {
                        'text/plain': {
                            schema: {
                                type: 'string',
                            },
                        },
                    },
                },
            },
        })
        async count() {
            const preferences = this.parsePreferenceHeader();
            if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

            if (this.cfg && this.cfg.enableCount === false) {
                throw new HttpErrors.NotImplemented('Standalone $count is disabled by server configuration.');
            }

            const baseFilter: Filter<CrudEntity> = {};

            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
                );
                const parsedFilter = { ...parsed } as Filter<CrudEntity> & { inlineCount?: boolean };
                delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
                this.mergeFilters(baseFilter, parsedFilter);
            } catch (error) {
                const message = (error as Error).message ?? 'Invalid OData query.';
                throw new HttpErrors.BadRequest(message);
            }

            this.ensureAcceptsJson();
            this.validateFieldsStrict(baseFilter);

            const op: CrudOperation = 'READ';
            const scope: CrudScope = 'count';
            const ctx = this.buildHookContext({operation: op, scope, filter: baseFilter as any, options: this.repositoryOptions()});
            await this.runBefore(op, scope, ctx);

            const execDefault = async () => {
                const options = this.repositoryOptions();
                const where = baseFilter.where as Filter<CrudEntity>['where'];
                const { count } = await this.repository.count(where as any, options);
                this.ensureODataHeaders();
                const result = `${count}`;
                ctx.result = result;
                return result;
            };

            const helpers = this.helpersForEntity(entityContext);
            const onCtx = this.buildOnContext(ctx, helpers);
            const res = await this.runOn(op, scope, onCtx, execDefault);
            ctx.result = res;
            await this.runAfter(op, scope, ctx);
            return ctx.result as string;
        }

        @get(`/odata/${setName}/{id}`, {
            responses: {
                '200': {
                    description: `${setName} entity by id`,
                    content: { 'application/json': { schema: entityResponseSchema } },
                },
            },
        })
        async findById(
            @idParam id: unknown,
            @filterExcludingWhereParam filter?: FilterExcludingWhere<CrudEntity>,
        ) {
            const preferences = this.parsePreferenceHeader();
            if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

            const baseFilter: FilterExcludingWhere<CrudEntity> = filter ? { ...filter } : {};
            const options = this.repositoryOptions();
            this.ensureEtagField(baseFilter as Filter<CrudEntity>);
            const ifNoneMatch = this.parseIfNoneMatchHeader();

            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
                );
                const sanitized: Filter<CrudEntity> = {};
                if (parsed.fields) sanitized.fields = parsed.fields;
                if (parsed.include) sanitized.include = parsed.include;
                this.mergeFilters(baseFilter as Filter<CrudEntity>, sanitized);
                this.ensureEtagField(baseFilter as Filter<CrudEntity>);
            } catch (error) {
                const message = (error as Error).message ?? 'Invalid OData query.';
                throw new HttpErrors.BadRequest(message);
            }

            this.ensureAcceptsJson();
            this.validateFieldsStrict(baseFilter as Filter<CrudEntity>);

            const op: CrudOperation = 'READ';
            const scope: CrudScope = 'entity';
            const ctx = this.buildHookContext({operation: op, scope, id, filter: baseFilter as any, options: this.repositoryOptions()});
            await this.runBefore(op, scope, ctx);

            const execDefault = async () => {
                const options = this.repositoryOptions();
                const entity = await this.repository.findById(id as any, baseFilter, options);
                const plain = this.toPlainEntity(entity) ?? {};
                const etag = this.computeEtagFromPlain(plain);

                if (ifNoneMatch && !ifNoneMatch.any && etag && matchesEtag(etag, ifNoneMatch.values)) {
                    this.ensureODataHeaders();
                    this.setEtagHeaderFromPlain(plain);
                    this.response.status(304).end();
                    return undefined;
                }

                this.ensureODataHeaders();
                this.setEtagHeaderFromPlain(plain);
                const decorated = this.decoratePlainEntity(plain, etag);
                const result = {
                    '@odata.context': entityContext,
                    ...decorated,
                } as AnyObject;
                ctx.result = result;
                return result;
            };

            const helpers = this.helpersForEntity(entityContext);
            const onCtx = this.buildOnContext(ctx, helpers);
            const res = await this.runOn(op, scope, onCtx, execDefault);
            ctx.result = res;
            if (!this.response.headersSent) {
                await this.runAfter(op, scope, ctx);
            }
            return ctx.result as AnyObject | undefined;
        }

        @post(`/odata/${setName}`, {
            responses: {
                '200': {
                    description: `Create ${setName} entity`,
                    content: { 'application/json': { schema: entityResponseSchema } },
                },
            },
        })
        async create(
            @requestBody({
                content: {
                    'application/json': {
                        schema: getModelSchemaRef(modelCtor, {
                            title: `New${modelCtor.name ?? 'Entity'}`,
                            optional: optionalProperties as unknown as (keyof Entity)[],
                        }),
                    },
                },
            })
            payload: CrudEntity,
        ) {
            const preferences = this.parsePreferenceHeader();
            if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');
            this.ensureAcceptsJson();
            this.ensureJsonContentType();

            const op: CrudOperation = 'CREATE';
            const scope: CrudScope | undefined = undefined;
            const ctx = this.buildHookContext({operation: op, scope, payload: payload as AnyObject, options: this.repositoryOptions()});
            await this.runBefore(op, scope, ctx);

            const execDefault = async () => {
                const options = this.repositoryOptions();
                const preference = preferences.returnPreference;
                const created = await this.repository.create((ctx.payload ?? payload) as any, options);
                let entityForResponse: AnyObject | undefined = this.toPlainEntity(created);

                if (this.etagEnabled()) {
                    const hasEtag = this.computeEtagFromPlain(entityForResponse);
                    if (!hasEtag) {
                        const idKey = idProperties[0] ?? 'id';
                        const idValue = entityForResponse?.[idKey];
                        if (idValue != null) {
                            const fetched = await this.repository.findById(idValue as any, undefined, options);
                            entityForResponse = this.toPlainEntity(fetched);
                        }
                    }
                }

                const etag = this.computeEtagFromPlain(entityForResponse);
                const decorated = this.decoratePlainEntity(entityForResponse ?? {}, etag);
                this.ensureODataHeaders();
                this.setEtagHeaderFromPlain(entityForResponse);

                if (preference === 'minimal') {
                    this.applyPreference(preference);
                    this.response.status(204).end();
                    return undefined;
                }

                this.applyPreference(preference);
                const result = {
                    '@odata.context': entityContext,
                    ...decorated,
                } as AnyObject;
                ctx.result = result;
                return result;
            };

            const helpers = this.helpersForEntity(entityContext);
            const onCtx = this.buildOnContext(ctx, helpers);
            const res = await this.runOn(op, scope, onCtx, execDefault);
            ctx.result = res;
            if (!this.response.headersSent) {
                await this.runAfter(op, scope, ctx);
            }
            return ctx.result as AnyObject | undefined;
        }

        @patch(`/odata/${setName}/{id}`, {
            responses: {
                '200': {
                    description: `Update ${setName} entity`,
                    content: { 'application/json': { schema: entityResponseSchema } },
                },
            },
        })
        async update(
            @idParam id: unknown,
            @requestBody({
                content: {
                    'application/json': {
                        schema: getModelSchemaRef(modelCtor, {
                            title: `${modelCtor.name ?? 'Entity'}Patch`,
                            partial: true,
                        }),
                    },
                },
            })
            payload: Partial<CrudEntity>,
        ) {
            const preferences = this.parsePreferenceHeader();
            if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');
            this.ensureAcceptsJson();
            this.ensureJsonContentType();

            const op: CrudOperation = 'UPDATE';
            const scope: CrudScope | undefined = undefined;
            const ctx = this.buildHookContext({operation: op, scope, id, payload: payload as AnyObject, options: this.repositoryOptions()});
            await this.runBefore(op, scope, ctx);

            const execDefault = async () => {
                const options = this.repositoryOptions();
                const preference = preferences.returnPreference;
                const ifMatch = this.parseIfMatchHeader();

                if (this.etagEnabled() && this.cfg?.strict && !ifMatch) {
                    const error = new HttpErrors.PreconditionRequired('If-Match header is required when ETags are enabled.');
                    (error as any).code = 'PreconditionRequired';
                    throw error;
                }
                if (ifMatch && !ifMatch.any) {
                    const { values, invalidComposite } = decodeIfMatchValues(ifMatch.values ?? [], etagProperties, etagPropertyDefs);
                    if (invalidComposite || !values.length) this.throwPreconditionFailed();
                    const where = this.buildConditionalWhere(id, values, false);
                    const { count } = await this.repository.updateAll((ctx.payload ?? payload) as any, where, options);
                    if (!count) this.throwPreconditionFailed();
                } else {
                    await this.repository.updateById(id as any, (ctx.payload ?? payload) as any, options);
                }

                const updated = await this.repository.findById(id as any, undefined, options);
                const plain = this.toPlainEntity(updated) ?? {};
                const etag = this.computeEtagFromPlain(plain);
                const decorated = this.decoratePlainEntity(plain, etag);
                this.ensureODataHeaders();
                this.setEtagHeaderFromPlain(plain);

                if (preference === 'minimal') {
                    this.applyPreference(preference);
                    this.response.status(204).end();
                    return undefined;
                }

                this.applyPreference(preference);
                const result = {
                    '@odata.context': entityContext,
                    ...decorated,
                } as AnyObject;
                ctx.result = result;
                return result;
            };

            const helpers = this.helpersForEntity(entityContext);
            const onCtx = this.buildOnContext(ctx, helpers);
            const res = await this.runOn(op, scope, onCtx, execDefault);
            ctx.result = res;
            if (!this.response.headersSent) {
                await this.runAfter(op, scope, ctx);
            }
            return ctx.result as AnyObject | undefined;
        }

        @del(`/odata/${setName}/{id}`, {
            responses: {
                '204': {
                    description: `Delete ${setName} entity`,
                },
            },
        })
        async delete(@idParam id: unknown): Promise<void> {
            const preferences = this.parsePreferenceHeader();
            if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

            const op: CrudOperation = 'DELETE';
            const scope: CrudScope | undefined = undefined;
            const ctx = this.buildHookContext({operation: op, scope, id, options: this.repositoryOptions()});
            await this.runBefore(op, scope, ctx);

            const execDefault = async () => {
                const options = this.repositoryOptions();
                const ifMatch = this.parseIfMatchHeader();

                if (this.etagEnabled() && this.cfg?.strict && !ifMatch) {
                    const error = new HttpErrors.PreconditionRequired('If-Match header is required when ETags are enabled.');
                    (error as any).code = 'PreconditionRequired';
                    throw error;
                }
                if (ifMatch && !ifMatch.any) {
                    const { values, invalidComposite } = decodeIfMatchValues(ifMatch.values ?? [], etagProperties, etagPropertyDefs);
                    if (invalidComposite || !values.length) this.throwPreconditionFailed();
                    const where = this.buildConditionalWhere(id, values, false);
                    const { count } = await this.repository.deleteAll(where, options);
                    if (!count) this.throwPreconditionFailed();
                } else {
                    await this.repository.deleteById(id as any, options);
                }
                this.ensureODataHeaders();
                return undefined;
            };

            const helpers = this.helpersForEntity(entityContext);
            const onCtx = this.buildOnContext(ctx, helpers);
            const res = await this.runOn(op, scope, onCtx, execDefault);
            ctx.result = res;
            if (!this.response.headersSent) {
                await this.runAfter(op, scope, ctx);
            }
        }

        atomicityState(): AtomicityRequestState | undefined {
            return (this.request as any)[ODATA_ATOMICITY_STATE] as AtomicityRequestState | undefined;
        }

        repositoryOptions(): Options | undefined {
            const state = this.atomicityState();
            const transaction = state?.getTransaction(setName);
            return transaction ? { transaction } : undefined;
        }

        parsePreferenceHeader(): {returnPreference?: 'minimal' | 'representation'; respondAsync: boolean} {
            const header = this.request.get('Prefer') ?? (this.request.headers?.['prefer'] as string | undefined);
            const result: {returnPreference?: 'minimal' | 'representation'; respondAsync: boolean} = {
                respondAsync: false,
            };
            if (!header) return result;

            const tokens = String(header)
                .split(',')
                .map(token => token.trim())
                .filter(Boolean);

            for (const token of tokens) {
                const lower = token.toLowerCase();
                if (lower === 'respond-async') {
                    result.respondAsync = true;
                    continue;
                }
                if (lower.startsWith('return=')) {
                    const value = lower.split('=')[1];
                    if (value === 'minimal') {
                        result.returnPreference = 'minimal';
                    } else if (value === 'representation') {
                        result.returnPreference = 'representation';
                    }
                }
            }

            return result;
        }

        applyPreference(preference?: 'minimal' | 'representation') {
            if (!preference || this.response.headersSent) return;
            this.response.set('Preference-Applied', `return=${preference}`);
        }

        ensureODataHeaders() {
            if (this.response.headersSent) return;
            if (!this.response.getHeader('OData-Version')) {
                this.response.set('OData-Version', ODATA_VERSION);
            }
        }

        throwPreferenceNotSupported(target: string) {
            const error = new HttpErrors.NotImplemented(`Prefer ${target} is not supported.`);
            (error as any).code = 'PreferenceNotSupported';
            (error as any).target = target;
            throw error;
        }

        mergeFilters(target: Filter<CrudEntity>, source: Filter<CrudEntity>) {
            if (source.where) {
                if (target.where) {
                    target.where = {
                        and: [target.where, source.where],
                    } as Filter<CrudEntity>['where'];
                } else {
                    target.where = source.where;
                }
            }

            if (source.order) target.order = source.order;
            if (source.limit !== undefined) target.limit = source.limit;
            if (source.offset !== undefined) target.offset = source.offset;
            if (source.fields) {
                target.fields = {
                    ...(target.fields ?? {}),
                    ...source.fields,
                } as Filter<CrudEntity>['fields'];
            }

            if (source.include?.length) {
                const existing = target.include ?? [];
                target.include = mergeIncludes(existing, source.include);
            }

            this.ensureEtagField(target);
        }
    }
    const controllerMethodSet = collectControllerMethodNames(ODataCrudController);
    const derivedMethodAliases = deriveDefaultMethodAliases(controllerMethodSet, def.securityMetadata);
    const methodNameRemap = mergeMethodAliasMaps(derivedMethodAliases, def.securityMethodAliases);

    applyControllerSecurityMetadata(
        ODataCrudController,
        def.securityMetadata,
        Array.from(controllerMethodSet),
        methodNameRemap,
    );

    Object.defineProperty(ODataCrudController, 'name', {
        value: `${setName}ODataController`,
    });
    def.controllerCtor = ODataCrudController;
    return ODataCrudController;
}

function collectControllerMethodNames(controllerCtor: Function): Set<string> {
    const prototype = controllerCtor.prototype ?? {};
    const methods = new Set<string>();

    for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === 'constructor') continue;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (typeof descriptor?.value === 'function') {
            methods.add(name);
        }
    }

    return methods;
}

function deriveDefaultMethodAliases(
    controllerMethods: Set<string>,
    metadata: ControllerSecurityMetadata | undefined,
): MethodAliasMap | undefined {
    const methodMetadata = metadata?.methodMetadata;
    if (!methodMetadata) return undefined;

    const derived = new Map<string, string[]>();

    for (const methodName of Object.keys(methodMetadata)) {
        if (controllerMethods.has(methodName)) continue;

        const candidates: string[] = [];

        if (methodName === 'find' && controllerMethods.has('list')) {
            candidates.push('list');
        }

        if (methodName.endsWith('ById')) {
            const base = methodName.substring(0, methodName.length - 'ById'.length);
            if (base && controllerMethods.has(base)) {
                candidates.push(base);
            } else if (base === 'replace' && controllerMethods.has('update')) {
                candidates.push('update');
            }
        }

        if (!candidates.length) continue;

        const uniqueCandidates = Array.from(new Set(candidates));
        derived.set(methodName, uniqueCandidates);
    }

    if (!derived.size) return undefined;

    const result: MethodAliasMap = {};
    for (const [source, aliases] of derived.entries()) {
        result[source] = aliases.length === 1 ? aliases[0] : aliases;
    }
    return result;
}

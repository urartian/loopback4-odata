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
} from '@loopback/rest';
import {
    DefaultCrudRepository,
    Entity,
    Filter,
    FilterExcludingWhere,
    InclusionFilter,
    Options,
    RelationDefinitionMap,
} from '@loopback/repository';
import { EntitySetDef } from '../registry/entityset-registry';
import { parseODataQuery } from '../services/odata-query-parser.service';
import { ODATA_ATOMICITY_STATE } from '../constants';
import { AtomicityRequestState } from '../types/batch';
import { Response } from '@loopback/rest';
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
        type: 'object',
        required: ['@odata.context', 'value'],
        properties: {
            '@odata.context': { type: 'string' },
            value: getModelSchemaRef(modelCtor, { includeRelations: true }),
        },
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

    class ODataCrudController {
        constructor(
            @inject(repoBindingKey)
            public readonly repository: CrudRepo,
            @inject(RestBindings.Http.REQUEST)
            public readonly request: Request,
            @inject(RestBindings.Http.RESPONSE)
            public readonly response: Response,
        ) { }

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
                    { relations: modelRelations },
                );
                inlineCountRequested = parsed.inlineCount === true;
                const parsedFilter = { ...parsed } as Filter<CrudEntity> & { inlineCount?: boolean };
                delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
                this.mergeFilters(baseFilter, parsedFilter);
            } catch (error) {
                const message = (error as Error).message ?? 'Invalid OData query.';
                throw new HttpErrors.BadRequest(message);
            }

            const options = this.repositoryOptions();
            const results = await this.repository.find(baseFilter, options);
            let totalCount: number | undefined;

            if (inlineCountRequested) {
                const where = baseFilter.where as Filter<CrudEntity>['where'];
                const { count } = await this.repository.count(where as any, options);
                totalCount = count;
            }

            this.ensureODataHeaders();
            return {
                '@odata.context': contextBase,
                ...(inlineCountRequested ? { '@odata.count': totalCount ?? results.length } : {}),
                value: results,
            };
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

            const baseFilter: Filter<CrudEntity> = {};
            const options = this.repositoryOptions();

            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations },
                );
                const parsedFilter = { ...parsed } as Filter<CrudEntity> & { inlineCount?: boolean };
                delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
                this.mergeFilters(baseFilter, parsedFilter);
            } catch (error) {
                const message = (error as Error).message ?? 'Invalid OData query.';
                throw new HttpErrors.BadRequest(message);
            }

            const where = baseFilter.where as Filter<CrudEntity>['where'];
            const { count } = await this.repository.count(where as any, options);
            this.ensureODataHeaders();
            return `${count}`;
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

            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations },
                );
                const sanitized: Filter<CrudEntity> = {};
                if (parsed.fields) sanitized.fields = parsed.fields;
                if (parsed.include) sanitized.include = parsed.include;
                this.mergeFilters(baseFilter as Filter<CrudEntity>, sanitized);
            } catch (error) {
                const message = (error as Error).message ?? 'Invalid OData query.';
                throw new HttpErrors.BadRequest(message);
            }

            const entity = await this.repository.findById(id as any, baseFilter, options);
            this.ensureODataHeaders();
            return {
                '@odata.context': entityContext,
                value: entity,
            };
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
                            optional: idProperties as unknown as (keyof Entity)[],
                        }),
                    },
                },
            })
            payload: CrudEntity,
        ) {
            const preferences = this.parsePreferenceHeader();
            if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

            const options = this.repositoryOptions();
            const preference = preferences.returnPreference;
            const created = await this.repository.create(payload as any, options);

            if (preference === 'minimal') {
                this.ensureODataHeaders();
                this.applyPreference(preference);
                this.response.status(204).end();
                return;
            }

            this.ensureODataHeaders();
            this.applyPreference(preference);
            return {
                '@odata.context': entityContext,
                value: created,
            };
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

            const options = this.repositoryOptions();
            const preference = preferences.returnPreference;
            await this.repository.updateById(id as any, payload as any, options);

            if (preference === 'minimal') {
                this.ensureODataHeaders();
                this.applyPreference(preference);
                this.response.status(204).end();
                return;
            }

            const updated = await this.repository.findById(id as any, undefined, options);
            this.ensureODataHeaders();
            this.applyPreference(preference);
            return {
                '@odata.context': entityContext,
                value: updated,
            };
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

            const options = this.repositoryOptions();
            await this.repository.deleteById(id as any, options);
            this.ensureODataHeaders();
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
                this.response.set('OData-Version', '4.01');
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
        }
    }

    Object.defineProperty(ODataCrudController, 'name', {
        value: `${setName}ODataController`,
    });
    def.controllerCtor = ODataCrudController;
    return ODataCrudController;
}

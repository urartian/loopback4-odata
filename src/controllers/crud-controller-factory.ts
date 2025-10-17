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
    Where,
    Options,
    RelationDefinitionMap,
    PropertyDefinition,
    AnyObject,
    ModelDefinition,
} from '@loopback/repository';
import { EntitySetDef } from '../registry/entityset-registry';
import {
    parseODataQuery,
    AggregationSpec,
    AggregationOperator,
    LambdaExpression,
    ParsedExpression,
    FunctionArg,
    ApplyPipeline,
} from '../services/odata-query-parser.service';
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
import { ODataConfig, ODataApplyTelemetryEvent } from '../types';
import { getODataSearchableProps } from '../decorators/search.decorators';
import {ensureNavigationTargetKey} from '../util/relation-metadata';
import {ResolvedNavigationPath} from '../util/navigation-path';
import { ApplyExecutionPlan, ApplyAggregationStage, buildApplyExecutionPlan, collectNavigationPathsForStage } from '../services/odata-apply-planner.service';
import { ODataApplyExecutorRegistry, ODataApplyExecutorContext } from '../services/odata-apply-executor.registry';
type CrudEntity = Entity & { [key: string]: unknown };
type CrudRepo = DefaultCrudRepository<CrudEntity, unknown>;
type NormalizedInclusion = Exclude<InclusionFilter, string>;
type CrudWhere = Where<CrudEntity>;

type SearchAst =
    | { kind: 'term'; value: string }
    | { kind: 'and'; nodes: SearchAst[] }
    | { kind: 'or'; nodes: SearchAst[] }
    | { kind: 'not'; node: SearchAst };

type SearchToken =
    | { type: 'TERM'; value: string }
    | { type: 'AND' }
    | { type: 'OR' }
    | { type: 'NOT' }
    | { type: 'LPAREN' }
    | { type: 'RPAREN' };

interface SearchParseResult {
    node: SearchAst;
    termCount: number;
}

interface AggregationAccumulatorState {
    operator: AggregationOperator;
    sum?: number;
    count?: number;
    min?: number;
    max?: number;
    distinct?: Set<unknown>;
}

interface OrderDescriptor {
    field: string;
    direction: 'ASC' | 'DESC';
}

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
    const deepInsertEnabledForSet = Boolean(def.deepInsert);
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
            @inject(ODATA_BINDINGS.APPLY_EXECUTOR_REGISTRY)
            public readonly applyExecutors: ODataApplyExecutorRegistry,
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

        isDeepInsertEnabled(flagFromDefinition: boolean): boolean {
            if (def.deepInsert !== undefined) return Boolean(def.deepInsert);
            if (flagFromDefinition) return true;
            return Boolean(this.cfg?.enableDeepInsert);
        }

        async persistDeepInsertGraph(
            relationName: string,
            relationMeta: AnyObject,
            relationRepository: AnyObject,
            value: unknown,
            options: Options | undefined,
            visited: Set<AnyObject>,
            depth: number,
        ) {
            const maxDepth = this.cfg?.maxDeepInsertDepth ?? 10;
            if (depth > maxDepth) {
                throw new HttpErrors.BadRequest(`Deep insert exceeds maximum supported depth of ${maxDepth}.`);
            }

            const relationType = relationMeta?.type ?? relationMeta?.relationType;
            if (relationType !== 'hasMany' && relationType !== 'hasOne') {
                throw new HttpErrors.BadRequest(`Deep insert is only supported for hasOne/hasMany relations. Relation ${relationName} uses type ${relationType ?? 'unknown'}.`);
            }

            const targetCtor = typeof relationMeta.target === 'function' ? relationMeta.target() as typeof Entity : undefined;

            const createAndRecurse = async (payload: AnyObject) => {
                if (visited.has(payload)) {
                    throw new HttpErrors.BadRequest('Circular references detected in deep insert payload.');
                }
                visited.add(payload);

                const {root, children} = this.normalizeDeepInsertPayload(payload, targetCtor);
                const createdChild = await relationRepository.create(root, options);

                if (children && Object.keys(children).length) {
                    const childId = this.extractEntityId(createdChild);
                    if (childId == null) {
                        throw new HttpErrors.BadRequest(`Unable to determine identifier for nested entity on relation ${relationName}.`);
                    }
                    const targetRepository = typeof relationRepository.getTargetRepository === 'function'
                        ? await relationRepository.getTargetRepository()
                        : undefined;
                    const repoWithRelations = targetRepository ?? relationRepository;
                    for (const [childRelationName, childValue] of Object.entries(children)) {
                        if (childValue == null) continue;
                        const childMeta = (targetCtor?.definition as ModelDefinition | undefined)?.relations?.[childRelationName] as AnyObject | undefined;
                        if (!childMeta) {
                            if (this.cfg?.strict) {
                                throw new HttpErrors.BadRequest(`Unknown relation ${childRelationName} on ${targetCtor?.name ?? 'target'} for deep insert.`);
                            }
                            continue;
                        }
                        const childFactory = repoWithRelations?.[childRelationName];
                        if (typeof childFactory !== 'function') {
                            throw new HttpErrors.BadRequest(`Repository for relation ${relationName} does not expose a factory for ${childRelationName}.`);
                        }
                        const childRelationRepo = childFactory(childId);
                        if (!childRelationRepo || typeof childRelationRepo.create !== 'function') {
                            throw new HttpErrors.BadRequest(`Relation ${childRelationName} does not support create operations required for deep insert.`);
                        }
                        if (childMeta.targetsMany) {
                            const arrayValues = Array.isArray(childValue) ? childValue : [childValue];
                            for (const arrEntry of arrayValues) {
                                if (arrEntry == null) continue;
                                await this.persistDeepInsertGraph(childRelationName, childMeta, childRelationRepo, arrEntry, options, visited, depth + 1);
                            }
                        } else {
                            await this.persistDeepInsertGraph(childRelationName, childMeta, childRelationRepo, childValue, options, visited, depth + 1);
                        }
                    }
                }
                visited.delete(payload);
            };

            if (relationMeta.targetsMany) {
                const items = Array.isArray(value) ? value : [value];
                for (const item of items) {
                    if (item == null) continue;
                    const prepared = this.coercePayloadToObject(item);
                    await createAndRecurse(prepared);
                }
            } else {
                const prepared = this.coercePayloadToObject(value);
                await createAndRecurse(prepared);
            }
        }

        normalizeDeepInsertPayload(value: AnyObject, targetCtor?: typeof Entity): {root: AnyObject; children?: Record<string, unknown>} {
            const prepared: AnyObject = {...value};
            const children: Record<string, unknown> = {};
            if (targetCtor) {
                const definition = (targetCtor as {definition?: ModelDefinition}).definition as ModelDefinition | undefined;
                const childRelations = definition?.relations ?? {};
                for (const relationName of Object.keys(childRelations)) {
                    if (Object.prototype.hasOwnProperty.call(prepared, relationName)) {
                        children[relationName] = prepared[relationName];
                        delete prepared[relationName];
                    }
                }
            }
            return {
                root: prepared,
                children: Object.keys(children).length ? children : undefined,
            };
        }

        coercePayloadToObject(value: unknown): AnyObject {
            if (typeof value !== 'object' || value == null) {
                throw new HttpErrors.BadRequest('Deep insert payloads for related entities must be objects.');
            }
            return {...(value as AnyObject)};
        }

        resolveNavigationRelationMetadata(relationName: string): AnyObject {
            const relationMeta = modelRelations?.[relationName] as AnyObject | undefined;
            if (!relationMeta) {
                throw new HttpErrors.BadRequest(`Unknown relation ${relationName}.`);
            }
            if (relationMeta.through) {
                throw new HttpErrors.NotImplemented(`$ref operations are not supported for relation ${relationName} (through/ many-to-many).`);
            }
            if (!ensureNavigationTargetKey(relationMeta)) {
                throw new HttpErrors.NotImplemented(`Relation ${relationName} does not expose a foreign key (keyTo).`);
            }
            return relationMeta;
        }

        async linkNavigationRef(
            relationName: string,
            parentIdRaw: unknown,
            targetUri: string | undefined,
        ) {
            const parentId = this.coerceParentId(parentIdRaw);
            if (!targetUri) {
                throw new HttpErrors.BadRequest('Missing @odata.id in request body.');
            }
            const relationMeta = this.resolveNavigationRelationMetadata(relationName);
            const keyTo = relationMeta.keyTo as string;

            const {keyExpression} = this.parseODataIdReference(targetUri);
            const targetKeyLiteral = this.parseKeyLiteral(keyExpression);

            const repoWithRelations = this.repository as AnyObject;
            const factory = repoWithRelations[relationName];
            if (typeof factory !== 'function') {
                throw new HttpErrors.BadRequest(`Repository for ${setName} does not expose a relation factory for ${relationName}.`);
            }

            const relationRepo = factory(parentId, this.repositoryOptions());
            const targetRepo = await this.resolveTargetRepository(relationRepo, relationMeta);
            const targetId = this.coerceTargetId(targetRepo, targetKeyLiteral);

            const op: CrudOperation = 'LINK_NAVIGATION';
            const ctx = this.buildHookContext({
                operation: op,
                id: parentId,
                options: this.repositoryOptions(),
            });
            ctx.relationName = relationName;
            ctx.navigationTargetUri = targetUri;
            ctx.navigationTargetKey = targetKeyLiteral;
            ctx.navigationTargetId = targetId;
            ctx.navigationRelationRepository = relationRepo;
            ctx.navigationTargetRepository = targetRepo;

            await this.runBefore(op, undefined, ctx);

            const execDefault = async () => {
                const navRepo = (ctx.navigationTargetRepository ?? targetRepo) as AnyObject;
                const navId = ctx.navigationTargetId ?? targetId;
                if (navId == null) {
                    throw new HttpErrors.BadRequest('Navigation target identifier is required.');
                }
                const existing = await navRepo.findById(navId as any, undefined, this.repositoryOptions());
                ctx.navigationTargetId = navId;
                ctx.navigationTargetEntity = existing;
                const plain = this.toPlainEntity(existing) ?? {};
                plain[keyTo] = ctx.id ?? parentId;
                await navRepo.replaceById(navId as any, plain as AnyObject, this.repositoryOptions());
                return undefined;
            };

            const helpers = this.helpersForEntity(entityContext);
            const onCtx = this.buildOnContext(ctx, helpers);
            const res = await this.runOn(op, undefined, onCtx, execDefault);
            ctx.result = res;
            if (!this.response.headersSent) {
                await this.runAfter(op, undefined, ctx);
            }
            return ctx.result as AnyObject | undefined;
        }

        async unlinkNavigationRef(
            relationName: string,
            parentIdRaw: unknown,
            targetKeyRaw: string | undefined,
        ) {
            const parentId = this.coerceParentId(parentIdRaw);
            const relationMeta = this.resolveNavigationRelationMetadata(relationName);
            const keyTo = relationMeta.keyTo as string;

            const repoWithRelations = this.repository as AnyObject;
            const factory = repoWithRelations[relationName];
            if (typeof factory !== 'function') {
                throw new HttpErrors.BadRequest(`Repository for ${setName} does not expose a relation factory for ${relationName}.`);
            }

            const relationRepo = factory(parentId, this.repositoryOptions());
            const targetRepo = await this.resolveTargetRepository(relationRepo, relationMeta);

            const op: CrudOperation = 'UNLINK_NAVIGATION';
            const ctx = this.buildHookContext({
                operation: op,
                id: parentId,
                options: this.repositoryOptions(),
            });
            ctx.relationName = relationName;
            ctx.navigationTargetKey = targetKeyRaw;
            ctx.navigationRelationRepository = relationRepo;
            ctx.navigationTargetRepository = targetRepo;

            if (relationMeta.targetsMany) {
                if (!targetKeyRaw) {
                    throw new HttpErrors.BadRequest('Target key is required to remove a reference from a collection.');
                }
                const keyLiteral = this.parseKeyLiteral(targetKeyRaw);
                const targetId = this.coerceTargetId(targetRepo, keyLiteral);
                ctx.navigationTargetKey = keyLiteral;
                ctx.navigationTargetId = targetId;
            }

            await this.runBefore(op, undefined, ctx);

            const execDefault = async () => {
                const navRepo = (ctx.navigationTargetRepository ?? targetRepo) as AnyObject;
                if (relationMeta.targetsMany) {
                    const navId = ctx.navigationTargetId;
                    if (navId == null) {
                        throw new HttpErrors.BadRequest('Navigation target identifier is required.');
                    }
                    const existing = await navRepo.findById(navId as any, undefined, this.repositoryOptions());
                    ctx.navigationTargetId = navId;
                    ctx.navigationTargetEntity = existing;
                    const plain = this.toPlainEntity(existing) ?? {};
                    plain[keyTo] = null;
                    await navRepo.replaceById(navId as any, plain as AnyObject, this.repositoryOptions());
                    return;
                }

                const relationRepository = (ctx.navigationRelationRepository ?? relationRepo) as AnyObject;
                const existing = await relationRepository
                    .get?.(undefined, this.repositoryOptions())
                    .catch(() => undefined);
                if (!existing) return;
                ctx.navigationTargetEntity = existing;
                const navId = ctx.navigationTargetId ?? this.extractEntityId(existing);
                if (navId == null) return;
                ctx.navigationTargetId = navId;
                const plain = this.toPlainEntity(existing) ?? {};
                plain[keyTo] = null;
                await navRepo.replaceById(navId as any, plain as AnyObject, this.repositoryOptions());
            };

            const helpers = this.helpersForEntity(entityContext);
            const onCtx = this.buildOnContext(ctx, helpers);
            const res = await this.runOn(op, undefined, onCtx, execDefault);
            ctx.result = res;
            if (!this.response.headersSent) {
                await this.runAfter(op, undefined, ctx);
            }
            return ctx.result as AnyObject | undefined;
        }

        parseODataIdReference(reference: string): {entitySet: string; keyExpression: string} {
            let path = reference;
            try {
                const base = `${this.request.protocol}://${this.request.headers.host ?? ''}`;
                const url = new URL(reference, base);
                path = url.pathname;
            } catch {
                // ignore, treat as relative path
            }
            const match = /\/([^/]+)\((.+)\)/.exec(path);
            if (!match) {
                throw new HttpErrors.BadRequest(`Invalid @odata.id value: ${reference}`);
            }
            return {entitySet: match[1], keyExpression: match[2]};
        }

        parseKeyLiteral(raw: string): string {
            const decoded = decodeURIComponent(String(raw));
            let literal = decoded.trim();
            const guidPrefix = /^guid'/i;
            if (guidPrefix.test(literal)) {
                literal = literal.replace(guidPrefix, '');
                if (literal.endsWith("'")) literal = literal.slice(0, -1);
            }
            if (literal.startsWith("'") && literal.endsWith("'")) {
                literal = literal.slice(1, -1).replace(/''/g, "'");
            }
            return literal;
        }

        async resolveTargetRepository(relationRepo: AnyObject, relationMeta: AnyObject) {
            if (typeof relationRepo.getTargetRepository === 'function') {
                return relationRepo.getTargetRepository();
            }
            if (relationRepo.getTargetRepositoryDict) {
                const dict = relationRepo.getTargetRepositoryDict as Record<string, any>;
                const keys = Object.keys(dict);
                if (!keys.length) {
                    throw new HttpErrors.InternalServerError('Unable to resolve target repository for hasOne relation.');
                }
                const getter = dict[keys[0]];
                return getter();
            }
            throw new HttpErrors.NotImplemented(`Unable to resolve target repository for relation ${relationMeta?.name ?? '[unknown]'}.`);
        }

        coerceTargetId(targetRepo: CrudRepo | AnyObject, literal: string): unknown {
            const entityClass = (targetRepo as AnyObject).entityClass as typeof Entity | undefined;
            const idProps = entityClass?.getIdProperties?.() ?? [];
            const idName = idProps[0] ?? 'id';
            const idDef = (entityClass as AnyObject)?.definition?.properties?.[idName];
            const type = idDef?.type;
            if (type === Number || type === 'number') {
                const num = Number(literal);
                if (Number.isNaN(num)) {
                    throw new HttpErrors.BadRequest(`Invalid numeric identifier: ${literal}`);
                }
                return num;
            }
            if (type === Boolean || type === 'boolean') {
                if (literal === 'true') return true;
                if (literal === 'false') return false;
            }
            return literal;
        }

        coerceParentId(raw: unknown): unknown {
            if (typeof raw !== 'string') return raw;
            const idName = idProperties[0];
            const idDef = modelDefinition?.properties?.[idName];
            const type = idDef?.type;
            if (type === Number || type === 'number') {
                const num = Number(raw);
                if (Number.isNaN(num)) {
                    throw new HttpErrors.BadRequest(`Invalid identifier: ${raw}`);
                }
                return num;
            }
            if (type === Boolean || type === 'boolean') {
                if (raw === 'true') return true;
                if (raw === 'false') return false;
            }
            return raw;
        }

        extractEntityId(entity: CrudEntity | AnyObject | undefined): unknown {
            if (!entity) return undefined;
            const repoAny = this.repository as CrudRepo & {entityClass?: typeof Entity};
            try {
                const idFromRepo = repoAny.entityClass?.getIdOf?.(entity as AnyObject);
                if (idFromRepo != null) return idFromRepo;
            } catch { /* noop */ }
            const plain = this.toPlainEntity(entity as AnyObject) ?? undefined;
            if (!plain) return undefined;
            if (idProperties.length === 1) {
                return plain[idProperties[0]];
            }
            return undefined;
        }

        async reloadEntityForResponse(entity: CrudEntity | AnyObject | undefined, options?: Options) {
            const id = this.extractEntityId(entity);
            if (id == null) return undefined;
            try {
                return await this.repository.findById(id as any, undefined, options);
            } catch {
                return undefined;
            }
        }

        executeAggregation(rows: AnyObject[], stage: ApplyAggregationStage): AnyObject[] {
            const spec = stage.spec;
            const navigationGroups = this.groupNavigationPaths(stage.navigationPaths ?? []);
            const groupMap = new Map<string, {groupValues: Record<string, unknown>; aggregates: Record<string, AggregationAccumulatorState>}>();

            for (const row of rows) {
                const variants = this.expandNavigationVariants(row, navigationGroups);
                const variantList = variants.length ? variants : [{values: {}}];

                for (const variant of variantList) {
                    const groupValues: Record<string, unknown> = {};
                    const keyParts: unknown[] = [];

                    for (const field of spec.groupBy) {
                        const value = this.resolveVariantValue(row, variant, field);
                        groupValues[field] = value;
                        keyParts.push(value);
                    }

                    const key = JSON.stringify(keyParts);
                    let entry = groupMap.get(key);
                    if (!entry) {
                        const aggregates: Record<string, AggregationAccumulatorState> = {};
                        for (const aggregate of spec.aggregates) {
                            aggregates[aggregate.alias] = this.createAccumulatorState(aggregate.operator);
                        }
                        entry = {groupValues, aggregates};
                        groupMap.set(key, entry);
                    }

                    for (const aggregate of spec.aggregates) {
                        const value = aggregate.field ? this.resolveVariantValue(row, variant, aggregate.field) : undefined;
                        this.updateAccumulatorState(entry.aggregates[aggregate.alias], value);
                    }
                }
            }

            const results: AnyObject[] = [];
            for (const {groupValues, aggregates} of groupMap.values()) {
                const record: AnyObject = {};
                for (const [field, value] of Object.entries(groupValues)) {
                    record[field] = value;
                }
                for (const [alias, state] of Object.entries(aggregates)) {
                    record[alias] = this.finalizeAccumulatorState(state);
                }
                results.push(record);
            }

            return results;
        }

        groupNavigationPaths(paths: ResolvedNavigationPath[]): Map<string, ResolvedNavigationPath[]> {
            const groups = new Map<string, ResolvedNavigationPath[]>();
            for (const path of paths) {
                if (!path.joins.length) continue;
                const key = path.joins.map(j => j.relationName).join('/');
                const existing = groups.get(key);
                if (existing) {
                    existing.push(path);
                } else {
                    groups.set(key, [path]);
                }
            }
            return groups;
        }

        expandNavigationVariants(row: AnyObject, groups: Map<string, ResolvedNavigationPath[]>): Array<{values: Record<string, unknown>}> {
            const maxFanout = this.cfg?.maxApplyNavigationFanout ?? 1000;
            let variants: Array<{values: Record<string, unknown>}> = [{values: {}}];

            for (const paths of groups.values()) {
                const primaryPath = paths[0];
                const targets = this.collectNavigationTargets(row, primaryPath);
                const safeTargets = targets.length ? targets : [undefined];
                const next: Array<{values: Record<string, unknown>}> = [];

                for (const variant of variants) {
                    for (const target of safeTargets) {
                        const values = {...variant.values};
                        for (const path of paths) {
                            values[path.originalPath] = this.resolvePropertyFromTarget(target as AnyObject | undefined, path.propertyPath);
                        }
                        next.push({values});
                        if (next.length > maxFanout) {
                            throw new HttpErrors.BadRequest(`$apply navigation expansion exceeds the configured limit of ${maxFanout} combinations.`);
                        }
                    }
                }

                variants = next;
            }

            if (variants.length > maxFanout) {
                throw new HttpErrors.BadRequest(`$apply navigation expansion exceeds the configured limit of ${maxFanout} combinations.`);
            }

            return variants;
        }

        collectNavigationTargets(row: AnyObject, path: ResolvedNavigationPath): AnyObject[] {
            let current: Array<AnyObject | undefined> = [row];

            for (const segment of path.joins) {
                const next: Array<AnyObject | undefined> = [];
                for (const item of current) {
                    const source = item as AnyObject | undefined;
                    if (source == null) {
                        next.push(undefined);
                        continue;
                    }
                    const related = source[segment.relationName];
                    if (Array.isArray(related)) {
                        if (!related.length) {
                            next.push(undefined);
                        } else {
                            for (const entry of related) next.push(entry as AnyObject);
                        }
                    } else if (related != null) {
                        next.push(related as AnyObject);
                    } else {
                        next.push(undefined);
                    }
                }
                current = next.length ? next : [undefined];
            }

            return current as AnyObject[];
        }

        resolvePropertyFromTarget(target: AnyObject | undefined, propertyPath?: string): unknown {
            if (!propertyPath) return target;
            const segments = propertyPath.split('/').filter(Boolean);
            let current: any = target;
            for (const segment of segments) {
                if (current == null) return undefined;
                current = current[segment];
            }
            return current;
        }

        resolveVariantValue(row: AnyObject, variant: {values: Record<string, unknown>}, path: string): unknown {
            if (variant.values && Object.prototype.hasOwnProperty.call(variant.values, path)) {
                return variant.values[path];
            }
            if (!path.includes('/')) {
                return this.getValueAtPath(row, path);
            }
            const segments = path.split('/');
            const values = this.extractPathValues(row, segments);
            return values.length ? values[0] : undefined;
        }

        extractPathValues(source: AnyObject | undefined, segments: string[], index = 0): unknown[] {
            if (index >= segments.length) {
                return [source];
            }
            if (source == null) return [undefined];
            const segment = segments[index];
            const next = (source as AnyObject)[segment];
            if (Array.isArray(next)) {
                if (!next.length) return [undefined];
                const results: unknown[] = [];
                for (const entry of next) {
                    results.push(...this.extractPathValues(entry as AnyObject, segments, index + 1));
                }
                return results;
            }
            return this.extractPathValues(next as AnyObject, segments, index + 1);
        }

        createAccumulatorState(operator: AggregationOperator): AggregationAccumulatorState {
            return {
                operator,
                sum: operator === 'sum' || operator === 'average' ? 0 : undefined,
                count: operator === 'count' || operator === 'average' ? 0 : undefined,
                min: undefined,
                max: undefined,
                distinct: operator === 'countdistinct' ? new Set<unknown>() : undefined,
            };
        }

        updateAccumulatorState(state: AggregationAccumulatorState, rawValue: unknown): void {
            switch (state.operator) {
                case 'sum': {
                    const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
                    if (Number.isFinite(num)) {
                        state.sum = (state.sum ?? 0) + num;
                    }
                    break;
                }
                case 'average': {
                    const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
                    if (Number.isFinite(num)) {
                        state.sum = (state.sum ?? 0) + num;
                        state.count = (state.count ?? 0) + 1;
                    }
                    break;
                }
                case 'min': {
                    const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
                    if (Number.isFinite(num)) {
                        state.min = state.min === undefined ? num : Math.min(state.min, num);
                    }
                    break;
                }
                case 'max': {
                    const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
                    if (Number.isFinite(num)) {
                        state.max = state.max === undefined ? num : Math.max(state.max, num);
                    }
                    break;
                }
                case 'count': {
                    state.count = (state.count ?? 0) + 1;
                    break;
                }
                case 'countdistinct': {
                    if (!state.distinct) state.distinct = new Set();
                    state.distinct.add(rawValue);
                    break;
                }
                default:
                    break;
            }
        }

        finalizeAccumulatorState(state: AggregationAccumulatorState): unknown {
            switch (state.operator) {
                case 'sum':
                    return state.sum ?? 0;
                case 'average':
                    if (!state.count || state.count === 0) return null;
                    return (state.sum ?? 0) / state.count;
                case 'min':
                    return state.min ?? null;
                case 'max':
                    return state.max ?? null;
                case 'count':
                    return state.count ?? 0;
                case 'countdistinct':
                    return state.distinct ? state.distinct.size : 0;
                default:
                    return null;
            }
        }



        orderResults(data: AnyObject[], order?: string[]): AnyObject[] {
            if (!order?.length) return data;
            const descriptors = order
                .map(entry => entry.trim())
                .filter(Boolean)
                .map(part => {
                    const [field, direction] = part.split(/\s+/);
                    return {
                        field,
                        direction: direction?.toUpperCase() === 'DESC' ? -1 : 1,
                    };
                })
                .filter(item => item.field);
            if (!descriptors.length) return data;

            const sorted = [...data];
            sorted.sort((a, b) => {
                for (const descriptor of descriptors) {
                    const av = (a as AnyObject)[descriptor.field];
                    const bv = (b as AnyObject)[descriptor.field];
                    if (av === bv) continue;
                    if (av == null) return 1 * descriptor.direction;
                    if (bv == null) return -1 * descriptor.direction;
                    if (typeof av === 'number' && typeof bv === 'number') {
                        if (av < bv) return -1 * descriptor.direction;
                        if (av > bv) return 1 * descriptor.direction;
                        continue;
                    }
                    const aStr = String(av);
                    const bStr = String(bv);
                    if (aStr < bStr) return -1 * descriptor.direction;
                    if (aStr > bStr) return 1 * descriptor.direction;
                }
                return 0;
            });
            return sorted;
        }

        sliceResults(data: AnyObject[], offset?: number, limit?: number): AnyObject[] {
            let result = data;
            if (typeof offset === 'number' && offset > 0) {
                result = result.slice(offset);
            }
            if (typeof limit === 'number' && limit >= 0) {
                result = result.slice(0, limit);
            }
            return result;
        }

        applyPostFilter(data: AnyObject[], expr?: ParsedExpression): AnyObject[] {
            if (!expr) return data;
            return data.filter(entity => this.evaluatePredicate(expr, entity, '', entity));
        }

        applyPostFilters(data: AnyObject[], expressions: ParsedExpression[]): AnyObject[] {
            if (!expressions.length) return data;
            let result = data;
            for (const expr of expressions) {
                result = this.applyPostFilter(result, expr);
            }
            return result;
        }

        collectAggregationRelations(plan: ApplyExecutionPlan | undefined): string[] {
            if (!plan?.stages?.length) return [];
            const relations = new Set<string>();
            const addRelation = (name?: string) => {
                if (!name) return;
                if (!(modelRelations as Record<string, unknown>)[name]) return;
                relations.add(name);
            };
            for (const stage of plan.stages) {
                stage.navigationPaths.forEach(path => {
                    const firstJoin = path.joins[0];
                    if (firstJoin) addRelation(firstJoin.relationName);
                });
                stage.spec.groupBy.forEach(field => {
                    if (field?.includes('/')) {
                        const [head] = field.split('/');
                        addRelation(head);
                    }
                });
                for (const aggregate of stage.spec.aggregates) {
                    const field = aggregate.field;
                    if (field?.includes('/')) {
                        const [head] = field.split('/');
                        addRelation(head);
                    }
                }
            }
            return Array.from(relations);
        }

        getValueAtPath(source: AnyObject, path: string): unknown {
            if (!path) return undefined;
            if (!path.includes('/')) return (source as AnyObject)?.[path];
            const segments = path.split('/');
            let current: unknown = source;
            for (const segment of segments) {
                if (current == null) return undefined;
                if (Array.isArray(current)) {
                    return undefined;
                }
                current = (current as AnyObject)[segment];
            }
            return current;
        }

        logApplyFallback(event: string, detail: { entitySet: string; transformations?: number; rows?: number; limit?: number }) {
            const payload = { event, ...detail };
            this.cfg?.onApplyFallback?.(payload);
            if (this.cfg?.logApplyFallbacks) {
                console.warn(`[OData] $apply fallback (${event}) ${JSON.stringify(detail)}`);
            }
        }

        emitApplyTelemetry(
            mode: 'pushdown' | 'fallback',
            stageIndex: number,
            stageCount: number,
            data: { rows?: number; durationMs?: number; joinCount?: number; reason?: string } = {},
        ) {
            if (!this.cfg?.onApplyTelemetry && !this.cfg?.logApplyTelemetry) return;
            const event: ODataApplyTelemetryEvent = {
                entitySet: setName,
                stageIndex,
                stageCount,
                mode,
                rows: data.rows,
                durationMs: data.durationMs,
                joinCount: data.joinCount,
                reason: data.reason,
            };
            if (this.cfg?.onApplyTelemetry) {
                try {
                    this.cfg.onApplyTelemetry(event);
                } catch (err) {
                    console.error('[OData] Failed to emit apply telemetry handler:', err);
                }
            }
            if (this.cfg?.logApplyTelemetry) {
                const parts = [`mode=${mode}`, `stage=${stageIndex + 1}/${stageCount}`];
                if (data.rows !== undefined) parts.push(`rows=${data.rows}`);
                if (data.durationMs !== undefined) parts.push(`durationMs=${data.durationMs}`);
                if (data.joinCount !== undefined) parts.push(`joins=${data.joinCount}`);
                if (data.reason) parts.push(`reason=${data.reason}`);
                console.debug(`[OData] $apply telemetry (${setName}) ${parts.join(' ')}`);
            }
        }

        async tryExecuteApplyPushdown(
            aggregation: AggregationSpec,
            plan: ApplyExecutionPlan | undefined,
            pipeline: ApplyPipeline | undefined,
            fetchFilter: Filter<CrudEntity>,
            baseFilter: Filter<CrudEntity>,
            requestedOffset: number,
            requestedLimit: number | undefined,
            postFilterExpr: ParsedExpression | undefined,
            contextBase: string,
            options: Options | undefined,
            _stage: ApplyAggregationStage | undefined,
            stageIndex: number,
            stageCount: number,
        ): Promise<AnyObject | undefined> {
            if (!def.applyPushdown || !def.applyExecutorId) return undefined;
            const registry = this.applyExecutors;
            if (!registry) return undefined;
            const executor = registry.get(def.applyExecutorId);
            if (!executor) return undefined;

            const emitReason = (reason: string) => {
                this.emitApplyTelemetry('pushdown', stageIndex, stageCount || 1, {reason});
            };

            const cloneExpression = (expression: ParsedExpression): ParsedExpression =>
                JSON.parse(JSON.stringify(expression));

            const cloneStage = (stageToClone: ApplyAggregationStage): ApplyAggregationStage => ({
                spec: {
                    groupBy: [...stageToClone.spec.groupBy],
                    aggregates: stageToClone.spec.aggregates.map(expr => ({...expr})),
                },
                postAggregationFilters: stageToClone.postAggregationFilters.map(cloneExpression),
                orderBy: stageToClone.orderBy ? stageToClone.orderBy.map(item => ({...item})) : undefined,
                top: stageToClone.top,
                skip: stageToClone.skip,
                navigationPaths: stageToClone.navigationPaths
                    ? stageToClone.navigationPaths.map(path => ({
                        ...path,
                        joins: path.joins.map(join => ({...join})),
                    }))
                    : [],
            });

            const clonePlan = (sourcePlan?: ApplyExecutionPlan): ApplyExecutionPlan | undefined => {
                if (!sourcePlan) return undefined;
                return {
                    pushdownWhere: sourcePlan.pushdownWhere,
                    preAggregationFilters: [...sourcePlan.preAggregationFilters],
                    stages: sourcePlan.stages.map(cloneStage),
                };
            };

            const buildFallbackPlan = (): ApplyExecutionPlan | undefined => {
                if (!aggregation?.aggregates?.length) return undefined;
                const spec: AggregationSpec = {
                    groupBy: [...aggregation.groupBy],
                    aggregates: aggregation.aggregates.map(expr => ({...expr})),
                };
                let navigationPaths: ReturnType<typeof collectNavigationPathsForStage> = [];
                try {
                    navigationPaths = collectNavigationPathsForStage(
                        def.modelCtor,
                        spec,
                        this.cfg?.maxExpandDepth ?? 5,
                    );
                } catch {
                    navigationPaths = [];
                }
                return {
                    pushdownWhere: undefined,
                    preAggregationFilters: [],
                    stages: [
                        {
                            spec,
                            postAggregationFilters: [],
                            navigationPaths,
                        },
                    ],
                };
            };

            const executionPlan = clonePlan(plan) ?? buildFallbackPlan();
            if (!executionPlan) {
                emitReason('no-plan');
                return undefined;
            }
            const planStages = executionPlan.stages ?? [];
            if (!planStages.length) {
                emitReason('no-stage');
                return undefined;
            }
            if (executionPlan.preAggregationFilters.length) {
                emitReason('pre-filters');
                return undefined;
            }

            const effectivePipeline: ApplyPipeline = pipeline ?? {transformations: []};
            const fetchFilterCopy: Filter<CrudEntity> = {...fetchFilter};
            if (fetchFilter.where) {
                fetchFilterCopy.where = {...(fetchFilter.where as CrudWhere)} as CrudWhere;
            }
            if (Array.isArray(fetchFilter.include)) {
                fetchFilterCopy.include = [...fetchFilter.include];
            }

            const context: ODataApplyExecutorContext = {
                entitySet: def,
                repository: this.repository,
                plan: executionPlan,
                pipeline: effectivePipeline,
                aggregation,
                baseFilter: {...baseFilter},
                fetchFilter: fetchFilterCopy,
                options,
                requestedLimit,
                requestedOffset,
                stageIndex,
                stageCount: planStages.length,
                telemetry: payload => {
                    this.emitApplyTelemetry('pushdown', stageIndex, planStages.length, {
                        rows: payload.rows,
                        durationMs: payload.durationMs,
                        joinCount: payload.joinCount,
                    });
                },
            };

            try {
                const execResult = await executor.execute(context);
                if (!execResult) {
                    this.emitApplyTelemetry('pushdown', stageIndex, planStages.length, {
                        reason: 'executor-declined',
                    });
                    this.logApplyFallback('executor-declined', {
                        entitySet: setName,
                        transformations: effectivePipeline.transformations.length,
                        rows: 0,
                    });
                    return undefined;
                }

                let working = execResult.rows ?? [];

                const requiresStageFilters = planStages.some(item => item.postAggregationFilters.length > 0);
                if (requiresStageFilters && execResult.appliedStageFilters !== true) {
                    emitReason('missing-stage-filters');
                    this.logApplyFallback('stage-filters-not-applied', {
                        entitySet: setName,
                        transformations: effectivePipeline.transformations.length,
                        rows: execResult.rows?.length ?? 0,
                    });
                    return undefined;
                }

                const requiresStagePagination = planStages.some(
                    item => item.top !== undefined || item.skip !== undefined,
                );
                if (requiresStagePagination && execResult.appliedPipelinePagination !== true) {
                    emitReason('missing-stage-pagination');
                    this.logApplyFallback('stage-pagination-not-applied', {
                        entitySet: setName,
                        transformations: effectivePipeline.transformations.length,
                        rows: execResult.rows?.length ?? 0,
                    });
                    return undefined;
                }
                if (postFilterExpr) {
                    working = this.applyPostFilter(working, postFilterExpr);
                }

                const finalStage = planStages[planStages.length - 1];
                const stageOrderClauses = finalStage?.orderBy?.map(item => `${item.field} ${item.direction.toUpperCase()}`);
                const fallbackOrder = Array.isArray(baseFilter.order)
                    ? baseFilter.order
                    : typeof baseFilter.order === 'string'
                        ? [baseFilter.order]
                        : undefined;
                let ordered = working;
                if (stageOrderClauses?.length) {
                    if (execResult.appliedOrder !== true) {
                        ordered = this.orderResults(working, stageOrderClauses);
                    }
                } else if (fallbackOrder) {
                    ordered = this.orderResults(working, fallbackOrder);
                }
                const paged = execResult.appliedExternalPagination
                    ? ordered
                    : this.sliceResults(ordered, requestedOffset, requestedLimit);

                this.ensureODataHeaders();
                return {
                    '@odata.context': contextBase,
                    value: paged,
                } as AnyObject;
            } catch (error) {
                this.emitApplyTelemetry('pushdown', stageIndex, planStages.length, {
                    reason: 'executor-error',
                });
                this.logApplyFallback('executor-error', {
                    entitySet: setName,
                    transformations: effectivePipeline.transformations.length ?? 0,
                    rows: 0,
                });
                return undefined;
            }
        }

        resolveFunctionArgValue(arg: FunctionArg, current: AnyObject, alias: string, root: AnyObject): unknown {
            if (arg.kind === 'literal') return arg.value;
            const raw = this.resolvePredicateValue(arg.name, current, alias, root);
            if (raw == null) return raw;
            if (typeof raw === 'string') {
                if (arg.transform === 'tolower') return raw.toLowerCase();
                if (arg.transform === 'toupper') return raw.toUpperCase();
                return raw;
            }
            if (arg.transform) {
                const str = String(raw);
                return arg.transform === 'tolower' ? str.toLowerCase() : str.toUpperCase();
            }
            return raw;
        }

        evaluateStringFunction(expr: Extract<ParsedExpression, {operator: 'stringfncmp'}>, current: AnyObject, alias: string, root: AnyObject): string | undefined {
            switch (expr.name) {
                case 'trim': {
                    const value = this.resolveFunctionArgValue(expr.args[0], current, alias, root);
                    if (value == null) return undefined;
                    return String(value).trim();
                }
                case 'concat': {
                    const parts = expr.args.map(arg => {
                        const value = this.resolveFunctionArgValue(arg, current, alias, root);
                        return value == null ? '' : String(value);
                    });
                    return parts.join('');
                }
                default:
                    return undefined;
            }
        }

        extractDatePart(value: unknown, part: 'month' | 'day' | 'hour' | 'minute' | 'second'): number | undefined {
            const date =
                value instanceof Date
                    ? value
                    : typeof value === 'string' || typeof value === 'number'
                        ? new Date(value)
                        : undefined;
            if (!date || Number.isNaN(date.getTime())) return undefined;
            switch (part) {
                case 'month':
                    return date.getUTCMonth() + 1;
                case 'day':
                    return date.getUTCDate();
                case 'hour':
                    return date.getUTCHours();
                case 'minute':
                    return date.getUTCMinutes();
                case 'second':
                    return date.getUTCSeconds();
                default:
                    return undefined;
            }
        }

        ensureLambdaInclusion(filter: Filter<CrudEntity>, lambda: LambdaExpression) {
            if (!lambda.path.length) {
                throw new HttpErrors.BadRequest('Lambda expressions must reference a navigation property.');
            }
            const includeList = this.normalizeIncludeList(filter.include);
            this.ensureIncludePath(includeList, lambda.path);
            filter.include = includeList;
            this.ensureLambdaFieldProjection(filter, lambda.path[0]);
        }

        cloneIncludeEntry(entry: string | InclusionFilter): NormalizedInclusion {
            if (typeof entry === 'string') {
                return {relation: entry};
            }
            const scope = entry.scope ? {...entry.scope} : undefined;
            if (scope && scope.include) {
                if (Array.isArray(scope.include)) {
                    scope.include = scope.include.map(item => this.cloneIncludeEntry(item));
                } else {
                    scope.include = [this.cloneIncludeEntry(scope.include)];
                }
            }
            return {relation: entry.relation, scope};
        }

        normalizeIncludeList(include: Filter<CrudEntity>['include']): NormalizedInclusion[] {
            if (!include) return [];
            if (Array.isArray(include)) {
                return include.map(entry => this.cloneIncludeEntry(entry));
            }
            return [this.cloneIncludeEntry(include)];
        }

        ensureIncludePath(include: NormalizedInclusion[], path: string[]) {
            const [current, ...rest] = path;
            if (!current) return;
            let entry = include.find(item => item.relation === current);
            if (!entry) {
                entry = rest.length ? {relation: current, scope: {include: []}} : {relation: current};
                include.push(entry);
            }
            if (!rest.length) return;
            entry.scope = entry.scope ?? {};
            const rawInclude = entry.scope.include;
            const nested = Array.isArray(rawInclude)
                ? rawInclude.map(item => this.cloneIncludeEntry(item))
                : rawInclude
                    ? [this.cloneIncludeEntry(rawInclude)]
                    : [];
            this.ensureIncludePath(nested, rest);
            entry.scope.include = nested;
        }

        ensureLambdaFieldProjection(filter: Filter<CrudEntity>, relation: string | undefined) {
            if (!relation) return;
            if (!filter.fields) return;
            if (Array.isArray(filter.fields)) {
                if (!filter.fields.includes(relation)) filter.fields.push(relation);
                return;
            }
            if (typeof filter.fields === 'string') {
                if (filter.fields !== relation) {
                    filter.fields = [filter.fields, relation];
                }
                return;
            }
            if (typeof filter.fields === 'object') {
                filter.fields[relation] = true;
            }
        }

        resolveCollectionPath(source: AnyObject, segments: string[]): AnyObject[] {
            let current: unknown[] = [source];
            for (const segment of segments) {
                const next: unknown[] = [];
                for (const item of current) {
                    if (item == null) continue;
                    const value = (item as AnyObject)[segment];
                    if (Array.isArray(value)) {
                        next.push(...value);
                    } else if (value != null) {
                        next.push(value);
                    }
                }
                current = next;
            }
            return current.filter(item => item != null) as AnyObject[];
        }

        filterEntitiesByLambda(entities: AnyObject[], lambda: LambdaExpression): AnyObject[] {
            return entities.filter(entity => this.evaluateLambda(entity, lambda));
        }

        evaluateLambda(entity: AnyObject, lambda: LambdaExpression): boolean {
            const items = this.resolveCollectionPath(entity, lambda.path);
            if (lambda.type === 'any') {
                return items.some(item => this.evaluatePredicate(lambda.predicate, item, lambda.alias, entity));
            }
            // all
            if (!items.length) return true;
            return items.every(item => this.evaluatePredicate(lambda.predicate, item, lambda.alias, entity));
        }

        evaluatePredicate(expr: ParsedExpression, current: AnyObject, alias: string, root: AnyObject): boolean {
            switch (expr.operator) {
                case 'comparison': {
                    const left = this.resolvePredicateValue(expr.field, current, alias, root);
                    const right = expr.value;
                    switch (expr.comparator) {
                        case 'eq': return this.compareValues(left, right) === 0;
                        case 'neq': return this.compareValues(left, right) !== 0;
                        case 'gt': return this.compareValues(left, right) > 0;
                        case 'gte': return this.compareValues(left, right) >= 0;
                        case 'lt': return this.compareValues(left, right) < 0;
                        case 'lte': return this.compareValues(left, right) <= 0;
                        default:
                            throw new Error(`Unsupported comparator: ${expr.comparator}`);
                    }
                }
                case 'function': {
                    const value = this.resolvePredicateValue(expr.field, current, alias, root);
                    if (typeof value !== 'string') return false;
                    const arg = typeof expr.args[0] === 'string' ? expr.args[0] : String(expr.args[0] ?? '');
                    const source = expr.caseInsensitive ? value.toLowerCase() : value;
                    const needle = expr.caseInsensitive ? arg.toLowerCase() : arg;
                    if (expr.name === 'contains') return source.includes(needle);
                    if (expr.name === 'startswith') return source.startsWith(needle);
                    if (expr.name === 'endswith') return source.endsWith(needle);
                    return false;
                }
                case 'stringfncmp': {
                    const result = this.evaluateStringFunction(expr, current, alias, root);
                    if (result == null) return false;
                    const compare = this.compareValues(result, expr.value);
                    return expr.comparator === 'eq' ? compare === 0 : compare !== 0;
                }
                case 'datepart': {
                    const value = this.resolvePredicateValue(expr.field, current, alias, root);
                    const partValue = this.extractDatePart(value, expr.part);
                    if (partValue == null) return false;
                    const compare = this.compareValues(partValue, expr.value);
                    switch (expr.comparator) {
                        case 'eq': return compare === 0;
                        case 'neq': return compare !== 0;
                        case 'gt': return compare > 0;
                        case 'gte': return compare >= 0;
                        case 'lt': return compare < 0;
                        case 'lte': return compare <= 0;
                        default:
                            return false;
                    }
                }
                case 'fncmp': {
                    const value = this.resolvePredicateValue(expr.field, current, alias, root);
                    const numeric = value instanceof Date ? value : Number(value);
                    if (expr.name === 'year') {
                        if (!(value instanceof Date)) return false;
                        const year = value.getUTCFullYear();
                        return this.compareValues(year, expr.value) === 0;
                    }
                    if (!Number.isFinite(numeric as number)) return false;
                    switch (expr.name) {
                        case 'round':
                            return this.compareValues(Math.round(numeric as number), expr.value) === 0;
                        case 'floor':
                            return this.compareValues(Math.floor(numeric as number), expr.value) === 0;
                        case 'ceiling':
                            return this.compareValues(Math.ceil(numeric as number), expr.value) === 0;
                    }
                    return false;
                }
                case 'indexofcmp': {
                    const value = this.resolvePredicateValue(expr.field, current, alias, root);
                    if (typeof value !== 'string') return false;
                    const index = value.toLowerCase().indexOf(expr.needle.toLowerCase());
                    const compare = this.compareValues(index, expr.value);
                    switch (expr.comparator) {
                        case 'eq': return compare === 0;
                        case 'neq': return compare !== 0;
                        case 'gt': return compare > 0;
                        case 'gte': return compare >= 0;
                        case 'lt': return compare < 0;
                        case 'lte': return compare <= 0;
                    }
                    return false;
                }
                case 'substrcmp': {
                    const value = this.resolvePredicateValue(expr.field, current, alias, root);
                    if (typeof value !== 'string') return false;
                    const start = Math.max(0, expr.start);
                    const segment = expr.length !== undefined ? value.substr(start, expr.length) : value.slice(start);
                    return expr.comparator === 'eq' ? segment === expr.literal : segment !== expr.literal;
                }
                case 'lengthcmp': {
                    const value = this.resolvePredicateValue(expr.field, current, alias, root);
                    const len = typeof value === 'string' ? value.length : Array.isArray(value) ? value.length : 0;
                    switch (expr.comparator) {
                        case 'eq': return len === expr.value;
                        case 'gt': return len > expr.value;
                        case 'gte': return len >= expr.value;
                        case 'lt': return len < expr.value;
                        case 'lte': return len <= expr.value;
                        case 'neq': return len !== expr.value;
                        default: return false;
                    }
                }
                case 'logical': {
                    if (expr.type === 'and') {
                        return expr.expressions.every(child => this.evaluatePredicate(child, current, alias, root));
                    }
                    return expr.expressions.some(child => this.evaluatePredicate(child, current, alias, root));
                }
                case 'not':
                    return !this.evaluatePredicate(expr.expr, current, alias, root);
                case 'lambda':
                    throw new Error('Nested lambda expressions are not supported yet.');
                default:
                    return false;
            }
        }

        compareValues(a: unknown, b: unknown): number {
            if (a === b) return 0;
            if (a == null) return -1;
            if (b == null) return 1;
            if (typeof a === 'number' && typeof b === 'number') {
                if (a < b) return -1;
                if (a > b) return 1;
                return 0;
            }
            const aStr = String(a);
            const bStr = String(b);
            if (aStr < bStr) return -1;
            if (aStr > bStr) return 1;
            return 0;
        }

        resolvePredicateValue(path: string, current: AnyObject, alias: string, root: AnyObject): unknown {
            const segments = path.split('/');
            if (segments[0] === alias) {
                return this.resolvePath(current, segments.slice(1));
            }
            return this.resolvePath(root, segments);
        }

        resolvePath(source: AnyObject, segments: string[]): unknown {
            let current: unknown = source;
            for (const segment of segments) {
                if (current == null) return undefined;
                current = (current as AnyObject)[segment];
            }
            return current;
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

        stringPropertyNames(): string[] {
            const props = modelDefinition?.properties ?? {};
            const out: string[] = [];
            for (const [name, def] of Object.entries(props)) {
                const type = (def as any)?.type;
                const typeName = typeof type === 'function' ? type.name.toLowerCase() : String(type ?? '').toLowerCase();
                if (type === String || typeName === 'string') out.push(name);
            }
            return out;
        }

        resolveSearchableFields(): string[] {
            const mode = this.cfg?.searchMode ?? 'annotated';
            if (mode === 'disabled') return [];
            const set = def.name;
            const cfgFields = this.cfg?.searchFields?.[set];
            if (cfgFields && cfgFields.length) return cfgFields.slice();
            if (mode === 'config-only') return [];
            const annotated = getODataSearchableProps(modelCtor) ?? [];
            if (annotated.length) return annotated.slice();
            if (mode === 'all') return this.stringPropertyNames();
            return [];
        }

        applySearch(base: Filter<CrudEntity>, search?: string) {
            if (!search) return;
            const parsed = this.parseSearchExpression(String(search));
            if (!parsed) return;

            const maxTermsCfg = this.cfg?.maxSearchTerms;
            const maxTerms = Number.isFinite(maxTermsCfg as number) ? Number(maxTermsCfg) : undefined;
            if (maxTerms && parsed.termCount > maxTerms) {
                throw new HttpErrors.BadRequest(`$search allows at most ${maxTerms} terms.`);
            }

            let fields = this.resolveSearchableFields();
            const maxFieldsCfg = this.cfg?.maxSearchFields;
            const maxFields = Number.isFinite(maxFieldsCfg as number) ? Number(maxFieldsCfg) : undefined;
            if (maxFields && fields.length > maxFields) {
                fields = fields.slice(0, maxFields);
            }

            if (!fields.length) {
                const mode = this.cfg?.searchMode ?? 'annotated';
                if (this.cfg?.strict || mode !== 'all') {
                    throw new HttpErrors.BadRequest('No searchable fields configured for $search.');
                }
                return;
            }

            const whereClause = this.buildSearchWhere(parsed.node, fields);
            const combined = this.combineWithAnd([base.where as CrudWhere | undefined, whereClause]);
            if (combined) {
                base.where = combined;
            }
        }

        parseSearchExpression(text: string): SearchParseResult | undefined {
            const tokens = this.scanSearchTokens(text);
            if (!tokens.length) return undefined;

            let index = 0;
            let termCount = 0;

            const peek = () => tokens[index];
            const check = (type: SearchToken['type']) => {
                const token = peek();
                return token ? token.type === type : false;
            };
            const advance = () => tokens[index++];
            const match = (type: SearchToken['type']) => {
                if (check(type)) {
                    advance();
                    return true;
                }
                return false;
            };
            const describeToken = (token: SearchToken | undefined) => {
                if (!token) return 'end of expression';
                switch (token.type) {
                    case 'TERM':
                        return `term "${token.value}"`;
                    case 'AND':
                    case 'OR':
                    case 'NOT':
                        return token.type;
                    case 'LPAREN':
                        return '(';
                    case 'RPAREN':
                        return ')';
                    default:
                        return 'unknown';
                }
            };
            const error = (message: string): never => {
                throw new HttpErrors.BadRequest(`Invalid $search expression: ${message}`);
            };
            const canImplicitAnd = () => {
                const next = peek();
                if (!next) return false;
                return next.type === 'TERM' || next.type === 'LPAREN' || next.type === 'NOT';
            };

            function parseOr(): SearchAst {
                const nodes: SearchAst[] = [parseAnd()];
                while (match('OR')) {
                    nodes.push(parseAnd());
                }
                return nodes.length === 1 ? nodes[0] : { kind: 'or', nodes };
            }

            function parseAnd(): SearchAst {
                const nodes: SearchAst[] = [parseUnary()];
                for (;;) {
                    if (match('AND')) {
                        nodes.push(parseUnary());
                        continue;
                    }
                    if (canImplicitAnd()) {
                        nodes.push(parseUnary());
                        continue;
                    }
                    break;
                }
                return nodes.length === 1 ? nodes[0] : { kind: 'and', nodes };
            }

            function parseUnary(): SearchAst {
                if (match('NOT')) {
                    return { kind: 'not', node: parseUnary() };
                }
                return parsePrimary();
            }

            function parsePrimary(): SearchAst {
                const token = peek();
                if (!token) {
                    return error('Unexpected end of expression.');
                }
                if (token.type === 'LPAREN') {
                    advance();
                    const expr = parseOr();
                    if (!match('RPAREN')) {
                        error('Expected ")" to close group.');
                    }
                    return expr;
                }
                if (token.type === 'TERM') {
                    advance();
                    termCount++;
                    return { kind: 'term', value: token.value };
                }
                return error(`Unexpected token ${describeToken(token)}.`);
            }

            const ast = parseOr();
            if (index < tokens.length) {
                error(`Unexpected token ${describeToken(peek())}.`);
            }
            if (!termCount) return undefined;
            return { node: ast, termCount };
        }

        scanSearchTokens(text: string): SearchToken[] {
            const tokens: SearchToken[] = [];
            let i = 0;
            while (i < text.length) {
                const ch = text[i];
                if (/\s/.test(ch)) {
                    i++;
                    continue;
                }
                if (ch === '(') {
                    tokens.push({ type: 'LPAREN' });
                    i++;
                    continue;
                }
                if (ch === ')') {
                    tokens.push({ type: 'RPAREN' });
                    i++;
                    continue;
                }
                if (ch === '"' || ch === '\'') {
                    const quote = ch;
                    i++;
                    let value = '';
                    let closed = false;
                    while (i < text.length) {
                        const current = text[i];
                        if (current === '\\') {
                            if (i + 1 >= text.length) break;
                            value += text[i + 1];
                            i += 2;
                            continue;
                        }
                        if (current === quote) {
                            closed = true;
                            i++;
                            break;
                        }
                        value += current;
                        i++;
                    }
                    if (!closed) {
                        throw new HttpErrors.BadRequest('Invalid $search expression: unterminated quoted phrase.');
                    }
                    if (!value) {
                        throw new HttpErrors.BadRequest('Invalid $search expression: quoted phrase cannot be empty.');
                    }
                    tokens.push({ type: 'TERM', value });
                    continue;
                }
                let value = '';
                while (i < text.length) {
                    const current = text[i];
                    if (current === '(' || current === ')' || /\s/.test(current) || current === '"' || current === '\'') {
                        break;
                    }
                    if (current === '\\' && i + 1 < text.length) {
                        value += text[i + 1];
                        i += 2;
                        continue;
                    }
                    value += current;
                    i++;
                }
                value = value.trim();
                if (!value) continue;
                const upper = value.toUpperCase();
                if (upper === 'AND' && value.length === 3) {
                    tokens.push({ type: 'AND' });
                    continue;
                }
                if (upper === 'OR' && value.length === 2) {
                    tokens.push({ type: 'OR' });
                    continue;
                }
                if (upper === 'NOT' && value.length === 3) {
                    tokens.push({ type: 'NOT' });
                    continue;
                }
                tokens.push({ type: 'TERM', value });
            }
            return tokens;
        }

        buildSearchWhere(node: SearchAst, fields: string[], negate = false): CrudWhere {
            switch (node.kind) {
                case 'term': {
                    const clause = negate
                        ? this.buildNegatedTermClause(node.value, fields)
                        : this.buildTermClause(node.value, fields);
                    if (!clause) {
                        throw new HttpErrors.BadRequest('Invalid $search expression: empty term.');
                    }
                    return clause;
                }
                case 'not':
                    return this.buildSearchWhere(node.node, fields, !negate);
                case 'and': {
                    const children = node.nodes.map(child => this.buildSearchWhere(child, fields, negate));
                    const combined = negate ? this.combineWithOr(children) : this.combineWithAnd(children);
                    if (!combined) {
                        throw new HttpErrors.BadRequest('Invalid $search expression: empty conjunction.');
                    }
                    return combined;
                }
                case 'or': {
                    const children = node.nodes.map(child => this.buildSearchWhere(child, fields, negate));
                    const combined = negate ? this.combineWithAnd(children) : this.combineWithOr(children);
                    if (!combined) {
                        throw new HttpErrors.BadRequest('Invalid $search expression: empty disjunction.');
                    }
                    return combined;
                }
                default:
                    throw new HttpErrors.BadRequest('Invalid $search expression: unsupported node.');
            }
        }

        buildTermClause(term: string, fields: string[]): CrudWhere | undefined {
            const pattern = `%${this.escapeSearchTerm(term)}%`;
            const clauses = fields.map(field => {
                return {
                    [field]: { ilike: pattern, escape: '\\' },
                } as unknown as CrudWhere;
            });
            if (!clauses.length) return undefined;
            if (clauses.length === 1) return clauses[0];
            return this.combineWithOr(clauses) ?? clauses[0];
        }

        buildNegatedTermClause(term: string, fields: string[]): CrudWhere | undefined {
            const pattern = `%${this.escapeSearchTerm(term)}%`;
            const clauses = fields.map(field => {
                // To properly handle NOT LIKE with NULL values,
                // we need: (field NOT LIKE 'pattern' OR field IS NULL)
                // This ensures that NULL fields don't cause the condition to fail
                return {
                    or: [
                        { [field]: { nilike: pattern, escape: '\\' } },
                        { [field]: null },
                    ],
                } as unknown as CrudWhere;
            });
            if (!clauses.length) return undefined;
            if (clauses.length === 1) return clauses[0];
            return this.combineWithAnd(clauses) ?? clauses[0];
        }

        escapeSearchTerm(term: string): string {
            return term.replace(/[%_]/g, ch => `\\${ch}`);
        }

        combineWithAnd(parts: (CrudWhere | undefined)[]): CrudWhere | undefined {
            const filtered = parts.filter((item): item is CrudWhere => item != null);
            if (!filtered.length) return undefined;
            if (filtered.length === 1) return filtered[0];
            const merged: CrudWhere[] = [];
            for (const clause of filtered) {
                if (clause && typeof clause === 'object' && !Array.isArray(clause)) {
                    const inner = (clause as AnyObject).and;
                    if (Array.isArray(inner) && inner.length) {
                        for (const entry of inner) {
                            if (entry) merged.push(entry as CrudWhere);
                        }
                        continue;
                    }
                }
                merged.push(clause);
            }
            return { and: merged };
        }

        combineWithOr(parts: (CrudWhere | undefined)[]): CrudWhere | undefined {
            const filtered = parts.filter((item): item is CrudWhere => item != null);
            if (!filtered.length) return undefined;
            if (filtered.length === 1) return filtered[0];
            const merged: CrudWhere[] = [];
            for (const clause of filtered) {
                if (clause && typeof clause === 'object' && !Array.isArray(clause)) {
                    const inner = (clause as AnyObject).or;
                    if (Array.isArray(inner) && inner.length) {
                        for (const entry of inner) {
                            if (entry) merged.push(entry as CrudWhere);
                        }
                        continue;
                    }
                }
                merged.push(clause);
            }
            return { or: merged };
        }

        normalizeOrderDescriptors(order: Filter<CrudEntity>['order'], idProperties: string[]): OrderDescriptor[] {
            const orderArray = Array.isArray(order) ? order : order ? [order] : [];
            const descriptors: OrderDescriptor[] = [];
            const seen = new Set<string>();

            for (const clause of orderArray) {
                const segment = String(clause ?? '').trim();
                if (!segment) continue;
                const [rawField, rawDirection] = segment.split(/\s+/);
                if (!rawField) continue;
                if (rawField.includes('/')) {
                    throw new HttpErrors.BadRequest('$orderby with navigation paths cannot be combined with server-driven paging.');
                }
                const direction = rawDirection?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
                if (seen.has(rawField)) continue;
                seen.add(rawField);
                descriptors.push({field: rawField, direction});
            }

            for (const id of idProperties) {
                if (!id || seen.has(id)) continue;
                seen.add(id);
                descriptors.push({field: id, direction: 'ASC'});
            }

            if (!descriptors.length) {
                const fallback = idProperties[0] ?? 'id';
                descriptors.push({field: fallback, direction: 'ASC'});
            }

            return descriptors;
        }

        resolvePageSize(requested?: number): number {
            const configSize = Number(this.cfg?.pageSize ?? 0);
            const base = Number.isFinite(configSize) && configSize > 0 ? Math.floor(configSize) : 200;
            if (!Number.isFinite(requested) || (requested as number) <= 0) return base;
            const normalized = Math.floor(Number(requested));
            if (normalized <= 0) return base;
            return Math.min(normalized, base);
        }

        parseSkipTokenValues(token: string, descriptors: OrderDescriptor[], definition: ModelDefinition | undefined): unknown[] {
            if (!token) {
                throw new HttpErrors.BadRequest('Empty $skiptoken is not allowed.');
            }
            const segments = token.split(',');
            if (segments.length !== descriptors.length) {
                throw new HttpErrors.BadRequest('Invalid $skiptoken value.');
            }
            return descriptors.map((descriptor, index) => {
                const raw = decodeURIComponent(segments[index] ?? '');
                return this.coerceSkipTokenValue(descriptor.field, raw, definition);
            });
        }

        coerceSkipTokenValue(field: string, raw: string, definition: ModelDefinition | undefined): unknown {
            if (raw === 'null') return null;
            const properties = (definition?.properties ?? {}) as Record<string, PropertyDefinition | undefined>;
            const property = properties[field];
            const type = property?.type ?? property?.jsonSchema?.type;
            if (type === Number || type === 'number') {
                const num = Number(raw);
                if (Number.isNaN(num)) {
                    throw new HttpErrors.BadRequest(`Invalid numeric value in $skiptoken for ${field}.`);
                }
                return num;
            }
            if (type === Boolean || type === 'boolean') {
                if (raw === 'true' || raw === 'false') {
                    return raw === 'true';
                }
                throw new HttpErrors.BadRequest(`Invalid boolean value in $skiptoken for ${field}.`);
            }
            if (type === Date || type === 'date' || type === 'datetime' || property?.jsonSchema?.format === 'date-time') {
                const date = new Date(raw);
                if (Number.isNaN(date.getTime())) {
                    throw new HttpErrors.BadRequest(`Invalid date value in $skiptoken for ${field}.`);
                }
                return date;
            }
            return raw;
        }

        buildEqualityClause(field: string, value: unknown): CrudWhere {
            const clause: AnyObject = value === null ? {[field]: null} : {[field]: value};
            return clause as CrudWhere;
        }

        buildSkipTokenConstraint(token: string, descriptors: OrderDescriptor[], definition: ModelDefinition | undefined): CrudWhere | undefined {
            if (!token) return undefined;
            if (!descriptors.length) {
                throw new HttpErrors.BadRequest('Unable to apply $skiptoken without an order clause.');
            }
            const values = this.parseSkipTokenValues(token, descriptors, definition);
            const branches: CrudWhere[] = [];
            for (let index = 0; index < descriptors.length; index++) {
                const descriptor = descriptors[index];
                const value = values[index];
                const equalityParts: CrudWhere[] = [];
                for (let eqIndex = 0; eqIndex < index; eqIndex++) {
                    equalityParts.push(this.buildEqualityClause(descriptors[eqIndex].field, values[eqIndex]));
                }

                let comparison: CrudWhere | undefined;
                if (value === null) {
                    if (descriptor.direction === 'DESC') {
                        comparison = {[descriptor.field]: {neq: null}} as CrudWhere;
                    }
                } else {
                    const comparator = descriptor.direction === 'DESC' ? 'lt' : 'gt';
                    comparison = {[descriptor.field]: {[comparator]: value}} as CrudWhere;
                }

                if (comparison) {
                    equalityParts.push(comparison);
                }
                const branch = this.combineWithAnd(equalityParts);
                if (branch) {
                    branches.push(branch);
                }
            }
            return this.combineWithOr(branches);
        }

        ensureOrderProjection(fields: Filter<CrudEntity>['fields'], descriptors: OrderDescriptor[]): Filter<CrudEntity>['fields'] {
            if (!fields) return fields;
            const includeField = (target: string) => {
                if (!target) return;
                if (Array.isArray(fields)) {
                    if (!fields.includes(target)) fields.push(target);
                    return;
                }
                if (typeof fields === 'object') {
                    (fields as AnyObject)[target] = true;
                    return;
                }
            };
            for (const descriptor of descriptors) {
                if (descriptor.field.includes('/')) continue;
                includeField(descriptor.field);
            }
            return fields;
        }

        createSkipToken(record: AnyObject | undefined, descriptors: OrderDescriptor[]): string | undefined {
            if (!record || !descriptors.length) return undefined;
            const parts: string[] = [];
            for (const descriptor of descriptors) {
                const value = this.extractFieldValue(record, descriptor.field);
                if (value === undefined) return undefined;
                const encoded = encodeURIComponent(this.stringifySkipTokenValue(value));
                parts.push(encoded);
            }
            return parts.join(',');
        }

        extractFieldValue(record: AnyObject | undefined, field: string): unknown {
            if (!record) return undefined;
            if (!field.includes('/')) {
                return (record as AnyObject)[field];
            }
            const segments = field.split('/');
            let current: any = record;
            for (const segment of segments) {
                if (current == null) return undefined;
                current = current[segment];
            }
            return current;
        }

        stringifySkipTokenValue(value: unknown): string {
            if (value === null || value === undefined) return 'null';
            if (value instanceof Date) return value.toISOString();
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
        }

        buildNextLink(skipToken: string): string {
            const params = new URLSearchParams();
            const query = this.request.query ?? {};
            for (const [key, paramValue] of Object.entries(query)) {
                if (!paramValue || key === '$skiptoken' || key === '$skip') continue;
                if (Array.isArray(paramValue)) {
                    for (const entry of paramValue) {
                        params.append(key, String(entry));
                    }
                } else if (typeof paramValue === 'object') {
                    params.append(key, String(paramValue));
                } else {
                    params.set(key, String(paramValue));
                }
            }
            params.set('$skiptoken', skipToken);
            const queryString = params.toString();
            return queryString ? `${this.request.path}?${queryString}` : this.request.path;
        }

        applyServerDrivenPaging(data: AnyObject[], descriptors: OrderDescriptor[], pageSize: number): {items: AnyObject[]; token?: string} {
            if (!pageSize || pageSize <= 0) {
                return {items: data};
            }
            if (data.length <= pageSize) {
                return {items: data};
            }
            const items = data.slice(0, pageSize);
            const last = items[items.length - 1];
            const token = this.createSkipToken(last, descriptors);
            if (!token) {
                throw new HttpErrors.InternalServerError('Unable to generate $skiptoken for next page.');
            }
            return {
                items,
                token,
            };
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

        computeIncludeDepth(includes?: InclusionFilter[]): number {
            if (!includes || !includes.length) return 0;
            const depthOf = (inc: InclusionFilter): number => {
                const obj = typeof inc === 'string' ? {relation: inc} : inc;
                const child = (obj as any)?.scope?.include as InclusionFilter[] | undefined;
                const childDepth = this.computeIncludeDepth(child);
                return 1 + childDepth;
            };
            return includes.reduce((max, inc) => Math.max(max, depthOf(inc)), 0);
        }

        enforceExpandDepth(include?: InclusionFilter[]) {
            const limitRaw = this.cfg?.maxExpandDepth;
            if (!Number.isFinite(limitRaw as number) || (limitRaw as number) <= 0) return;
            const limit = Number(limitRaw);
            const depth = this.computeIncludeDepth(include);
            if (depth > limit) {
                throw new HttpErrors.BadRequest(`$expand exceeds maximum depth of ${limit}.`);
            }
        }

        enforceSkipLimit(filter: Filter<CrudEntity>) {
            const limitRaw = this.cfg?.maxSkip;
            if (!Number.isFinite(limitRaw as number) || (limitRaw as number) < 0) return;
            const cap = Number(limitRaw);
            const requested = typeof filter.offset === 'number' ? filter.offset : undefined;
            if (requested == null) return;
            if (this.cfg?.strict && requested > cap) {
                throw new HttpErrors.BadRequest(`$skip exceeds maximum allowed (${cap}).`);
            }
            if (!this.cfg?.strict && requested > cap) {
                filter.offset = cap;
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
            const aggregationEnabled = Boolean(def.capabilities?.aggregation ?? this.cfg?.capabilities?.aggregation);
            let hadClientExpand = false;

            let inlineCountRequested = false;
            let aggregationSpec: AggregationSpec | undefined;
            let applyPipeline: ApplyPipeline | undefined;
            let applyPlan: ApplyExecutionPlan | undefined;
            let lambdaExpression: LambdaExpression | undefined;
            let postFilterExpr: ParsedExpression | undefined;
            let unsupportedFunctions: string[] = [];
            let skipTokenValue: string | undefined;
            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
                );
                inlineCountRequested = parsed.inlineCount === true;
                if (inlineCountRequested && this.cfg && this.cfg.enableCount === false) {
                    throw new HttpErrors.BadRequest('The $count option is disabled by server configuration.');
                }
                const externalOrder = Array.isArray(parsed.order) ? [...parsed.order] : parsed.order;
                applyPipeline = parsed.applyPipeline;
                if (applyPipeline) {
                    applyPlan = buildApplyExecutionPlan(applyPipeline, {
                        strict: Boolean(this.cfg?.strict),
                        modelCtor,
                        maxNavigationDepth: this.cfg?.maxExpandDepth ?? 5,
                    });
                    const pipelineHasOrder = applyPlan.stages.some(stage => stage.orderBy && stage.orderBy.length);
                    if (pipelineHasOrder && externalOrder && (Array.isArray(externalOrder) ? externalOrder.length : true)) {
                        throw new HttpErrors.BadRequest('Combining $orderby outside $apply with orderby() inside the pipeline is not supported.');
                    }
                }
                aggregationSpec = applyPlan?.stages?.[0]?.spec ?? parsed.apply;
                lambdaExpression = parsed.lambda;
                postFilterExpr = parsed.postFilter;
                unsupportedFunctions = parsed.unsupportedFunctions ?? [];
                skipTokenValue = parsed.skipToken;
                if (postFilterExpr && unsupportedFunctions.length && this.cfg?.strict) {
                    throw new HttpErrors.BadRequest(`Unsupported filter functions in strict mode: ${unsupportedFunctions.join(', ')}`);
                }
                const parsedFilter = { ...parsed } as Filter<CrudEntity> & {
                    inlineCount?: boolean;
                    apply?: AggregationSpec;
                    applyPipeline?: ApplyPipeline;
                    lambda?: LambdaExpression;
                    skipToken?: string;
                };
                delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
                delete (parsedFilter as { apply?: AggregationSpec }).apply;
                delete (parsedFilter as { applyPipeline?: ApplyPipeline }).applyPipeline;
                delete (parsedFilter as { lambda?: LambdaExpression }).lambda;
                delete (parsedFilter as { postFilter?: ParsedExpression }).postFilter;
                delete (parsedFilter as { unsupportedFunctions?: string[] }).unsupportedFunctions;
                delete (parsedFilter as { skipToken?: string }).skipToken;
                this.mergeFilters(baseFilter, parsedFilter);
                hadClientExpand = Array.isArray(baseFilter.include)
                    ? baseFilter.include.length > 0
                    : Boolean(baseFilter.include);
                if (applyPlan?.pushdownWhere) {
                    const existingWhere = baseFilter.where as CrudWhere | undefined;
                    const planWhere = applyPlan.pushdownWhere as CrudWhere;
                    const combinedWhere = this.combineWithAnd([existingWhere, planWhere]);
                    baseFilter.where = combinedWhere ?? planWhere;
                }
                if (applyPlan) {
                    const relationsToInclude = this.collectAggregationRelations(applyPlan);
                    if (relationsToInclude.length) {
                        const additions = relationsToInclude.map(relation => ({ relation }));
                        baseFilter.include = mergeIncludes(baseFilter.include as InclusionFilter[] | undefined, additions);
                    }
                } else if (aggregationSpec) {
                    const fallbackSpec: AggregationSpec = {
                        groupBy: [...aggregationSpec.groupBy],
                        aggregates: aggregationSpec.aggregates.map(expr => ({...expr})),
                    };
                    const fallbackStage: ApplyAggregationStage = {
                        spec: fallbackSpec,
                        postAggregationFilters: [],
                        navigationPaths: collectNavigationPathsForStage(
                            modelCtor,
                            fallbackSpec,
                            this.cfg?.maxExpandDepth ?? 5,
                        ),
                    };
                    const tempPlan: ApplyExecutionPlan = {
                        pushdownWhere: undefined,
                        preAggregationFilters: [],
                        stages: [fallbackStage],
                    };
                    const relationsToInclude = this.collectAggregationRelations(tempPlan);
                    if (relationsToInclude.length) {
                        const additions = relationsToInclude.map(relation => ({ relation }));
                        baseFilter.include = mergeIncludes(baseFilter.include as InclusionFilter[] | undefined, additions);
                    }
                }
                this.ensureEtagField(baseFilter);
                // apply $search if present
                this.applySearch(baseFilter, (parsed as any).search);
                // enforce expand depth
                this.enforceExpandDepth((parsed as any).include as InclusionFilter[] | undefined);
            } catch (error) {
                const message = (error as Error).message ?? 'Invalid OData query.';
                throw new HttpErrors.BadRequest(message);
            }

            if (aggregationSpec) {
                if (inlineCountRequested) {
                    throw new HttpErrors.BadRequest('The $count option cannot be combined with $apply.');
                }
                if (hadClientExpand) {
                    throw new HttpErrors.BadRequest('The $expand option is not supported together with $apply.');
                }
                if (!aggregationEnabled) {
                    throw new HttpErrors.NotImplemented('Aggregations are not enabled for this entity set.');
                }
                if (skipTokenValue) {
                    throw new HttpErrors.BadRequest('$skiptoken is not supported together with $apply.');
                }
            }

            if (lambdaExpression) {
                if (aggregationSpec) {
                    throw new HttpErrors.BadRequest('Combining $apply with lambda expressions is not supported.');
                }
                this.ensureLambdaInclusion(baseFilter, lambdaExpression);
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
            this.enforceSkipLimit(baseFilter);

            const skipApplied = typeof baseFilter.offset === 'number' && baseFilter.offset > 0;
            if (skipApplied && skipTokenValue) {
                throw new HttpErrors.BadRequest('$skip cannot be combined with $skiptoken.');
            }

            const originalTop = typeof baseFilter.limit === 'number' ? baseFilter.limit : undefined;
            const serverPagingEnabled = !aggregationSpec && !skipApplied;
            let pageSize = serverPagingEnabled ? this.resolvePageSize(originalTop) : originalTop;
            let orderDescriptors: OrderDescriptor[] = [];
            if (serverPagingEnabled) {
                orderDescriptors = this.normalizeOrderDescriptors(baseFilter.order as Filter<CrudEntity>['order'], idProperties);
                baseFilter.order = orderDescriptors.map(item => `${item.field} ${item.direction}`);
                const skipConstraint = skipTokenValue
                    ? this.buildSkipTokenConstraint(skipTokenValue, orderDescriptors, modelDefinition)
                    : undefined;
                if (skipConstraint) {
                    baseFilter.where = this.combineWithAnd([baseFilter.where as CrudWhere | undefined, skipConstraint]) ?? skipConstraint;
                }
                pageSize = pageSize ?? this.resolvePageSize(undefined);
                baseFilter.limit = (pageSize ?? 0) + 1;
                baseFilter.offset = 0;
            }

            if (serverPagingEnabled && baseFilter.fields) {
                baseFilter.fields = this.ensureOrderProjection(baseFilter.fields, orderDescriptors);
            }

            const requestedOffset = serverPagingEnabled ? 0 : typeof baseFilter.offset === 'number' ? baseFilter.offset : 0;
            const requestedLimit = serverPagingEnabled ? pageSize : typeof baseFilter.limit === 'number' ? baseFilter.limit : undefined;
            const planRequiresPostProcessing = Boolean(
                applyPlan &&
                (
                    applyPlan.preAggregationFilters.length > 0 ||
                    applyPlan.stages.length > 1 ||
                    applyPlan.stages.some(stage =>
                        stage.postAggregationFilters.length > 0 ||
                        stage.skip !== undefined ||
                        stage.top !== undefined ||
                        (stage.orderBy?.length ?? 0) > 0,
                    )
                ),
            );
            const requiresPostFilter = Boolean(postFilterExpr) || planRequiresPostProcessing;

            if (requiresPostFilter) {
                delete baseFilter.offset;
                delete baseFilter.limit;
            }

            const op: CrudOperation = 'READ';
            const scope: CrudScope = 'collection';
            const ctx = this.buildHookContext({operation: op, scope, filter: baseFilter as any, options: this.repositoryOptions()});
            await this.runBefore(op, scope, ctx);

            const execDefault = async () => {
                const options = this.repositoryOptions();

                if (aggregationSpec) {
                    const fetchFilter: Filter<CrudEntity> = { ...baseFilter };
                    delete fetchFilter.order;
                    delete fetchFilter.limit;
                    delete fetchFilter.offset;

                    const planStages = applyPlan?.stages ?? [];
                    const stageCount = planStages.length || 1;
                    const stageForPushdown = planStages[0];
                    const pushdownResult = await this.tryExecuteApplyPushdown(
                        aggregationSpec,
                        applyPlan,
                        applyPipeline,
                        fetchFilter,
                        baseFilter,
                        requestedOffset,
                        requestedLimit,
                        postFilterExpr,
                        contextBase,
                        options,
                        stageForPushdown,
                        0,
                        stageCount,
                    );
                    if (pushdownResult) {
                        ctx.result = pushdownResult;
                        return pushdownResult;
                    }

                    const entities = await this.repository.find(fetchFilter, options);
                    const plainEntities = entities.map(entity => this.toPlainEntity(entity) ?? {});
                    let working = plainEntities;
                    if (applyPlan?.preAggregationFilters.length) {
                        working = this.applyPostFilters(working, applyPlan.preAggregationFilters);
                    }

                    const stages: ApplyAggregationStage[] = applyPlan?.stages?.length
                        ? applyPlan.stages
                        : aggregationSpec
                            ? (() => {
                                const fallbackSpec: AggregationSpec = {
                                    groupBy: [...aggregationSpec.groupBy],
                                    aggregates: aggregationSpec.aggregates.map(expr => ({...expr})),
                                };
                                return [{
                                    spec: fallbackSpec,
                                    postAggregationFilters: [],
                                    navigationPaths: collectNavigationPathsForStage(
                                        modelCtor,
                                        fallbackSpec,
                                        this.cfg?.maxExpandDepth ?? 5,
                                    ),
                                }];
                            })()
                            : [];

                    let lastStageHasOrder = false;
                    const fallbackStageCount = stages.length || 1;
                    for (let localStageIndex = 0; localStageIndex < stages.length; localStageIndex++) {
                        const stage = stages[localStageIndex];
                        working = this.executeAggregation(working, stage);
                        if (stage.postAggregationFilters.length) {
                            working = this.applyPostFilters(working, stage.postAggregationFilters);
                        }
                        if (stage.orderBy?.length) {
                            const stageOrder = stage.orderBy.map(item => `${item.field} ${item.direction.toUpperCase()}`);
                            working = this.orderResults(working, stageOrder);
                            lastStageHasOrder = true;
                        } else {
                            lastStageHasOrder = false;
                        }
                        if (stage.skip !== undefined || stage.top !== undefined) {
                            working = this.sliceResults(working, stage.skip, stage.top);
                        }
                        this.emitApplyTelemetry('fallback', localStageIndex, fallbackStageCount, {
                            rows: working.length,
                            joinCount: stage.navigationPaths?.length,
                        });
                    }

                    if (postFilterExpr) {
                        working = this.applyPostFilter(working, postFilterExpr);
                    }

                    this.logApplyFallback('in-memory-apply', {
                        entitySet: setName,
                        transformations: applyPipeline?.transformations.length ?? 0,
                        rows: working.length,
                    });
                    const maxApplySize = this.cfg?.maxApplyResultSize;
                    if (typeof maxApplySize === 'number' && maxApplySize > 0 && working.length > maxApplySize) {
                        this.logApplyFallback('limit-exceeded', {
                            entitySet: setName,
                            transformations: applyPipeline?.transformations.length ?? 0,
                            rows: working.length,
                            limit: maxApplySize,
                        });
                        throw new HttpErrors.BadRequest(`$apply result exceeds the server limit of ${maxApplySize} records. Refine the query or increase maxApplyResultSize.`);
                    }

                    let ordered = working;
                    if (!lastStageHasOrder && baseFilter.order) {
                        ordered = this.orderResults(working, baseFilter.order);
                    }

                    const paged = this.sliceResults(ordered, requestedOffset, requestedLimit);

                    this.ensureODataHeaders();
                    const result = {
                        '@odata.context': contextBase,
                        value: paged,
                    } as AnyObject;
                    ctx.result = result;
                    return result;
                }

                if (lambdaExpression) {
                    const fetchFilter: Filter<CrudEntity> = { ...baseFilter };
                    delete fetchFilter.order;
                    delete fetchFilter.limit;
                    delete fetchFilter.offset;

                    const entities = await this.repository.find(fetchFilter, options);
                    const plainEntities = entities.map(entity => this.toPlainEntity(entity) ?? {});
                    let filtered = this.filterEntitiesByLambda(plainEntities, lambdaExpression);
                    if (requiresPostFilter) {
                        filtered = this.applyPostFilter(filtered, postFilterExpr);
                    }
                    const ordered = this.orderResults(filtered, baseFilter.order);
                    const paged = this.sliceResults(ordered, requestedOffset, requestedLimit);

                    this.ensureODataHeaders();
                    const result = {
                        '@odata.context': contextBase,
                        value: this.decoratePlainEntities(paged),
                    } as AnyObject;
                    ctx.result = result;
                    return result;
                }

                const results = await this.repository.find(baseFilter, options);
                const plainResults = results.map(entity => this.toPlainEntity(entity) ?? {});
                const filteredResults = requiresPostFilter ? this.applyPostFilter(plainResults, postFilterExpr) : plainResults;
                let totalCount: number | undefined;

                if (inlineCountRequested) {
                    if (requiresPostFilter) {
                        totalCount = filteredResults.length;
                    } else {
                        const where = baseFilter.where as Filter<CrudEntity>['where'];
                        const { count } = await this.repository.count(where as any, options);
                        totalCount = count;
                    }
                }

                const ordered = this.orderResults(filteredResults, baseFilter.order);
                let nextLinkToken: string | undefined;
                let paged: AnyObject[];
                if (serverPagingEnabled) {
                    const effectivePageSize = pageSize ?? this.resolvePageSize(undefined);
                    const pagination = this.applyServerDrivenPaging(ordered, orderDescriptors, effectivePageSize);
                    paged = pagination.items;
                    nextLinkToken = pagination.token;
                } else if (requiresPostFilter) {
                    paged = this.sliceResults(ordered, requestedOffset, requestedLimit);
                } else {
                    paged = ordered;
                }

                this.ensureODataHeaders();
                const result = {
                    '@odata.context': contextBase,
                    ...(inlineCountRequested ? { '@odata.count': totalCount ?? filteredResults.length } : {}),
                    value: this.decoratePlainEntities(paged),
                } as AnyObject;
                if (serverPagingEnabled && nextLinkToken) {
                    result['@odata.nextLink'] = this.buildNextLink(nextLinkToken);
                }
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
            let postFilterExpr: ParsedExpression | undefined;
            let unsupportedFunctions: string[] = [];

            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
                );
                const parsedFilter = { ...parsed } as Filter<CrudEntity> & { inlineCount?: boolean };
                delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
                postFilterExpr = parsed.postFilter;
                unsupportedFunctions = parsed.unsupportedFunctions ?? [];
                if (postFilterExpr && unsupportedFunctions.length && this.cfg?.strict) {
                    throw new HttpErrors.BadRequest(`Unsupported filter functions in strict mode: ${unsupportedFunctions.join(', ')}`);
                }
                delete (parsedFilter as { postFilter?: ParsedExpression }).postFilter;
                delete (parsedFilter as { unsupportedFunctions?: string[] }).unsupportedFunctions;
                this.mergeFilters(baseFilter, parsedFilter);
                this.applySearch(baseFilter, (parsed as any).search);
                this.enforceExpandDepth((parsed as any).include as InclusionFilter[] | undefined);
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
                if (postFilterExpr) {
                    const entities = await this.repository.find(baseFilter, options);
                    const plain = entities.map(entity => this.toPlainEntity(entity) ?? {});
                    const filtered = this.applyPostFilter(plain, postFilterExpr);
                    this.ensureODataHeaders();
                    const result = `${filtered.length}`;
                    ctx.result = result;
                    return result;
                }

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
            let postFilterExpr: ParsedExpression | undefined;
            let unsupportedFunctions: string[] = [];

            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
                );
                postFilterExpr = parsed.postFilter;
                unsupportedFunctions = parsed.unsupportedFunctions ?? [];
                if (postFilterExpr && unsupportedFunctions.length && this.cfg?.strict) {
                    throw new HttpErrors.BadRequest(`Unsupported filter functions in strict mode: ${unsupportedFunctions.join(', ')}`);
                }
                const sanitized: Filter<CrudEntity> = {};
                if (parsed.fields) sanitized.fields = parsed.fields;
                if (parsed.include) sanitized.include = parsed.include;
                this.mergeFilters(baseFilter as Filter<CrudEntity>, sanitized);
                this.ensureEtagField(baseFilter as Filter<CrudEntity>);
                this.applySearch(baseFilter as Filter<CrudEntity>, (parsed as any).search);
                this.enforceExpandDepth((parsed as any).include as InclusionFilter[] | undefined);
            } catch (error) {
                const message = (error as Error).message ?? 'Invalid OData query.';
                throw new HttpErrors.BadRequest(message);
            }

            this.ensureAcceptsJson();
            this.validateFieldsStrict(baseFilter as Filter<CrudEntity>);
            this.enforceSkipLimit(baseFilter as Filter<CrudEntity>);

            const op: CrudOperation = 'READ';
            const scope: CrudScope = 'entity';
            const ctx = this.buildHookContext({operation: op, scope, id, filter: baseFilter as any, options: this.repositoryOptions()});
            await this.runBefore(op, scope, ctx);

            const execDefault = async () => {
                const options = this.repositoryOptions();
                const entity = await this.repository.findById(id as any, baseFilter, options);
                const plain = this.toPlainEntity(entity) ?? {};
                if (postFilterExpr) {
                    const matches = this.evaluatePredicate(postFilterExpr, plain, '', plain);
                    if (!matches) {
                        throw new HttpErrors.NotFound('Entity not found.');
                    }
                }
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
                            includeRelations: deepInsertEnabledForSet,
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
                const deepInsertEnabled = this.isDeepInsertEnabled(deepInsertEnabledForSet);
                const payloadForCreate = this.coercePayloadToObject((ctx.payload ?? payload) as AnyObject);
                const visited = new Set<AnyObject>();
                const normalized = deepInsertEnabled
                    ? this.normalizeDeepInsertPayload(payloadForCreate, modelCtor as typeof Entity)
                    : { root: payloadForCreate, children: undefined };
                ctx.payload = normalized.root;

                const created = await this.repository.create(normalized.root as any, options);
                let entityForResponse: AnyObject | undefined = this.toPlainEntity(created);

                if (deepInsertEnabled && normalized.children && Object.keys(normalized.children).length) {
                    const parentId = this.extractEntityId(created);
                    if (parentId == null) {
                        throw new HttpErrors.InternalServerError('Unable to determine entity id for deep insert.');
                    }
                    const repoWithRelations = this.repository as AnyObject;
                    for (const [relationName, relationValue] of Object.entries(normalized.children)) {
                        if (relationValue == null) continue;
                        const relationMeta = modelRelations?.[relationName] as AnyObject | undefined;
                        if (!relationMeta) continue;
                        const factory = repoWithRelations[relationName];
                        if (typeof factory !== 'function') {
                            throw new HttpErrors.BadRequest(`Repository for ${setName} does not expose a relation factory for ${relationName}.`);
                        }
                        const relationRepo = factory(parentId, options);
                        if (!relationRepo || typeof relationRepo.create !== 'function') {
                            throw new HttpErrors.BadRequest(`Relation ${relationName} does not support create operations required for deep insert.`);
                        }
                        if (relationMeta.targetsMany) {
                            const arrayValues = Array.isArray(relationValue) ? relationValue : [relationValue];
                            for (const arrEntry of arrayValues) {
                                if (arrEntry == null) continue;
                                await this.persistDeepInsertGraph(
                                    relationName,
                                    relationMeta,
                                    relationRepo,
                                    arrEntry,
                                    options,
                                    visited,
                                    1,
                                );
                            }
                        } else {
                            await this.persistDeepInsertGraph(
                                relationName,
                                relationMeta,
                                relationRepo,
                                relationValue,
                                options,
                                visited,
                                1,
                            );
                        }
                    }
                    const reloaded = await this.reloadEntityForResponse(created, options);
                    entityForResponse = this.toPlainEntity(reloaded ?? created);
                }

                if (this.etagEnabled()) {
                    const hasEtag = this.computeEtagFromPlain(entityForResponse);
                    if (!hasEtag) {
                        const reloaded = await this.reloadEntityForResponse(entityForResponse ?? created, options);
                        entityForResponse = this.toPlainEntity(reloaded ?? entityForResponse);
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

    const derived = new Map<string, Map<string, number>>();
    const addAlias = (source: string, target: string, priority = 10) => {
        if (!controllerMethods.has(target)) return;
        let map = derived.get(source);
        if (!map) {
            map = new Map();
            derived.set(source, map);
        }
        const existing = map.get(target);
        if (existing === undefined || priority < existing) {
            map.set(target, priority);
        }
    };

    const writeAliasSources = new Set([
        'update',
        'updateById',
        'replace',
        'replaceById',
        'patch',
        'patchById',
        'bulkUpdate',
    ]);
    const deleteAliasSources = new Set([
        'delete',
        'deleteById',
        'destroyById',
    ]);
    const hasExplicitDeleteMetadata = Object.keys(methodMetadata).some(name => deleteAliasSources.has(name));

    for (const methodName of Object.keys(methodMetadata)) {
        if (methodName === 'find' && controllerMethods.has('list')) {
            addAlias(methodName, 'list');
        }

        if (methodName.endsWith('ById')) {
            const base = methodName.substring(0, methodName.length - 'ById'.length);
            if (base && controllerMethods.has(base)) {
                addAlias(methodName, base);
            } else if (base === 'replace' && controllerMethods.has('update')) {
                addAlias(methodName, 'update');
            }
        }

        if (writeAliasSources.has(methodName)) {
            addAlias(methodName, 'linkNavigationRef');
            if (!hasExplicitDeleteMetadata) {
                addAlias(methodName, 'unlinkNavigationRef', 20);
            }
        }

        if (deleteAliasSources.has(methodName)) {
            addAlias(methodName, 'unlinkNavigationRef', 5);
        }
    }

    if (!derived.size) return undefined;

    const result: MethodAliasMap = {};
    for (const [source, aliases] of derived.entries()) {
        const sorted = Array.from(aliases.entries())
            .sort((a, b) => a[1] - b[1])
            .map(([name]) => name)
            .filter((value, index, array) => array.indexOf(value) === index);
        result[source] = sorted.length === 1 ? sorted[0] : sorted;
    }
    return result;
}

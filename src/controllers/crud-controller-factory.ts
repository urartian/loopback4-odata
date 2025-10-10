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
} from '@loopback/repository';
import { EntitySetDef } from '../registry/entityset-registry';
import { parseODataQuery, AggregationSpec, AggregationOperator, LambdaExpression, ParsedExpression, FunctionArg } from '../services/odata-query-parser.service';
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
import { getODataSearchableProps } from '../decorators/search.decorators';
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

        executeAggregation(rows: AnyObject[], spec: AggregationSpec): AnyObject[] {
            const groupMap = new Map<string, {groupValues: Record<string, unknown>; aggregates: Record<string, AggregationAccumulatorState>}>();

            for (const row of rows) {
                const groupValues = spec.groupBy.map(field => (row as AnyObject)[field]);
                const key = JSON.stringify(groupValues);
                let entry = groupMap.get(key);
                if (!entry) {
                    const values: Record<string, unknown> = {};
                    spec.groupBy.forEach((field, idx) => {
                        values[field] = groupValues[idx];
                    });
                    entry = {groupValues: values, aggregates: {}};
                    groupMap.set(key, entry);
                }

                for (const aggregate of spec.aggregates) {
                    let state = entry.aggregates[aggregate.alias];
                    if (!state) {
                        state = {
                            operator: aggregate.operator,
                            sum: aggregate.operator === 'sum' || aggregate.operator === 'average' ? 0 : undefined,
                            count: aggregate.operator === 'count' || aggregate.operator === 'average' ? 0 : undefined,
                            min: undefined,
                            max: undefined,
                            distinct: aggregate.operator === 'countdistinct' ? new Set<unknown>() : undefined,
                        };
                        entry.aggregates[aggregate.alias] = state;
                    }
                    const value = aggregate.field ? (row as AnyObject)[aggregate.field] : undefined;
                    updateAccumulatorState(state, value);
                }
            }

            const results: AnyObject[] = [];
            for (const {groupValues, aggregates} of groupMap.values()) {
                const record: AnyObject = {...groupValues};
                for (const [alias, state] of Object.entries(aggregates)) {
                    record[alias] = finalizeAccumulatorState(state);
                }
                results.push(record);
            }

            return results;

            function updateAccumulatorState(state: AggregationAccumulatorState, rawValue: unknown) {
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
                }
            }

            function finalizeAccumulatorState(state: AggregationAccumulatorState): unknown {
                switch (state.operator) {
                    case 'sum':
                        return state.sum ?? 0;
                    case 'average':
                        if (!state.count) return null;
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

        getModelDefinition(): any {
            const repo = this.repository as AnyObject | undefined;
            const repoDef = repo?.entityClass?.definition ?? repo?.modelClass?.definition;
            if (repoDef && typeof repoDef === 'object') {
                return repoDef;
            }
            const ctorDef = (modelCtor as AnyObject | undefined)?.definition;
            if (ctorDef && typeof ctorDef === 'object') {
                return ctorDef;
            }
            return modelDefinition;
        }

        allowedProperties(): {props: Set<string>; relations: Set<string>} {
            const definition = this.getModelDefinition();
            const props = new Set<string>(Object.keys(definition?.properties ?? {}));
            const relationDefs = (definition?.relations ?? modelRelations ?? {}) as RelationDefinitionMap | undefined;
            const relations = new Set<string>(Object.keys(relationDefs ?? {}));
            return {props, relations};
        }

        stringPropertyNames(): string[] {
            const definition = this.getModelDefinition();
            const props = definition?.properties ?? {};
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
                return {
                    [field]: { nilike: pattern, escape: '\\' },
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

        buildPropertyNameMap(): Map<string, string> {
            const definition = this.getModelDefinition();
            const {props} = this.allowedProperties();
            const map = new Map<string, string>();
            const register = (candidate: unknown, target: string) => {
                if (typeof candidate !== 'string') return;
                const trimmed = candidate.trim();
                if (!trimmed) return;
                if (!map.has(trimmed)) {
                    map.set(trimmed, target);
                }
                const lower = trimmed.toLowerCase();
                if (!map.has(lower)) {
                    map.set(lower, target);
                }
            };

            for (const prop of props) {
                register(prop, prop);
                const def = (definition?.properties ?? {})[prop] as AnyObject | undefined;
                if (def && typeof def === 'object') {
                    register(def.name, prop);
                    const jsonSchema = def.jsonSchema as AnyObject | undefined;
                    if (jsonSchema && typeof jsonSchema === 'object') {
                        register(jsonSchema.name, prop);
                        register(jsonSchema['x-odata-original-name'], prop);
                        register(jsonSchema['x-odata-property-name'], prop);
                    }
                }
            }

            const definitionIdProps = typeof definition?.idProperties === 'function'
                ? definition.idProperties()
                : undefined;
            const idList = Array.isArray(definitionIdProps) && definitionIdProps.length
                ? definitionIdProps
                : idProperties;
            for (const idName of idList ?? []) {
                const canonical = typeof idName === 'string'
                    ? (map.get(idName) ?? map.get(idName.toLowerCase()) ?? idName)
                    : idName;
                register(idName, String(canonical));
            }
            return map;
        }

        normalizePropertyName(name: string, map: Map<string, string>): string {
            if (!name) return name;
            const direct = map.get(name);
            if (direct) return direct;
            const lower = name.toLowerCase();
            const resolved = map.get(lower);
            return resolved ?? name;
        }

        normalizeWhereClause(where: CrudWhere | undefined, map: Map<string, string>): CrudWhere | undefined {
            if (!where || typeof where !== 'object') return where;
            if (Array.isArray(where)) {
                let mutated = false;
                const normalized = where.map(entry => {
                    const next = this.normalizeWhereClause(entry as CrudWhere, map);
                    if (next !== entry) mutated = true;
                    return next as CrudWhere;
                });
                return mutated ? (normalized as unknown as CrudWhere) : where;
            }

            let mutated = false;
            const result: AnyObject = {};

            for (const [key, value] of Object.entries(where)) {
                if (key === 'and' || key === 'or') {
                    const list = Array.isArray(value) ? value : [];
                    const normalizedList = list.map(entry => this.normalizeWhereClause(entry as CrudWhere, map));
                    if (normalizedList.some((entry, idx) => entry !== list[idx])) mutated = true;
                    result[key] = normalizedList;
                    continue;
                }
                if (key === 'not') {
                    const normalizedChild = this.normalizeWhereClause(value as CrudWhere, map);
                    if (normalizedChild !== value) mutated = true;
                    result[key] = normalizedChild;
                    continue;
                }
                const normalizedKey = this.normalizePropertyName(key, map);
                if (normalizedKey !== key) mutated = true;
                result[normalizedKey] = value;
            }

            return mutated ? (result as CrudWhere) : where;
        }

        normalizeOrderList(order: string | string[] | undefined, map: Map<string, string>): string | string[] | undefined {
            if (!order) return order;
            const list = Array.isArray(order) ? order : [order];
            let mutated = false;
            const mapped = list.map(item => {
                const original = String(item ?? '');
                const raw = original.trim();
                if (raw !== original) mutated = true;
                if (!raw) {
                    if (original) mutated = true;
                    return '';
                }
                const [field, direction, ...rest] = raw.split(/\s+/);
                if (!field) return raw;
                const normalizedField = this.normalizePropertyName(field, map);
                if (normalizedField !== field) mutated = true;
                const suffix = [direction, ...rest].filter(Boolean).join(' ');
                return suffix ? `${normalizedField} ${suffix}` : normalizedField;
            });
            const normalized = mapped.filter(entry => {
                if (!entry) {
                    mutated = true;
                    return false;
                }
                return true;
            });

            if (!Array.isArray(order)) {
                return normalized.length ? normalized[0] : undefined;
            }
            return mutated ? normalized : order;
        }

        normalizeFields(fields: Filter<CrudEntity>['fields'], map: Map<string, string>): Filter<CrudEntity>['fields'] {
            if (!fields) return fields;
            if (Array.isArray(fields)) {
                let mutated = false;
                const normalized = fields.map(name => {
                    const normalizedName = this.normalizePropertyName(String(name), map);
                    if (normalizedName !== name) mutated = true;
                    return normalizedName;
                });
                return mutated ? (normalized as Filter<CrudEntity>['fields']) : fields;
            }
            if (typeof fields === 'object') {
                let mutated = false;
                const result: AnyObject = {};
                for (const [key, value] of Object.entries(fields as AnyObject)) {
                    const normalizedKey = this.normalizePropertyName(key, map);
                    if (normalizedKey !== key) mutated = true;
                    result[normalizedKey] = value;
                }
                return mutated ? (result as Filter<CrudEntity>['fields']) : fields;
            }
            return fields;
        }

        normalizeFilterProperties(filter: Filter<CrudEntity>) {
            if (!filter) return;
            const map = this.buildPropertyNameMap();
            if (!map.size) return;
            if (filter.fields) {
                const normalizedFields = this.normalizeFields(filter.fields, map);
                if (normalizedFields !== filter.fields) {
                    filter.fields = normalizedFields;
                }
            }
            if (filter.order) {
                const normalizedOrder = this.normalizeOrderList(filter.order, map);
                if (normalizedOrder !== filter.order) {
                    filter.order = normalizedOrder as typeof filter.order;
                }
            }
            if (filter.where) {
                const normalizedWhere = this.normalizeWhereClause(filter.where as CrudWhere, map);
                if (normalizedWhere !== filter.where) {
                    filter.where = normalizedWhere as Filter<CrudEntity>['where'];
                }
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

            let inlineCountRequested = false;
            let aggregationSpec: AggregationSpec | undefined;
            let lambdaExpression: LambdaExpression | undefined;
            let postFilterExpr: ParsedExpression | undefined;
            let unsupportedFunctions: string[] = [];
            try {
                const parsed = parseODataQuery(
                    this.request.query as Record<string, string | string[] | undefined>,
                    { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
                );
                inlineCountRequested = parsed.inlineCount === true;
                if (inlineCountRequested && this.cfg && this.cfg.enableCount === false) {
                    throw new HttpErrors.BadRequest('The $count option is disabled by server configuration.');
                }
                aggregationSpec = parsed.apply;
                lambdaExpression = parsed.lambda;
                postFilterExpr = parsed.postFilter;
                unsupportedFunctions = parsed.unsupportedFunctions ?? [];
                if (postFilterExpr && unsupportedFunctions.length && this.cfg?.strict) {
                    throw new HttpErrors.BadRequest(`Unsupported filter functions in strict mode: ${unsupportedFunctions.join(', ')}`);
                }
                const parsedFilter = { ...parsed } as Filter<CrudEntity> & { inlineCount?: boolean; apply?: AggregationSpec; lambda?: LambdaExpression };
                delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
                delete (parsedFilter as { apply?: AggregationSpec }).apply;
                delete (parsedFilter as { lambda?: LambdaExpression }).lambda;
                delete (parsedFilter as { postFilter?: ParsedExpression }).postFilter;
                delete (parsedFilter as { unsupportedFunctions?: string[] }).unsupportedFunctions;
                this.mergeFilters(baseFilter, parsedFilter);
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
                if (baseFilter.include) {
                    throw new HttpErrors.BadRequest('The $expand option is not supported together with $apply.');
                }
                if (!aggregationEnabled) {
                    throw new HttpErrors.NotImplemented('Aggregations are not enabled for this entity set.');
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

            const requestedOffset = typeof baseFilter.offset === 'number' ? baseFilter.offset : 0;
            const requestedLimit = typeof baseFilter.limit === 'number' ? baseFilter.limit : undefined;
            const requiresPostFilter = Boolean(postFilterExpr);

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

                    const entities = await this.repository.find(fetchFilter, options);
                    const plainEntities = entities.map(entity => this.toPlainEntity(entity) ?? {});
                    const filteredEntities = requiresPostFilter ? this.applyPostFilter(plainEntities, postFilterExpr) : plainEntities;
                    const aggregated = this.executeAggregation(filteredEntities, aggregationSpec);
                    const ordered = this.orderResults(aggregated, baseFilter.order);
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
                const paged = requiresPostFilter
                    ? this.sliceResults(ordered, requestedOffset, requestedLimit)
                    : ordered;

                this.ensureODataHeaders();
                const result = {
                    '@odata.context': contextBase,
                    ...(inlineCountRequested ? { '@odata.count': totalCount ?? filteredResults.length } : {}),
                    value: this.decoratePlainEntities(paged),
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

            this.normalizeFilterProperties(target);
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

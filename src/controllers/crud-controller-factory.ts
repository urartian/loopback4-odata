import { inject } from '@loopback/core';
import { randomBytes } from 'crypto';
import { ReferenceObject, ContentObject } from '@loopback/openapi-v3';
import {
  HttpErrors,
  del,
  get,
  getModelSchemaRef,
  param,
  patch,
  post,
  put,
  requestBody,
  Request,
  RestBindings,
  RequestContext,
  OperationObject,
  SchemaObject,
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
  EntityNotFoundError,
  juggler,
} from '@loopback/repository';
import { EntitySetDef } from '../registry/entityset-registry';
import {
  parseODataQuery,
  AggregationSpec,
  AggregationOperator,
  AggregationExpression,
  LambdaExpression,
  ParsedExpression,
  FunctionArg,
  buildWhereFromParsedExpression,
  UnsupportedFilterError,
  ApplyPipeline,
  ComputeExpression,
  ComputeNode,
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
  encodeDeltaToken,
  decodeDeltaToken,
  DeltaTokenPayload,
  DeltaTokenBucketState,
} from '../util/delta-token';
import {
  applyControllerSecurityMetadata,
  mergeMethodAliasMaps,
  MethodAliasMap,
  ControllerSecurityMetadata,
} from '../util/security-metadata';
import {
  CrudHookBundle,
  CrudHookContext,
  CrudOnContext,
  CrudOperation,
  CrudScope,
} from '../types/crud-hooks';
import { ODATA_BINDINGS, ODataLogger, ODataTenantThrottler } from '../keys';
import { ODataConfig, ODataApplyTelemetryEvent, ODataRequestState } from '../types';
import * as ipaddr from 'ipaddr.js';
import { getODataSearchableProps } from '../decorators/search.decorators';
import { ensureModelDefinitionWithRelations } from '../util/model-definition';
import { isEntityCtor } from '../util/model-helpers';
import { ensureNavigationTargetKey } from '../util/relation-metadata';
import {
  ResolvedNavigationPath,
  resolveNavigationPath,
  NavigationPathError,
} from '../util/navigation-path';
import {
  PrimitivePropertyKind,
  classifyPrimitiveProperty,
  resolveStructuredPropertySegments,
} from '../util/structured-metadata';
import {
  ApplyExecutionPlan,
  ApplyAggregationStage,
  buildApplyExecutionPlan,
  collectNavigationPathsForStage,
} from '../services/odata-apply-planner.service';
import {
  ODataApplyExecutorRegistry,
  ODataApplyExecutorContext,
} from '../services/odata-apply-executor.registry';
import {
  signSkipToken,
  verifySkipToken,
  TokenVerificationError,
  TokenSecurityOptions,
  DeltaTokenSecurityOptions,
  stableStringify,
} from '../util/token-signing';
import { validateDeltaToken, DeltaTokenValidationResult } from '../util/delta-token-validation';
import { ensureConfigValidated } from '../util/config-validation';
import {
  emitTelemetryEvent,
  recordStatistics,
  StatisticsUpdate,
  TelemetryEventOptions,
} from '../util/telemetry';
import { acceptsAnyMediaType } from '../util/accept';
import { normalizeBasePath } from '../util/base-path';
import { Readable } from 'stream';
import {
  ODataMediaHandler,
  ODataMediaReadResult,
  ODataMediaWriteResult,
  PropertyBackedMediaHandler,
} from '../services/odata-media-handler';
type CrudEntity = Entity & { [key: string]: unknown };
type CrudRepo = DefaultCrudRepository<CrudEntity, unknown>;
type NormalizedInclusion = Exclude<InclusionFilter, string>;
type CrudWhere = Where<CrudEntity>;
type SearchComparisonStrategy = {
  positive: 'like' | 'ilike';
  negative: 'nlike' | 'nilike';
};

const DB_METHODS: ReadonlySet<string> = new Set([
  'find',
  'findOne',
  'findById',
  'create',
  'createAll',
  'updateAll',
  'updateById',
  'replaceById',
  'deleteById',
  'deleteAll',
  'count',
  'exists',
  'execute',
  'save',
]);

class ApplyResultLimitExceededError extends HttpErrors.BadRequest {
  constructor(
    public readonly limit: number,
    public readonly currentSize: number,
  ) {
    super(
      `$apply result exceeds the server limit of ${limit} records. Refine the query or increase maxApplyResultSize.`,
    );
    this.name = 'ApplyResultLimitExceededError';
  }
}

interface ApplyFallbackOptions {
  maxRows?: number;
}

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

type ApplyFieldInput =
  | { kind: 'model'; modelCtor: typeof Entity }
  | { kind: 'columns'; columns: Set<string> };

type ApplyFieldOutput =
  | { kind: 'model'; modelCtor: typeof Entity; columns?: Set<string> }
  | { kind: 'columns'; columns: Set<string> };

interface PropertyNormalizationPlan {
  kind: 'datetimeoffset' | 'date' | 'timeOfDay' | 'duration' | 'int64' | 'decimal';
  edmType: string;
  isCollection: boolean;
  collectionEdmType?: string;
}

interface NormalizedPropertyValue {
  value: unknown;
  typeAnnotation?: string;
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

type ODataVisibility = 'documented' | 'undocumented';

function withODataSpecMetadata<T extends OperationObject>(spec: T, visibility: ODataVisibility): T {
  return {
    ...spec,
    'x-odata-generated': true,
    'x-odata-visibility': (spec as Record<string, unknown>)['x-odata-visibility'] ?? visibility,
  };
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
  const modelDefinition = (ensureModelDefinitionWithRelations(modelCtor) ??
    ((modelCtor as { definition?: ModelDefinition }).definition as
      | ModelDefinition
      | undefined)) as any;
  const idType = inferIdParamType(modelDefinition);
  const idParam =
    idType === 'number'
      ? param.path.number('id')
      : idType === 'boolean'
        ? param.path.boolean('id')
        : param.path.string('id');
  const filterParam = param.filter(modelCtor);
  const filterExcludingWhereParam = param.filter(modelCtor, { exclude: 'where' });
  const idProperties = getIdProperties(modelDefinition);
  const modelRelations = (modelDefinition?.relations ?? {}) as RelationDefinitionMap;
  const etagProperties = normalizeEtagProperties(def.etagProperties);
  const etagPropertyDefs = (etagProperties ?? []).reduce<
    Record<string, PropertyDefinition | undefined>
  >((acc, prop) => {
    acc[prop] = modelDefinition?.properties?.[prop] as PropertyDefinition | undefined;
    return acc;
  }, {});
  const primaryEtagProperty = etagProperties?.[0];
  const optionalProperties = Array.from(new Set([...idProperties, ...(etagProperties ?? [])]));
  const operationVisibility: ODataVisibility =
    def.documentInOpenApi === false ? 'undocumented' : 'documented';
  const hasStream = Boolean(def.hasStream);
  const mediaField = def.mediaField;
  const mediaContentTypeField = def.mediaContentTypeField;
  const mediaEtagField = def.mediaEtagField;
  const mediaLengthField = def.mediaLengthField;
  const mediaHandlerBindingKey = def.mediaHandlerBindingKey;
  const mediaMaxPayloadBytes = def.mediaMaxPayloadBytes;

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

  const normalizeInclude = (include: InclusionFilter): NormalizedInclusion =>
    typeof include === 'string' ? { relation: include } : include;

  const projectRelationField = (
    fields: Filter<AnyObject>['fields'] | undefined,
    relation: string,
  ): Filter<AnyObject>['fields'] | undefined => {
    if (fields == null) return fields;
    if (Array.isArray(fields)) {
      return fields.includes(relation) ? fields : [...fields, relation];
    }
    if (typeof fields === 'object') {
      return { ...(fields as Record<string, boolean>), [relation]: true };
    }
    if (typeof fields === 'string') {
      return fields === relation ? fields : [fields, relation];
    }
    return fields;
  };

  const resolveTargetRelations = (
    meta: AnyObject | undefined,
  ): RelationDefinitionMap | undefined => {
    if (!meta) return undefined;
    const target = meta.target as (() => typeof Entity) | typeof Entity | undefined;
    if (!target) return undefined;
    let ctor: typeof Entity | undefined;
    const maybeCtor = target as typeof Entity;
    if (isEntityCtor(maybeCtor)) {
      ctor = maybeCtor;
    } else if (typeof target === 'function') {
      try {
        ctor = (target as () => typeof Entity)();
      } catch {
        ctor = undefined;
      }
    }
    if (!ctor) return undefined;
    const definition = (ctor as { definition?: ModelDefinition }).definition as
      | ModelDefinition
      | undefined;
    return (definition?.relations ?? {}) as RelationDefinitionMap;
  };

  const ensureIncludeProjection = (
    target: Filter<AnyObject> | undefined,
    includes: InclusionFilter[] | undefined,
    relations?: RelationDefinitionMap,
  ) => {
    if (!target || !includes?.length) return;
    for (const include of includes) {
      const normalized = normalizeInclude(include);
      if (!normalized.relation) continue;
      const nextFields = projectRelationField(
        target.fields as Filter<AnyObject>['fields'],
        normalized.relation,
      );
      if (nextFields !== undefined || target.fields !== undefined) {
        target.fields = nextFields;
      }
      const relationMeta = relations?.[normalized.relation] as AnyObject | undefined;
      const foreignKey = relationMeta ? ensureNavigationTargetKey(relationMeta) : undefined;
      if (foreignKey && normalized.scope?.fields) {
        const scoped = projectRelationField(
          normalized.scope.fields as Filter<AnyObject>['fields'],
          foreignKey,
        );
        if (scoped !== undefined || normalized.scope.fields !== undefined) {
          normalized.scope.fields = scoped;
        }
      }
      const childRelations = resolveTargetRelations(relationMeta);
      if (normalized.scope) {
        ensureIncludeProjection(
          normalized.scope as Filter<AnyObject>,
          normalized.scope.include as InclusionFilter[] | undefined,
          childRelations,
        );
      }
    }
  };

  const mergeIncludes = (
    target: InclusionFilter[] = [],
    source: InclusionFilter[] = [],
  ): InclusionFilter[] => {
    const merged = new Map<string, NormalizedInclusion>();

    for (const include of target) {
      const normalized = normalizeInclude(include);
      if (normalized.relation) {
        merged.set(normalized.relation, { ...normalized });
      }
    }

    for (const include of source) {
      const normalized = normalizeInclude(include);
      if (!normalized.relation) continue;
      const existing = merged.get(normalized.relation);
      merged.set(
        normalized.relation,
        existing ? { ...existing, ...normalized } : { ...normalized },
      );
    }

    return Array.from(merged.values());
  };

  const hooks: CrudHookBundle | undefined = def.hooks;
  const deepInsertEnabledForSet = Boolean(def.deepInsert);
  const buildStreamEntry = () =>
    ({
      'x-parser': 'stream',
    }) as AnyObject;
  const createPayloadSchema = getModelSchemaRef(modelCtor, {
    title: `New${modelCtor.name ?? 'Entity'}`,
    optional: optionalProperties as unknown as (keyof Entity)[],
    includeRelations: deepInsertEnabledForSet,
  }) as SchemaObject;
  normalizeSchemaFormats(createPayloadSchema as AnyObject);
  const createRequestContent: ContentObject = {
    'application/json': {
      schema: createPayloadSchema,
    },
    ...(hasStream
      ? {
          'application/octet-stream': buildStreamEntry(),
          'text/plain': buildStreamEntry(),
          '*/*': buildStreamEntry(),
        }
      : {}),
  } as ContentObject;
  const mediaRequestContent: ContentObject | undefined = hasStream
    ? ({
        'application/octet-stream': buildStreamEntry(),
        'text/plain': buildStreamEntry(),
        '*/*': buildStreamEntry(),
      } as ContentObject)
    : undefined;
  const deepUpdateEnabledForSet = Boolean(def.deepUpdate);
  const sourceCtrlBindingKey: string | undefined = def.sourceControllerBindingKey;
  // Determine PATCH body schema at boot.
  // - When deep update is disabled, use the model's partial schema (strict).
  // - When deep update is enabled, allow only known model fields and
  //   supported relation keys (hasOne/hasMany, excluding through). Unknown
  //   top-level properties are rejected.
  const basePatchSchema = getModelSchemaRef(modelCtor, {
    title: `${modelCtor.name ?? 'Entity'}Patch`,
    partial: true,
  }) as SchemaObject;
  normalizeSchemaFormats(basePatchSchema as AnyObject);

  const PROPERTY_CONSTRAINT_KEYS = [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minItems',
    'maxItems',
    'uniqueItems',
  ];

  const isReferenceSchema = (value: unknown): value is ReferenceObject => {
    return Boolean(value && typeof value === 'object' && '$ref' in (value as AnyObject));
  };

  function normalizeSchemaFormats(schema?: AnyObject): void {
    if (!schema || typeof schema !== 'object') return;
    if ('dataType' in schema) {
      delete schema.dataType;
    }
    if (typeof schema.format === 'string') {
      const normalized = schema.format.trim().toLowerCase();
      if (normalized === 'buffer') {
        schema.format = 'byte';
      }
    }
    if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
      normalizeSchemaFormats(schema.items as AnyObject);
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const value of Object.values(schema.properties)) {
        if (value && typeof value === 'object') {
          normalizeSchemaFormats(value as AnyObject);
        }
      }
    }
    if (schema.definitions && typeof schema.definitions === 'object') {
      for (const value of Object.values(schema.definitions)) {
        if (value && typeof value === 'object') {
          normalizeSchemaFormats(value as AnyObject);
        }
      }
    }
    if (schema.allOf && Array.isArray(schema.allOf)) {
      for (const entry of schema.allOf) {
        if (entry && typeof entry === 'object') {
          normalizeSchemaFormats(entry as AnyObject);
        }
      }
    }
    if (schema.anyOf && Array.isArray(schema.anyOf)) {
      for (const entry of schema.anyOf) {
        if (entry && typeof entry === 'object') {
          normalizeSchemaFormats(entry as AnyObject);
        }
      }
    }
    if (schema.oneOf && Array.isArray(schema.oneOf)) {
      for (const entry of schema.oneOf) {
        if (entry && typeof entry === 'object') {
          normalizeSchemaFormats(entry as AnyObject);
        }
      }
    }
  }

  const cloneSchemaObject = (schema: AnyObject | undefined): SchemaObject => {
    if (!schema) return {} as SchemaObject;
    const clone = JSON.parse(JSON.stringify(schema)) as SchemaObject;
    normalizeSchemaFormats(clone as AnyObject);
    return clone;
  };

  const applyPropertyConstraints = (schema: SchemaObject, propDef?: PropertyDefinition): void => {
    if (!propDef) return;
    const source = propDef as AnyObject;
    if (source.nullable === true) schema.nullable = true;
    if (source.default !== undefined) schema.default = source.default;
    if (Array.isArray(source.enum)) schema.enum = [...source.enum];
    for (const key of PROPERTY_CONSTRAINT_KEYS) {
      if (source[key] === undefined) continue;
      const value = source[key];
      if (key === 'format' && typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        (schema as AnyObject)[key] = normalized === 'buffer' ? 'byte' : value;
        continue;
      }
      (schema as AnyObject)[key] = value;
    }
  };

  const schemaForType = (type: unknown, propDef?: PropertyDefinition): SchemaObject | undefined => {
    if (!type) return undefined;
    const resolveName = (candidate: unknown): string | undefined => {
      if (typeof candidate === 'string') return candidate.toLowerCase();
      if (typeof candidate === 'function' && candidate.name) return candidate.name.toLowerCase();
      return undefined;
    };
    const name = resolveName(type);
    if (name === 'number') return { type: 'number' };
    if (name === 'string') return { type: 'string' };
    if (name === 'boolean') return { type: 'boolean' };
    if (name === 'date' || name === 'datetime' || type === Date) {
      return { type: 'string', format: 'date-time' };
    }
    if (name === 'buffer') {
      return { type: 'string', format: 'byte' };
    }
    if (name === 'array' || type === Array) {
      const itemType = (propDef as AnyObject)?.itemType;
      let itemsSchema: SchemaObject | undefined;
      const jsonSchemaItems = (propDef as AnyObject)?.jsonSchema?.items;
      if (jsonSchemaItems && typeof jsonSchemaItems === 'object') {
        itemsSchema = cloneSchemaObject(jsonSchemaItems as AnyObject);
      } else if (itemType) {
        if (typeof itemType === 'object' && (itemType as AnyObject).type) {
          itemsSchema =
            schemaForType((itemType as PropertyDefinition).type, itemType as PropertyDefinition) ??
            ({} as SchemaObject);
          if (itemType && typeof itemType === 'object') {
            applyPropertyConstraints(itemsSchema, itemType as PropertyDefinition);
          }
        } else {
          itemsSchema = schemaForType(itemType, undefined) ?? ({} as SchemaObject);
        }
      }
      return { type: 'array', items: itemsSchema ?? ({} as SchemaObject) };
    }
    if (name === 'object' || type === Object) {
      return { type: 'object' };
    }
    return undefined;
  };

  const resolvePropertySchema = (
    propDef: PropertyDefinition | undefined,
    baseSchema: SchemaObject | ReferenceObject | undefined,
  ): SchemaObject => {
    if (propDef?.jsonSchema && typeof propDef.jsonSchema === 'object') {
      return cloneSchemaObject(propDef.jsonSchema as AnyObject);
    }
    if (baseSchema && !isReferenceSchema(baseSchema)) {
      const clone = cloneSchemaObject(baseSchema);
      applyPropertyConstraints(clone, propDef);
      return clone;
    }
    const derived = schemaForType(propDef?.type, propDef);
    if (derived) {
      applyPropertyConstraints(derived, propDef);
      return derived;
    }
    if (baseSchema) {
      if (isReferenceSchema(baseSchema)) {
        return { allOf: [baseSchema] } as SchemaObject;
      }
      return cloneSchemaObject(baseSchema);
    }
    return {} as SchemaObject;
  };

  const buildNestedPatchSchema = (ctor: typeof Entity | undefined, depth: number): SchemaObject => {
    if (!ctor) return { type: 'object', additionalProperties: false };
    const maxDepth = 10;
    if (depth > maxDepth) return { type: 'object', additionalProperties: false };
    const def = (ctor as unknown as { definition?: ModelDefinition }).definition as
      | ModelDefinition
      | undefined;
    const title = `${ctor.name ?? 'Entity'}Patch`;
    const base = getModelSchemaRef(ctor, {
      title,
      partial: true,
    }) as SchemaObject;
    const properties: Record<string, SchemaObject> = {};
    const scalarProps = Object.entries(def?.properties ?? {}) as [
      string,
      PropertyDefinition | undefined,
    ][];
    for (const [name, propDef] of scalarProps) {
      const basePropSchema = base.properties?.[name] as SchemaObject | ReferenceObject | undefined;
      properties[name] = resolvePropertySchema(propDef, basePropSchema);
    }
    const relations = (def?.relations ?? {}) as Record<string, AnyObject>;
    for (const [relName, relMetaRaw] of Object.entries(relations)) {
      const relMeta = relMetaRaw as AnyObject | undefined;
      if (!relMeta || relMeta.through) continue;
      const relType = relMeta?.type ?? relMeta?.relationType;
      const targetCtor =
        typeof relMeta?.target === 'function' ? (relMeta.target() as typeof Entity) : undefined;
      const childBase = buildNestedPatchSchema(targetCtor, depth + 1);
      const childStrict: SchemaObject = {
        type: 'object',
        title: childBase.title,
        properties: { ...(childBase.properties ?? {}) },
        required: childBase.required as string[] | undefined,
        additionalProperties: false,
      };
      if (relType === 'hasOne') {
        properties[relName] = childStrict;
      } else if (relType === 'hasMany') {
        properties[relName] = { type: 'array', items: childStrict } as SchemaObject;
      }
    }
    return {
      type: 'object',
      title,
      properties,
      additionalProperties: false,
    } as SchemaObject;
  };

  let updateSchema: SchemaObject;
  if (!deepUpdateEnabledForSet) {
    updateSchema = basePatchSchema;
  } else {
    updateSchema = buildNestedPatchSchema(modelCtor as unknown as typeof Entity, 0);
  }

  class ODataCrudController {
    formatOverridden = false;
    readonly entityCtor = modelCtor as typeof Entity;
    _throttleApplied = false;
    requestStateCache?: ODataRequestState | null;
    searchComparisonStrategy?: SearchComparisonStrategy;
    modelPropertyCache = new WeakMap<typeof Entity, Set<string>>();
    _trustedProxyRanges?: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>;
    mediaHandlerCache?: ODataMediaHandler | null;

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
      @inject(ODATA_BINDINGS.LOGGER)
      public readonly logger: ODataLogger,
      @inject(ODATA_BINDINGS.THROTTLER)
      public readonly throttler: ODataTenantThrottler,
    ) {
      this.repository = this.wrapRepository(repository);
      ensureConfigValidated(this.cfg);
    }

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
        const plain = candidate.toObject({}) ?? undefined;
        if (plain) {
          this.normalizePlainEntityGraph(
            plain,
            this.getModelDefinition(this.getModelCtorFromEntity(entity)),
          );
        }
        return plain ?? undefined;
      }
      if (typeof candidate.toJSON === 'function') {
        const plain = candidate.toJSON() ?? undefined;
        if (plain) {
          this.normalizePlainEntityGraph(
            plain,
            this.getModelDefinition(this.getModelCtorFromEntity(entity)),
          );
        }
        return plain ?? undefined;
      }
      if (typeof entity === 'object') {
        const clone = { ...(entity as AnyObject) };
        this.normalizePlainEntityGraph(
          clone,
          this.getModelDefinition(this.getModelCtorFromEntity(entity)),
        );
        return clone;
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
      const normalized = this.normalizePlainEntityForResponse(plain, this.entityCtor);
      if (hasStream) {
        this.decorateMediaAnnotations(normalized, plain, etag);
      }
      if (!etag) return normalized;
      if (normalized['@odata.etag'] === etag) return normalized;
      return { ...normalized, '@odata.etag': etag };
    }

    decoratePlainEntities(plainEntities: AnyObject[]): AnyObject[] {
      return plainEntities.map((plain) =>
        this.decoratePlainEntity(
          plain,
          this.etagEnabled() ? this.computeEtagFromPlain(plain) : undefined,
        ),
      );
    }

    getModelCtorFromEntity(entity: CrudEntity | AnyObject | undefined): typeof Entity | undefined {
      if (!entity) return undefined;
      const ctor = (entity as AnyObject)?.constructor;
      if (typeof ctor !== 'function') return undefined;
      if ((ctor as unknown) === Object) return undefined;
      const maybeDefinition = (ctor as unknown as { definition?: ModelDefinition }).definition;
      if (maybeDefinition) return ctor as typeof Entity;
      if (isEntityCtor(ctor)) return ctor as typeof Entity;
      return undefined;
    }

    getModelDefinition(ctor?: typeof Entity): ModelDefinition | undefined {
      const targetCtor = (ctor ?? this.entityCtor) as unknown as { definition?: ModelDefinition };
      return targetCtor?.definition as ModelDefinition | undefined;
    }

    normalizePlainEntityForResponse(plain: AnyObject, ctor?: typeof Entity): AnyObject {
      const clone = { ...plain };
      this.normalizePlainEntityGraph(clone, this.getModelDefinition(ctor));
      return clone;
    }

    normalizePlainEntityGraph(target: AnyObject, definition?: ModelDefinition) {
      if (!target || !definition) return;
      this.normalizeScalarProperties(target, definition);
      this.normalizeRelationGraphs(target, definition);
    }

    normalizeScalarProperties(target: AnyObject, definition: ModelDefinition) {
      const props = definition.properties ?? {};
      for (const [propName, propMeta] of Object.entries(props)) {
        if (!Object.prototype.hasOwnProperty.call(target, propName)) continue;
        const value = target[propName];
        if (value === undefined || value === null) continue;
        const plan = this.classifyProperty(propMeta as PropertyDefinition | undefined);
        if (!plan) continue;
        const normalized = this.applyPropertyNormalization(value, plan);
        if (!normalized) continue;
        target[propName] = normalized.value;
        if (normalized.typeAnnotation) {
          target[`${propName}@odata.type`] = normalized.typeAnnotation;
        }
      }
    }

    normalizeRelationGraphs(target: AnyObject, definition: ModelDefinition) {
      const relations = (definition.relations ?? {}) as RelationDefinitionMap;
      for (const [relationName, relationMetaRaw] of Object.entries(relations)) {
        if (!Object.prototype.hasOwnProperty.call(target, relationName)) continue;
        const relationValue = target[relationName];
        if (relationValue === undefined || relationValue === null) continue;
        const relationMeta = relationMetaRaw as AnyObject | undefined;
        if (!relationMeta) continue;
        let relationCtor: typeof Entity | undefined;
        if (typeof relationMeta.target === 'function') {
          try {
            relationCtor = relationMeta.target();
          } catch {
            relationCtor = undefined;
          }
        }
        if (!relationCtor) continue;
        const relationDefinition = this.getModelDefinition(relationCtor);
        if (!relationDefinition) continue;
        if (Array.isArray(relationValue)) {
          target[relationName] = relationValue.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const nested = { ...(item as AnyObject) };
            this.normalizePlainEntityGraph(nested, relationDefinition);
            return nested;
          });
        } else if (typeof relationValue === 'object') {
          const nested = { ...(relationValue as AnyObject) };
          this.normalizePlainEntityGraph(nested, relationDefinition);
          target[relationName] = nested;
        }
      }
    }

    hasMediaStream(): boolean {
      return hasStream;
    }

    async resolveMediaHandler(): Promise<ODataMediaHandler | undefined> {
      if (!hasStream) return undefined;
      if (this.mediaHandlerCache !== undefined) {
        return this.mediaHandlerCache ?? undefined;
      }
      if (mediaHandlerBindingKey) {
        try {
          const handler = await this.httpCtx.get<ODataMediaHandler>(mediaHandlerBindingKey, {
            optional: true,
          });
          if (handler) {
            this.mediaHandlerCache = handler;
            return handler;
          }
        } catch {
          this.mediaHandlerCache = null;
        }
      }
      if (mediaField) {
        const fallback = new PropertyBackedMediaHandler(
          this.repository as unknown as DefaultCrudRepository<CrudEntity, unknown>,
          mediaField,
          { maxPayloadBytes: mediaMaxPayloadBytes },
        );
        this.mediaHandlerCache = fallback;
        return fallback;
      }
      this.mediaHandlerCache = null;
      return undefined;
    }

    async requireMediaHandler(): Promise<ODataMediaHandler> {
      const handler = await this.resolveMediaHandler();
      if (handler) return handler;
      throw new HttpErrors.NotImplemented('Media handler is not configured for this entity set.');
    }

    buildMediaProjectionFields(): Pick<AnyObject, string> | undefined {
      if (!hasStream) return undefined;
      const projection: Record<string, boolean> = {};
      for (const idProp of idProperties) projection[idProp] = true;
      if (mediaField) projection[mediaField] = true;
      if (mediaContentTypeField) projection[mediaContentTypeField] = true;
      if (mediaEtagField) projection[mediaEtagField] = true;
      if (mediaLengthField) projection[mediaLengthField] = true;
      if (etagProperties) {
        for (const prop of etagProperties) projection[prop] = true;
      }
      return Object.keys(projection).length ? projection : undefined;
    }

    decorateMediaAnnotations(target: AnyObject, source: AnyObject, entityEtag?: string) {
      if (!hasStream) return;
      let entityUrl = this.buildEntityLocationUrl(this.extractEntityId(source), source);
      if (!entityUrl) {
        const keyLiteral = this.buildEntityKeyLiteral(undefined, source);
        if (keyLiteral) {
          const basePath = normalizeBasePath(this.cfg?.basePath);
          const prefix = basePath === '/' ? '' : basePath;
          entityUrl = `${prefix}/${setName}${keyLiteral}`;
        }
      }
      if (entityUrl) {
        const valueUrl = entityUrl.endsWith('/$value') ? entityUrl : `${entityUrl}/$value`;
        target['@odata.mediaReadLink'] = valueUrl;
        target['@odata.mediaEditLink'] = valueUrl;
      }
      const contentType = this.readMediaContentType(source);
      if (contentType) {
        target['@odata.mediaContentType'] = contentType;
      }
      const mediaEtag = this.readMediaEtag(source) ?? entityEtag;
      if (mediaEtag) {
        target['@odata.mediaEtag'] = mediaEtag;
      }
    }

    readMediaEtag(plain: AnyObject | undefined): string | undefined {
      if (!plain) return undefined;
      if (mediaEtagField) {
        const raw = plain[mediaEtagField];
        if (typeof raw === 'string' && raw.trim()) return raw;
      }
      return this.computeEtagFromPlain(plain);
    }

    readMediaContentType(plain: AnyObject | undefined): string | undefined {
      if (!plain) return undefined;
      if (mediaContentTypeField) {
        const raw = plain[mediaContentTypeField];
        if (typeof raw === 'string' && raw.trim()) return raw;
      }
      return 'application/octet-stream';
    }

    readMediaLength(plain: AnyObject | undefined): number | undefined {
      if (!plain || !mediaLengthField) return undefined;
      const value = plain[mediaLengthField];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      return undefined;
    }

    mergeMediaMetadata(target: AnyObject | undefined, updates: AnyObject | undefined): AnyObject {
      if (!updates) return target ?? {};
      const next = target ? { ...target } : {};
      for (const [key, value] of Object.entries(updates)) {
        next[key] = value;
      }
      return next;
    }

    resolveMediaMetadata(
      handlerResult: ODataMediaWriteResult | undefined,
      overrides?: { contentType?: string; contentLength?: number; etag?: string },
    ): { contentType?: string; length?: number; etag?: string } {
      const lengthCandidate = handlerResult?.length ?? overrides?.contentLength;
      const length =
        typeof lengthCandidate === 'number' && Number.isFinite(lengthCandidate)
          ? lengthCandidate
          : undefined;
      const contentType = handlerResult?.contentType ?? overrides?.contentType;
      const etag = handlerResult?.etag ?? overrides?.etag ?? this.generateMediaEtag();
      return { contentType, length, etag };
    }

    async applyMediaMetadataUpdates(
      id: unknown,
      handlerResult: ODataMediaWriteResult | undefined,
      overrides?: { contentType?: string; contentLength?: number; etag?: string },
      resolved?: { contentType?: string; length?: number; etag?: string },
    ): Promise<AnyObject | undefined> {
      if (!hasStream) return undefined;
      const entityId = this.coerceParentId(id);
      const patch: AnyObject = {};
      const updates: AnyObject = {};
      const metadata = resolved ?? this.resolveMediaMetadata(handlerResult, overrides);
      const { contentType, length, etag } = metadata;
      if (mediaContentTypeField && contentType) {
        patch[mediaContentTypeField] = contentType;
        updates[mediaContentTypeField] = contentType;
      }
      if (mediaLengthField && typeof length === 'number' && Number.isFinite(length)) {
        patch[mediaLengthField] = length;
        updates[mediaLengthField] = length;
      }
      if (mediaEtagField && etag) {
        patch[mediaEtagField] = etag;
        updates[mediaEtagField] = etag;
      }
      if (Object.keys(patch).length) {
        await this.repository.updateById(entityId as any, patch, this.repositoryOptions());
      }
      return Object.keys(updates).length ? updates : undefined;
    }

    async clearMediaMetadata(id: unknown): Promise<void> {
      if (!hasStream) return;
      const entityId = this.coerceParentId(id);
      const patch: AnyObject = {};
      if (mediaContentTypeField) patch[mediaContentTypeField] = null;
      if (mediaLengthField) patch[mediaLengthField] = null;
      if (mediaEtagField) patch[mediaEtagField] = null;
      if (Object.keys(patch).length) {
        await this.repository.updateById(entityId as any, patch, this.repositoryOptions());
      }
    }

    setMediaEtagHeader(plain: AnyObject | undefined): void {
      if (!hasStream) return;
      const etag = this.readMediaEtag(plain);
      if (etag) {
        this.response.set('ETag', etag);
      }
    }

    ensureMediaAccepts(contentType?: string): void {
      if (!this.cfg?.strict) return;
      const acceptHeader = this.request.get('Accept') ?? this.request.headers?.['accept'];
      const accept = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader;
      if (!accept?.trim()) return;
      const normalized = this.normalizeMediaType(contentType);
      const allowed = normalized
        ? [normalized, 'application/octet-stream', '*/*']
        : ['application/octet-stream', '*/*'];
      const unique = Array.from(new Set(allowed));
      if (!acceptsAnyMediaType(accept, unique)) {
        const requirement = normalized ?? 'binary responses';
        const err = new HttpErrors.NotAcceptable(
          `Accept header must allow ${requirement} (${unique.join(', ')}).`,
        );
        (err as any).code = 'NotAcceptable';
        throw err;
      }
    }

    normalizeMediaType(value?: string): string | undefined {
      if (!value) return undefined;
      const [type] = value.split(';');
      const normalized = type?.trim().toLowerCase();
      if (!normalized || !normalized.includes('/')) return undefined;
      return normalized;
    }

    ensureMediaContentType(): string {
      const type =
        this.request.get('Content-Type') ??
        (this.request.headers?.['content-type'] as string | undefined);
      if (!type || !type.trim()) {
        const err = new HttpErrors.UnsupportedMediaType(
          'Content-Type header is required for media requests.',
        );
        (err as any).code = 'UnsupportedMediaType';
        throw err;
      }
      return type;
    }

    isJsonBodyRequest(): boolean {
      const type =
        this.request.get('Content-Type') ??
        (this.request.headers?.['content-type'] as string | undefined);
      if (!type) return false;
      const lower = type.toLowerCase();
      return lower.includes('application/json') || lower.endsWith('+json');
    }

    buildMediaSlugPayload(slug?: string): AnyObject | undefined {
      if (!slug || !idProperties.length || idProperties.length > 1) return undefined;
      const property = idProperties[0];
      const propDef = modelDefinition?.properties?.[property] as PropertyDefinition | undefined;
      const value = this.coerceSlugValue(slug, propDef);
      if (value === undefined) return undefined;
      return { [property]: value };
    }

    detectPrimitivePropertyType(
      prop?: PropertyDefinition,
    ): 'bigint' | 'number' | 'boolean' | undefined {
      if (!prop) return undefined;
      const raw = prop.type;
      if (typeof raw === 'function') {
        if (raw === Number) return 'number';
        if (raw === Boolean) return 'boolean';
        if ((raw as unknown) === BigInt) return 'bigint';
        const lowered = raw.name?.toLowerCase();
        if (lowered === 'bigint' || lowered === 'number' || lowered === 'boolean') {
          return lowered as 'bigint' | 'number' | 'boolean';
        }
      } else if (typeof raw === 'string') {
        const lowered = raw.toLowerCase();
        if (lowered === 'bigint' || lowered === 'number' || lowered === 'boolean') {
          return lowered as 'bigint' | 'number' | 'boolean';
        }
      }
      const schema = (prop as AnyObject)?.jsonSchema as AnyObject | undefined;
      const schemaType = typeof schema?.type === 'string' ? schema.type.toLowerCase() : undefined;
      const schemaFormat =
        typeof schema?.format === 'string' ? schema.format.toLowerCase() : undefined;
      const schemaDataType =
        typeof schema?.dataType === 'string' ? schema.dataType.toLowerCase() : undefined;
      if (
        schemaDataType === 'int64' ||
        schemaDataType === 'long' ||
        schemaFormat === 'int64' ||
        schemaFormat === 'long'
      ) {
        return 'bigint';
      }
      if (schemaType === 'boolean') return 'boolean';
      if (schemaType === 'number' || schemaType === 'integer') return 'number';
      return undefined;
    }

    propertyDeclaresString(prop?: PropertyDefinition): boolean {
      if (!prop) return false;
      const raw = prop.type;
      if (raw === String) return true;
      if (typeof raw === 'function' && raw.name?.toLowerCase() === 'string') return true;
      if (typeof raw === 'string' && raw.toLowerCase() === 'string') return true;
      return false;
    }

    coerceSlugValue(value: string, prop?: PropertyDefinition): unknown | undefined {
      const primitive = this.detectPrimitivePropertyType(prop);
      const declaresString = this.propertyDeclaresString(prop);
      if (primitive === 'bigint') {
        try {
          const parsed = BigInt(value);
          return declaresString ? value : parsed;
        } catch {
          return undefined;
        }
      }
      if (primitive === 'number') {
        const num = Number(value);
        if (Number.isNaN(num)) return undefined;
        return num;
      }
      if (primitive === 'boolean') {
        const normalized = value.toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
        return undefined;
      }
      return value;
    }

    coerceIdentifierLiteral(
      literal: string,
      prop?: PropertyDefinition,
      descriptor = 'identifier',
    ): unknown {
      const primitive = this.detectPrimitivePropertyType(prop);
      const declaresString = this.propertyDeclaresString(prop);
      if (primitive === 'bigint') {
        try {
          const parsed = BigInt(literal);
          return declaresString ? literal : parsed;
        } catch {
          throw new HttpErrors.BadRequest(`Invalid ${descriptor}: ${literal}`);
        }
      }
      if (primitive === 'number') {
        const num = Number(literal);
        if (Number.isNaN(num)) {
          throw new HttpErrors.BadRequest(`Invalid ${descriptor}: ${literal}`);
        }
        return num;
      }
      if (primitive === 'boolean') {
        const normalized = literal.toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
        throw new HttpErrors.BadRequest(`Invalid ${descriptor}: ${literal}`);
      }
      return literal;
    }

    stripODataAnnotations(target: AnyObject | undefined): void {
      if (!target || typeof target !== 'object') return;
      for (const key of Object.keys(target)) {
        if (key.includes('@odata.')) {
          delete target[key];
          continue;
        }
        const value = target[key];
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (entry && typeof entry === 'object') {
              this.stripODataAnnotations(entry as AnyObject);
            }
          }
        } else if (value && typeof value === 'object') {
          this.stripODataAnnotations(value as AnyObject);
        }
      }
    }

    removeEntityIdProperties(target: AnyObject | undefined, repo?: CrudRepo | AnyObject): void {
      if (!target || typeof target !== 'object' || !repo) return;
      const entityClass = (repo as AnyObject).entityClass as typeof Entity | undefined;
      const idProps = entityClass?.getIdProperties?.() ?? [];
      for (const prop of idProps) {
        if (prop && prop in target) {
          delete target[prop];
        }
      }
    }

    getSlugHeader(): string | undefined {
      const slug =
        this.request.get('Slug') ?? (this.request.headers?.['slug'] as string | undefined);
      if (!slug) return undefined;
      const trimmed = slug.trim();
      return trimmed.length ? trimmed : undefined;
    }

    coerceBodyToStream(body: unknown): Readable {
      if (body instanceof Readable) return body;
      if (Buffer.isBuffer(body)) return Readable.from(body);
      if (body instanceof Uint8Array) return Readable.from(Buffer.from(body));
      if (body instanceof ArrayBuffer) return Readable.from(Buffer.from(new Uint8Array(body)));
      if (typeof body === 'string') return Readable.from(Buffer.from(body));
      if (body == null) {
        throw new HttpErrors.UnsupportedMediaType('Binary body must be provided as a stream.');
      }
      throw new HttpErrors.UnsupportedMediaType('Binary body must be provided as a stream.');
    }

    generateMediaEtag(): string {
      const token = randomBytes(8).toString('hex');
      return `W/"${Date.now().toString(36)}-${token}"`;
    }

    logMediaTelemetry(event: string, context?: Record<string, unknown>) {
      this.emitTelemetry({
        category: 'requests',
        event,
        context: {
          entitySet: setName,
          ...(context ?? {}),
        },
      });
    }

    async streamToResponse(stream: Readable): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        stream.once('error', reject);
        this.response.once('error', reject);
        stream.once('end', resolve);
        stream.pipe(this.response);
      });
    }

    classifyTemporalProperty(
      def: PropertyDefinition | undefined,
    ): 'date' | 'datetimeoffset' | undefined {
      if (!def) return undefined;
      const rawType = def.type;
      if (rawType === Date) return 'datetimeoffset';

      const typeName = typeof rawType === 'string' ? rawType.toLowerCase() : undefined;
      if (
        typeName === 'date' ||
        typeName === 'datetime' ||
        typeName === 'datetimeoffset' ||
        typeName === 'timestamp'
      ) {
        return 'datetimeoffset';
      }

      const schema = (def as AnyObject)?.jsonSchema as AnyObject | undefined;
      const schemaFormat =
        typeof schema?.format === 'string' ? schema.format.toLowerCase() : undefined;
      const schemaType = typeof schema?.type === 'string' ? schema.type.toLowerCase() : undefined;
      const schemaDataType =
        typeof schema?.dataType === 'string' ? schema.dataType.toLowerCase() : undefined;

      if (schemaFormat === 'date') return 'date';
      if (schemaDataType === 'date') return 'date';
      if (schemaFormat === 'date-time') return 'datetimeoffset';
      if (
        schemaDataType === 'datetimeoffset' ||
        schemaDataType === 'datetime' ||
        schemaDataType === 'timestamp'
      ) {
        return 'datetimeoffset';
      }
      if (schemaType === 'string' && schemaFormat === 'date') return 'date';

      return undefined;
    }

    classifyProperty(def: PropertyDefinition | undefined): PropertyNormalizationPlan | undefined {
      if (!def) return undefined;
      const schema = (def as AnyObject)?.jsonSchema as AnyObject | undefined;
      const isArray =
        Array.isArray(def.type) ||
        def.type === 'array' ||
        def.type === Array ||
        schema?.type === 'array';
      if (isArray) {
        const itemSchema = schema?.items as AnyObject | undefined;
        const itemType = Array.isArray(def.type)
          ? def.type[0]
          : ((def as AnyObject).itemType ?? (itemSchema ? itemSchema.type : undefined));
        const nestedDef =
          itemSchema || itemType
            ? ({
                type: itemType ?? itemSchema?.type,
                jsonSchema: itemSchema,
              } as PropertyDefinition)
            : undefined;
        const nestedPlan = this.classifyProperty(nestedDef);
        if (!nestedPlan) return undefined;
        return {
          kind: nestedPlan.kind,
          edmType: nestedPlan.edmType,
          isCollection: true,
          collectionEdmType: nestedPlan.collectionEdmType ?? `Collection(${nestedPlan.edmType})`,
        };
      }

      const temporalKind = this.classifyTemporalProperty(def);
      if (temporalKind === 'datetimeoffset') {
        return { kind: 'datetimeoffset', edmType: 'Edm.DateTimeOffset', isCollection: false };
      }
      if (temporalKind === 'date') {
        return { kind: 'date', edmType: 'Edm.Date', isCollection: false };
      }

      const schemaAny = schema ?? {};
      const format =
        typeof schemaAny.format === 'string' ? schemaAny.format.toLowerCase() : undefined;
      const schemaType =
        typeof schemaAny.type === 'string' ? schemaAny.type.toLowerCase() : undefined;
      const dataType =
        typeof schemaAny.dataType === 'string' ? schemaAny.dataType.toLowerCase() : undefined;
      const rawType = typeof def.type === 'string' ? def.type.toLowerCase() : def.type;

      if (
        format === 'time' ||
        format === 'time-of-day' ||
        dataType === 'timeofday' ||
        rawType === 'time'
      ) {
        return { kind: 'timeOfDay', edmType: 'Edm.TimeOfDay', isCollection: false };
      }
      if (format === 'duration' || dataType === 'duration') {
        return { kind: 'duration', edmType: 'Edm.Duration', isCollection: false };
      }
      if (
        format === 'decimal' ||
        dataType === 'decimal' ||
        schemaAny.precision != null ||
        schemaAny.scale != null
      ) {
        return { kind: 'decimal', edmType: 'Edm.Decimal', isCollection: false };
      }
      const int64Formats = new Set(['int64', 'long']);
      if (
        int64Formats.has(format ?? '') ||
        int64Formats.has(dataType ?? '') ||
        rawType === 'bigint' ||
        rawType === BigInt
      ) {
        return { kind: 'int64', edmType: 'Edm.Int64', isCollection: false };
      }

      return undefined;
    }

    applyPropertyNormalization(
      value: unknown,
      plan: PropertyNormalizationPlan,
    ): NormalizedPropertyValue | undefined {
      if (plan.isCollection) {
        if (!Array.isArray(value)) return undefined;
        const items: unknown[] = [];
        let mutated = false;
        let annotation = false;
        for (const entry of value) {
          const normalized = this.normalizeSingleValue(entry, {
            kind: plan.kind,
            edmType: plan.edmType,
            isCollection: false,
          });
          if (normalized) {
            items.push(normalized.value);
            if (normalized.value !== entry) mutated = true;
            if (normalized.typeAnnotation) annotation = true;
          } else {
            items.push(entry);
          }
        }
        if (!mutated && !annotation) return undefined;
        return {
          value: mutated ? items : value,
          typeAnnotation: annotation
            ? (plan.collectionEdmType ?? `Collection(${plan.edmType})`)
            : undefined,
        };
      }
      return this.normalizeSingleValue(value, plan);
    }

    normalizeSingleValue(
      value: unknown,
      plan: PropertyNormalizationPlan,
    ): NormalizedPropertyValue | undefined {
      switch (plan.kind) {
        case 'datetimeoffset': {
          const normalized = this.normalizeDateTimeOffsetValue(value);
          if (normalized === undefined) return undefined;
          return normalized === value ? { value } : { value: normalized };
        }
        case 'date': {
          const normalized = this.normalizeDateValue(value);
          if (normalized === undefined) return undefined;
          return normalized === value ? { value } : { value: normalized };
        }
        case 'timeOfDay': {
          const normalized = this.normalizeTimeOfDayValue(value);
          if (normalized === undefined) return undefined;
          return normalized === value ? { value } : { value: normalized };
        }
        case 'duration': {
          const normalized = this.normalizeDurationValue(value);
          if (normalized === undefined) return undefined;
          return normalized === value ? { value } : { value: normalized };
        }
        case 'int64':
          return this.normalizeInt64Value(value);
        case 'decimal':
          return this.normalizeDecimalValue(value);
        default:
          return undefined;
      }
    }

    normalizeDateTimeOffsetValue(value: unknown): unknown {
      if (value instanceof Date || typeof value === 'number') {
        const coerced = this.coerceDate(value);
        return coerced ? coerced.toISOString() : value;
      }

      if (typeof value === 'string') {
        const normalized = this.normalizeDateTimeOffsetString(value);
        if (normalized) return normalized;
        const fallback = this.coerceDate(value);
        return fallback ? fallback.toISOString() : value;
      }

      const coerced = this.coerceDate(value);
      return coerced ? coerced.toISOString() : value;
    }

    coerceDate(value: unknown): Date | undefined {
      if (value instanceof Date) return value;
      if (typeof value === 'number') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        const parsedFromNormalized = this.normalizeDateTimeOffsetString(trimmed);
        if (parsedFromNormalized) {
          const date = new Date(parsedFromNormalized);
          return Number.isNaN(date.getTime()) ? undefined : date;
        }
        const direct = new Date(trimmed);
        if (!Number.isNaN(direct.getTime())) return direct;
        const withT = new Date(trimmed.replace(' ', 'T'));
        if (!Number.isNaN(withT.getTime())) return withT;
        const withOffsetColon = trimmed.replace(
          /([+-]\d{2})(\d{2})$/,
          (_match, hours: string, minutes: string) => `${hours}:${minutes}`,
        );
        if (withOffsetColon !== trimmed) {
          const colonDate = new Date(withOffsetColon.replace(' ', 'T'));
          if (!Number.isNaN(colonDate.getTime())) return colonDate;
          const colonDirect = new Date(withOffsetColon);
          if (!Number.isNaN(colonDirect.getTime())) return colonDirect;
        }
        return undefined;
      }
      return undefined;
    }

    normalizeDateTimeOffsetString(raw: string): string | undefined {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;

      const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
      if (canonical.test(trimmed)) return trimmed;

      const partial =
        /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
      const match = partial.exec(trimmed);
      if (!match) return undefined;

      const [, date, time, fraction = '', offsetRaw = ''] = match;

      let offset = offsetRaw ?? '';
      if (!offset) {
        offset = 'Z';
      } else if (offset.toUpperCase() === 'Z') {
        offset = 'Z';
      } else {
        const sign = offset[0];
        let rest = offset.slice(1).replace(':', '');
        if (!/^[+-]$/.test(sign) || rest.length > 4) return undefined;
        if (!/^\d*$/.test(rest)) return undefined;
        if (rest.length === 0) rest = '0000';
        if (rest.length === 2) rest = `${rest}00`;
        if (rest.length !== 4) return undefined;
        const hours = rest.slice(0, 2);
        const minutes = rest.slice(2, 4);
        offset = `${sign}${hours}:${minutes}`;
        if (offset === '+00:00' || offset === '-00:00') {
          offset = 'Z';
        }
      }

      return `${date}T${time}${fraction ?? ''}${offset}`;
    }

    normalizeDateValue(value: unknown): unknown {
      if (value instanceof Date) {
        if (
          value.getUTCHours() === 0 &&
          value.getUTCMinutes() === 0 &&
          value.getUTCSeconds() === 0 &&
          value.getUTCMilliseconds() === 0
        ) {
          return value.toISOString().slice(0, 10);
        }
        const year = value.getFullYear();
        const month = value.getMonth() + 1;
        const day = value.getDate();
        return `${this.padNumber(year, 4)}-${this.padNumber(month, 2)}-${this.padNumber(day, 2)}`;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return value;
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
        const simple = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
        const match = simple.exec(trimmed);
        if (match) {
          const [, yearStr, monthStr, dayStr] = match;
          const year = Number(yearStr);
          const month = Number(monthStr);
          const day = Number(dayStr);
          if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
            return `${this.padNumber(year, 4)}-${this.padNumber(month, 2)}-${this.padNumber(day, 2)}`;
          }
        }
        const parsed = this.coerceDate(trimmed);
        if (parsed) return parsed.toISOString().slice(0, 10);
      }
      return value;
    }

    normalizeTimeOfDayValue(value: unknown): unknown {
      if (value instanceof Date) {
        const hours = value.getUTCHours();
        const minutes = value.getUTCMinutes();
        const seconds = value.getUTCSeconds();
        const millis = value.getUTCMilliseconds();
        return this.formatTimeOfDay(hours, minutes, seconds, millis);
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return value;
        const totalMillis = Math.trunc(value);
        if (!Number.isFinite(totalMillis)) return value;
        const millis = ((totalMillis % 1000) + 1000) % 1000;
        const totalSeconds = (totalMillis - millis) / 1000;
        const seconds = ((totalSeconds % 60) + 60) % 60;
        const totalMinutes = (totalSeconds - seconds) / 60;
        const minutes = ((totalMinutes % 60) + 60) % 60;
        const hours = ((totalMinutes - minutes) / 60) % 24;
        return this.formatTimeOfDay(hours, minutes, seconds, millis);
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return value;
        if (/^\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(trimmed)) return trimmed;
        const partial = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,7})?)?$/;
        const match = partial.exec(trimmed);
        if (match) {
          const hours = Number(match[1]);
          const minutes = Number(match[2]);
          const seconds = match[3] ? Number(match[3]) : 0;
          const fraction = match[4] ?? '';
          if (
            Number.isInteger(hours) &&
            Number.isInteger(minutes) &&
            Number.isInteger(seconds) &&
            hours >= 0 &&
            hours < 24 &&
            minutes >= 0 &&
            minutes < 60 &&
            seconds >= 0 &&
            seconds < 60
          ) {
            return `${this.padNumber(hours, 2)}:${this.padNumber(minutes, 2)}:${this.padNumber(seconds, 2)}${fraction}`;
          }
        }
      }
      return value;
    }

    normalizeDurationValue(value: unknown): unknown {
      if (typeof value === 'number' || typeof value === 'bigint') {
        const millis = typeof value === 'bigint' ? Number(value) : value;
        if (!Number.isFinite(millis)) return value;
        return this.formatDurationFromMilliseconds(millis);
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return value;
        const canonical = /^-?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;
        if (canonical.test(trimmed)) {
          return trimmed.toUpperCase().replace('P0DT', 'P0DT');
        }
        const timeLike = /^(-)?(\d{1,2}):(\d{2}):(\d{2})(\.\d+)?$/;
        const match = timeLike.exec(trimmed);
        if (match) {
          const sign = match[1] ? -1 : 1;
          const hours = Number(match[2]);
          const minutes = Number(match[3]);
          const seconds = Number(match[4]);
          const fraction = match[5] ?? '';
          if (hours >= 0 && minutes >= 0 && minutes < 60 && seconds >= 0 && seconds < 60) {
            const fractionNumeric = fraction ? fraction : '';
            const signPrefix = sign < 0 ? '-' : '';
            const normalized = `${signPrefix}PT${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${seconds || fractionNumeric ? `${seconds}${fractionNumeric}S` : ''}`;
            return normalized || `${signPrefix}PT0S`;
          }
        }
      }
      return value;
    }

    normalizeInt64Value(value: unknown): NormalizedPropertyValue | undefined {
      if (value === undefined || value === null) return undefined;
      let str: string | undefined;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        if (!/^-?\d+$/.test(trimmed)) return undefined;
        str = trimmed;
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value)) return undefined;
        str = value.toFixed(0);
      } else if (typeof value === 'bigint') {
        str = value.toString();
      }
      if (!str) return undefined;
      return { value: str, typeAnnotation: 'Edm.Int64' };
    }

    normalizeDecimalValue(value: unknown): NormalizedPropertyValue | undefined {
      if (value === undefined || value === null) return undefined;
      if (typeof value === 'string') {
        const normalized = this.normalizeDecimalString(value);
        if (!normalized) return undefined;
        return { value: normalized, typeAnnotation: 'Edm.Decimal' };
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return undefined;
        const plain = this.toPlainString(value);
        return { value: plain, typeAnnotation: 'Edm.Decimal' };
      }
      return undefined;
    }

    padNumber(value: number, digits: number): string {
      const sign = value < 0 ? '-' : '';
      const absolute = Math.abs(Math.trunc(value));
      return `${sign}${absolute.toString().padStart(digits, '0')}`;
    }

    formatTimeOfDay(hours: number, minutes: number, seconds: number, millis: number): string {
      const fractionDigits = millis ? this.padNumber(millis, 3).replace(/0+$/, '') : '';
      const suffix = fractionDigits ? `.${fractionDigits}` : '';
      return `${this.padNumber(hours, 2)}:${this.padNumber(minutes, 2)}:${this.padNumber(seconds, 2)}${suffix}`;
    }

    formatDurationFromMilliseconds(totalMillis: number): string {
      if (!Number.isFinite(totalMillis)) return 'PT0S';
      const sign = totalMillis < 0 ? '-' : '';
      let remaining = Math.abs(Math.trunc(totalMillis));
      const millis = remaining % 1000;
      remaining = (remaining - millis) / 1000;
      const seconds = remaining % 60;
      remaining = (remaining - seconds) / 60;
      const minutes = remaining % 60;
      remaining = (remaining - minutes) / 60;
      const hours = remaining % 24;
      const days = (remaining - hours) / 24;

      let fraction = '';
      if (millis) {
        fraction = this.padNumber(millis, 3).replace(/0+$/, '');
      }

      const timeParts = [] as string[];
      if (hours) timeParts.push(`${hours}H`);
      if (minutes) timeParts.push(`${minutes}M`);
      if (seconds || fraction) {
        const secondPart = fraction ? `${seconds}.${fraction}` : String(seconds);
        timeParts.push(`${secondPart}S`);
      }

      if (!timeParts.length && !days) return `${sign}PT0S`;
      const dayPart = days ? `${days}D` : '';
      const timeSection = timeParts.length ? `T${timeParts.join('')}` : '';
      return `${sign}P${dayPart}${timeSection}`;
    }

    normalizeDecimalString(input: string): string | undefined {
      const trimmed = input.trim();
      if (!trimmed) return undefined;
      const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
      if (!numeric.test(trimmed)) return undefined;
      const sign = trimmed.startsWith('-') ? '-' : trimmed.startsWith('+') ? '' : '';
      const unsigned = trimmed.replace(/^[+-]/, '');
      if (!/e/i.test(unsigned)) {
        return this.normalizePlainDecimal(sign, unsigned);
      }
      return this.normalizeScientificDecimal(sign, unsigned);
    }

    normalizePlainDecimal(sign: string, unsigned: string): string {
      const parts = unsigned.split('.');
      const integerPart = parts[0]?.length ? parts[0] : '0';
      const fractionPart = parts[1] ?? '';
      return this.combineDecimalParts(sign, integerPart, fractionPart);
    }

    normalizeScientificDecimal(sign: string, unsigned: string): string | undefined {
      const exponentIndex = unsigned.toLowerCase().lastIndexOf('e');
      if (exponentIndex < 0) return undefined;
      const mantissa = unsigned.slice(0, exponentIndex);
      const exponentRaw = unsigned.slice(exponentIndex + 1);
      if (!mantissa) return undefined;
      const exponent = Number(exponentRaw);
      if (!Number.isFinite(exponent) || !Number.isInteger(exponent)) return undefined;
      const normalizedMantissa = mantissa.replace(/^[+-]/, '');
      const mantissaParts = normalizedMantissa.split('.');
      const whole = mantissaParts[0] ?? '';
      const decimals = mantissaParts[1] ?? '';
      const digits = `${whole}${decimals}`;
      if (!digits) return `${sign}0`;
      const decimalIndex = whole.length;
      const targetIndex = decimalIndex + exponent;
      let integer: string;
      let fraction: string;

      if (targetIndex <= 0) {
        integer = '0';
        const zeros = '0'.repeat(Math.abs(targetIndex));
        fraction = `${zeros}${digits}`;
      } else if (targetIndex >= digits.length) {
        const zeros = '0'.repeat(targetIndex - digits.length);
        integer = `${digits}${zeros}`;
        fraction = '';
      } else {
        integer = digits.slice(0, targetIndex);
        fraction = digits.slice(targetIndex);
      }

      return this.combineDecimalParts(sign, integer, fraction);
    }

    combineDecimalParts(sign: string, integer: string, fraction: string): string {
      const normalizedInteger = integer.replace(/^0+(?=\d)/, '') || '0';
      const normalizedFraction = fraction.replace(/0+$/, '');
      if (normalizedFraction) {
        return `${sign}${normalizedInteger}.${normalizedFraction}`;
      }
      return `${sign}${normalizedInteger}`;
    }

    toPlainString(value: number): string {
      if (!Number.isFinite(value)) return String(value);
      const str = value.toString();
      if (!/e/i.test(str)) return str;
      const [mantissa, exponentRaw] = str.toLowerCase().split('e');
      const exponent = Number(exponentRaw);
      if (!Number.isFinite(exponent)) return str;
      const sign = mantissa.startsWith('-') ? '-' : '';
      const normalizedMantissa = mantissa.replace(/^[+-]/, '');
      const decimalIndex = normalizedMantissa.indexOf('.');
      const digits = normalizedMantissa.replace('.', '');
      const initialIndex = decimalIndex === -1 ? digits.length : decimalIndex;
      const targetIndex = initialIndex + exponent;

      if (targetIndex <= 0) {
        return `${sign}0.${'0'.repeat(-targetIndex)}${digits}`.replace(/\.$/, '');
      }
      if (targetIndex >= digits.length) {
        return `${sign}${digits}${'0'.repeat(targetIndex - digits.length)}`;
      }
      const integerPart = digits.slice(0, targetIndex) || '0';
      const fractionalPart = digits.slice(targetIndex).replace(/0+$/, '');
      return fractionalPart ? `${sign}${integerPart}.${fractionalPart}` : `${sign}${integerPart}`;
    }

    isDeepInsertEnabled(flagFromDefinition: boolean): boolean {
      // Respect boot-time decision captured by caller; ignore runtime config
      // or mutations to definition to avoid toggle-at-runtime behavior.
      return Boolean(flagFromDefinition);
    }

    isDeepUpdateEnabled(flagFromDefinition: boolean): boolean {
      // Respect boot-time decision captured by caller; ignore runtime config
      // or mutations to definition to avoid toggle-at-runtime behavior.
      return Boolean(flagFromDefinition);
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
        throw new HttpErrors.BadRequest(
          `Deep insert exceeds maximum supported depth of ${maxDepth}.`,
        );
      }

      const relationType = relationMeta?.type ?? relationMeta?.relationType;
      if (relationType !== 'hasMany' && relationType !== 'hasOne') {
        throw new HttpErrors.BadRequest(
          `Deep insert is only supported for hasOne/hasMany relations. Relation ${relationName} uses type ${relationType ?? 'unknown'}.`,
        );
      }

      const targetCtor =
        typeof relationMeta.target === 'function'
          ? (relationMeta.target() as typeof Entity)
          : undefined;

      const createAndRecurse = async (payload: AnyObject) => {
        if (visited.has(payload)) {
          throw new HttpErrors.BadRequest('Circular references detected in deep insert payload.');
        }
        visited.add(payload);

        const { root, children } = this.normalizeDeepInsertPayload(payload, targetCtor);
        const createdChild = await relationRepository.create(root, options);

        if (children && Object.keys(children).length) {
          const childId = this.extractEntityId(createdChild);
          if (childId == null) {
            throw new HttpErrors.BadRequest(
              `Unable to determine identifier for nested entity on relation ${relationName}.`,
            );
          }
          const targetRepository =
            typeof relationRepository.getTargetRepository === 'function'
              ? await relationRepository.getTargetRepository()
              : undefined;
          const repoWithRelations = targetRepository ?? relationRepository;
          for (const [childRelationName, childValue] of Object.entries(children)) {
            if (childValue == null) continue;
            const childMeta = (targetCtor?.definition as ModelDefinition | undefined)?.relations?.[
              childRelationName
            ] as AnyObject | undefined;
            if (!childMeta) {
              if (this.cfg?.strict) {
                throw new HttpErrors.BadRequest(
                  `Unknown relation ${childRelationName} on ${targetCtor?.name ?? 'target'} for deep insert.`,
                );
              }
              continue;
            }
            const childFactory = repoWithRelations?.[childRelationName];
            if (typeof childFactory !== 'function') {
              throw new HttpErrors.BadRequest(
                `Repository for relation ${relationName} does not expose a factory for ${childRelationName}.`,
              );
            }
            const childRelationRepo = childFactory(childId);
            if (!childRelationRepo || typeof childRelationRepo.create !== 'function') {
              throw new HttpErrors.BadRequest(
                `Relation ${childRelationName} does not support create operations required for deep insert.`,
              );
            }
            if (childMeta.targetsMany) {
              const arrayValues = Array.isArray(childValue) ? childValue : [childValue];
              for (const arrEntry of arrayValues) {
                if (arrEntry == null) continue;
                await this.persistDeepInsertGraph(
                  childRelationName,
                  childMeta,
                  childRelationRepo,
                  arrEntry,
                  options,
                  visited,
                  depth + 1,
                );
              }
            } else {
              await this.persistDeepInsertGraph(
                childRelationName,
                childMeta,
                childRelationRepo,
                childValue,
                options,
                visited,
                depth + 1,
              );
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

    normalizeDeepInsertPayload(
      value: AnyObject,
      targetCtor?: typeof Entity,
    ): { root: AnyObject; children?: Record<string, unknown> } {
      const prepared: AnyObject = { ...value };
      const children: Record<string, unknown> = {};
      if (targetCtor) {
        const definition = (targetCtor as { definition?: ModelDefinition }).definition as
          | ModelDefinition
          | undefined;
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

    // CAP-style: no in-payload tombstones for deep updates.

    extractIdValues(
      source: AnyObject | undefined,
      idProps: string[],
    ): Record<string, unknown> | undefined {
      if (!source) return undefined;
      const values: Record<string, unknown> = {};
      for (const prop of idProps) {
        if (!Object.prototype.hasOwnProperty.call(source, prop)) {
          return undefined;
        }
        values[prop] = source[prop];
      }
      return values;
    }

    buildEntityIdKey(
      values: Record<string, unknown> | undefined,
      idProps: string[],
    ): string | undefined {
      if (!values || !idProps.length) return undefined;
      const parts = idProps.map((prop) => `${prop}:${JSON.stringify(values[prop])}`);
      return parts.join('|');
    }

    buildRelationWhere(
      values: Record<string, unknown> | undefined,
      idProps: string[],
    ): Where<AnyObject> | undefined {
      if (!values || !idProps.length) return undefined;
      const where: Where<AnyObject> = {};
      for (const prop of idProps) {
        where[prop] = values[prop];
      }
      return where;
    }

    removeIdProperties(data: AnyObject, idProps: string[]): void {
      for (const prop of idProps) {
        if (Object.prototype.hasOwnProperty.call(data, prop)) {
          delete data[prop];
        }
      }
    }

    buildFactoryIdArgument(
      values: Record<string, unknown> | undefined,
      idProps: string[],
    ): unknown {
      if (!values || !idProps.length) return undefined;
      if (idProps.length === 1) {
        return values[idProps[0]];
      }
      const composite: AnyObject = {};
      for (const prop of idProps) {
        composite[prop] = values[prop];
      }
      return composite;
    }

    coercePayloadToObject(value: unknown): AnyObject {
      if (typeof value !== 'object' || value == null) {
        throw new HttpErrors.BadRequest(
          'Deep update payloads for related entities must be objects.',
        );
      }
      return { ...(value as AnyObject) };
    }

    async applyDeepUpdateRelations(
      parentId: unknown,
      relations: Record<string, unknown> | undefined,
      parentRepository: AnyObject,
      parentCtor: typeof Entity,
      options: Options | undefined,
      depth: number,
    ): Promise<void> {
      if (!relations || !Object.keys(relations).length) return;
      const maxDepth = this.cfg?.maxDeepUpdateDepth ?? this.cfg?.maxDeepInsertDepth ?? 10;
      if (depth > maxDepth) {
        throw new HttpErrors.BadRequest(
          `Deep update exceeds maximum supported depth of ${maxDepth}.`,
        );
      }
      const parentDefinition = (parentCtor as { definition?: ModelDefinition }).definition as
        | ModelDefinition
        | undefined;
      const relationDefs = parentDefinition?.relations ?? {};
      for (const [relationName, relationValue] of Object.entries(relations)) {
        if (relationValue == null) continue;
        const relationMeta = relationDefs[relationName] as AnyObject | undefined;
        if (!relationMeta) {
          throw new HttpErrors.BadRequest(
            `Unknown relation ${relationName} on ${parentCtor.name ?? 'entity'} for deep update.`,
          );
        }
        if (relationMeta.through) {
          throw new HttpErrors.NotImplemented(
            `Deep update is not supported for relation ${relationName} (through/ many-to-many).`,
          );
        }
        const relationType = relationMeta?.type ?? relationMeta?.relationType;
        if (relationType !== 'hasMany' && relationType !== 'hasOne') {
          throw new HttpErrors.BadRequest(
            `Deep update is only supported for hasOne/hasMany relations. Relation ${relationName} uses type ${relationType ?? 'unknown'}.`,
          );
        }
        const factory = parentRepository[relationName];
        if (typeof factory !== 'function') {
          throw new HttpErrors.BadRequest(
            `Repository for ${parentCtor.name ?? 'entity'} does not expose a relation factory for ${relationName}.`,
          );
        }
        const relationRepo = factory(parentId, options);
        await this.persistDeepUpdateGraph(
          relationName,
          relationMeta,
          relationRepo,
          relationValue,
          options,
          depth,
        );
      }
    }

    async persistDeepUpdateGraph(
      relationName: string,
      relationMeta: AnyObject,
      relationRepository: AnyObject,
      value: unknown,
      options: Options | undefined,
      depth: number,
    ) {
      const maxDepth = this.cfg?.maxDeepUpdateDepth ?? this.cfg?.maxDeepInsertDepth ?? 10;
      if (depth > maxDepth) {
        throw new HttpErrors.BadRequest(
          `Deep update exceeds maximum supported depth of ${maxDepth}.`,
        );
      }

      const relationType = relationMeta?.type ?? relationMeta?.relationType;
      if (relationType === 'hasMany') {
        await this.persistHasManyDeepUpdate(
          relationName,
          relationMeta,
          relationRepository,
          value,
          options,
          depth,
        );
        return;
      }
      if (relationType === 'hasOne') {
        await this.persistHasOneDeepUpdate(
          relationName,
          relationMeta,
          relationRepository,
          value,
          options,
          depth,
        );
        return;
      }
      throw new HttpErrors.BadRequest(
        `Deep update is only supported for hasOne/hasMany relations. Relation ${relationName} uses type ${relationType ?? 'unknown'}.`,
      );
    }

    async persistHasManyDeepUpdate(
      relationName: string,
      relationMeta: AnyObject,
      relationRepository: AnyObject,
      value: unknown,
      options: Options | undefined,
      depth: number,
    ) {
      const targetCtor =
        typeof relationMeta.target === 'function'
          ? (relationMeta.target() as typeof Entity)
          : undefined;
      if (!targetCtor) {
        throw new HttpErrors.InternalServerError(
          `Unable to resolve target model for relation ${relationName}.`,
        );
      }
      const targetDefinition = (targetCtor as { definition?: ModelDefinition }).definition as
        | ModelDefinition
        | undefined;
      const idProps = getIdProperties(targetDefinition);
      if (!idProps.length) {
        throw new HttpErrors.BadRequest(
          `Unable to determine identifier for related entity ${targetCtor.name ?? relationName}.`,
        );
      }

      const targetRepository = await this.resolveTargetRepository(relationRepository, relationMeta);
      const existingEntities = await relationRepository.find(undefined, options);
      const existingMap = new Map<string, AnyObject>();
      for (const entity of existingEntities) {
        const plain = this.toPlainEntity(entity) ?? {};
        const idValues = this.extractIdValues(plain, idProps);
        const key = this.buildEntityIdKey(idValues, idProps);
        if (key) {
          existingMap.set(key, plain);
        }
      }

      const items = Array.isArray(value) ? value : [value];
      for (const rawEntry of items) {
        if (rawEntry == null) continue;
        const entry = this.coercePayloadToObject(rawEntry);
        const normalized = this.normalizeDeepInsertPayload(entry, targetCtor);
        const childRoot = { ...normalized.root };
        const idValues = this.extractIdValues(childRoot, idProps);
        const idKey = this.buildEntityIdKey(idValues, idProps);

        // Deletions must be executed explicitly via DELETE/$ref unlink.

        if (!idValues || !idKey) {
          const created = await relationRepository.create(childRoot, options);
          const createdPlain = this.toPlainEntity(created) ?? childRoot;
          const createdIdValues = this.extractIdValues(createdPlain, idProps);
          if (normalized.children && createdIdValues) {
            const childFactoryId = this.buildFactoryIdArgument(createdIdValues, idProps);
            await this.applyDeepUpdateRelations(
              childFactoryId,
              normalized.children as Record<string, unknown>,
              targetRepository,
              targetCtor,
              options,
              depth + 1,
            );
          }
          continue;
        }

        const updateData = { ...childRoot };
        this.removeIdProperties(updateData, idProps);
        if (Object.keys(updateData).length) {
          const where = this.buildRelationWhere(idValues, idProps);
          if (!where) {
            throw new HttpErrors.BadRequest(
              `Unable to update related ${relationName}: missing identifier.`,
            );
          }
          await relationRepository.patch(updateData, where, options);
        }

        if (normalized.children) {
          const where = this.buildRelationWhere(idValues, idProps);
          let currentChild = existingMap.get(idKey);
          if (where) {
            try {
              const refreshed = await targetRepository.findOne({ where }, options);
              currentChild = this.toPlainEntity(refreshed) ?? currentChild ?? childRoot;
            } catch {
              currentChild = currentChild ?? childRoot;
            }
          }
          const childIdValues = this.extractIdValues(currentChild, idProps);
          const childFactoryId = this.buildFactoryIdArgument(childIdValues, idProps);
          if (childFactoryId !== undefined) {
            await this.applyDeepUpdateRelations(
              childFactoryId,
              normalized.children as Record<string, unknown>,
              targetRepository,
              targetCtor,
              options,
              depth + 1,
            );
          }
        }
      }
    }

    async persistHasOneDeepUpdate(
      relationName: string,
      relationMeta: AnyObject,
      relationRepository: AnyObject,
      value: unknown,
      options: Options | undefined,
      depth: number,
    ) {
      const targetCtor =
        typeof relationMeta.target === 'function'
          ? (relationMeta.target() as typeof Entity)
          : undefined;
      if (!targetCtor) {
        throw new HttpErrors.InternalServerError(
          `Unable to resolve target model for relation ${relationName}.`,
        );
      }

      const targetDefinition = (targetCtor as { definition?: ModelDefinition }).definition as
        | ModelDefinition
        | undefined;
      const idProps = getIdProperties(targetDefinition);

      const entry = value == null ? undefined : this.coercePayloadToObject(value as AnyObject);
      if (!entry) return;

      const normalized = this.normalizeDeepInsertPayload(entry, targetCtor);
      const childRoot = { ...normalized.root };

      const targetRepository = await this.resolveTargetRepository(relationRepository, relationMeta);

      // Deletions must be executed explicitly via DELETE/$ref unlink.

      let existing: AnyObject | undefined;
      try {
        const current = await relationRepository.get(undefined, options);
        existing = this.toPlainEntity(current) ?? {};
      } catch (err) {
        if (!(err instanceof EntityNotFoundError)) {
          throw err;
        }
        existing = undefined;
      }

      if (!existing) {
        const created = await relationRepository.create(childRoot, options);
        const createdPlain = this.toPlainEntity(created) ?? childRoot;
        const createdIdValues = this.extractIdValues(createdPlain, idProps);
        if (normalized.children && createdIdValues) {
          const childFactoryId = this.buildFactoryIdArgument(createdIdValues, idProps);
          if (childFactoryId !== undefined) {
            await this.applyDeepUpdateRelations(
              childFactoryId,
              normalized.children as Record<string, unknown>,
              targetRepository,
              targetCtor,
              options,
              depth + 1,
            );
          }
        }
        return;
      }

      const updateData = { ...childRoot };
      if (idProps.length) {
        this.removeIdProperties(updateData, idProps);
      }
      if (Object.keys(updateData).length) {
        await relationRepository.patch(updateData, options);
      }

      let currentPlain = existing;
      try {
        const refreshed = await relationRepository.get(undefined, options);
        currentPlain = this.toPlainEntity(refreshed) ?? currentPlain;
      } catch {
        // ignore
      }

      if (normalized.children) {
        const childIdValues = this.extractIdValues(currentPlain, idProps);
        const childFactoryId = this.buildFactoryIdArgument(childIdValues, idProps);
        if (childFactoryId !== undefined) {
          await this.applyDeepUpdateRelations(
            childFactoryId,
            normalized.children as Record<string, unknown>,
            targetRepository,
            targetCtor,
            options,
            depth + 1,
          );
        }
      }
    }

    resolveNavigationRelationMetadata(relationName: string): AnyObject {
      const relationMeta = modelRelations?.[relationName] as AnyObject | undefined;
      if (!relationMeta) {
        throw new HttpErrors.BadRequest(`Unknown relation ${relationName}.`);
      }
      if (relationMeta.through) {
        throw new HttpErrors.NotImplemented(
          `$ref operations are not supported for relation ${relationName} (through/ many-to-many).`,
        );
      }
      if (!ensureNavigationTargetKey(relationMeta)) {
        throw new HttpErrors.NotImplemented(
          `Relation ${relationName} does not expose a foreign key (keyTo).`,
        );
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

      const { keyExpression } = this.parseODataIdReference(targetUri);
      const targetKeyLiteral = this.parseKeyLiteral(keyExpression);

      const repoWithRelations = this.repository as AnyObject;
      const factory = repoWithRelations[relationName];
      if (typeof factory !== 'function') {
        throw new HttpErrors.BadRequest(
          `Repository for ${setName} does not expose a relation factory for ${relationName}.`,
        );
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

      await this.enforceTenantLimit(op);
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
        this.stripODataAnnotations(plain);
        this.removeEntityIdProperties(plain, navRepo);
        plain[keyTo] = ctx.id ?? parentId;
        await navRepo.replaceById(navId as any, plain as AnyObject, this.repositoryOptions());
        return undefined;
      };

      const helpers = this.helpersForEntity(entityContext, op);
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
        throw new HttpErrors.BadRequest(
          `Repository for ${setName} does not expose a relation factory for ${relationName}.`,
        );
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
          throw new HttpErrors.BadRequest(
            'Target key is required to remove a reference from a collection.',
          );
        }
        const keyLiteral = this.parseKeyLiteral(targetKeyRaw);
        const targetId = this.coerceTargetId(targetRepo, keyLiteral);
        ctx.navigationTargetKey = keyLiteral;
        ctx.navigationTargetId = targetId;
      }

      await this.enforceTenantLimit(op);
      await this.runBefore(op, undefined, ctx);

      const execDefault = async () => {
        const navRepo = (ctx.navigationTargetRepository ?? targetRepo) as AnyObject;
        if (relationMeta.targetsMany) {
          const navId = ctx.navigationTargetId;
          if (navId == null) {
            throw new HttpErrors.BadRequest('Navigation target identifier is required.');
          }
          const existing = await navRepo.findById(
            navId as any,
            undefined,
            this.repositoryOptions(),
          );
          ctx.navigationTargetId = navId;
          ctx.navigationTargetEntity = existing;
          const plain = this.toPlainEntity(existing) ?? {};
          this.stripODataAnnotations(plain);
          this.removeEntityIdProperties(plain, navRepo);
          // Ensure the link actually exists (entity is linked to this parent); otherwise 404.
          if (plain[keyTo] == null || plain[keyTo] !== parentId) {
            throw new HttpErrors.NotFound('Navigation link does not exist.');
          }
          plain[keyTo] = null;
          await navRepo.replaceById(navId as any, plain as AnyObject, this.repositoryOptions());
          return;
        }

        const relationRepository = (ctx.navigationRelationRepository ?? relationRepo) as AnyObject;
        const existing = await relationRepository
          .get?.(undefined, this.repositoryOptions())
          .catch((err: unknown) => {
            // Surface 404 when hasOne target does not exist
            throw new HttpErrors.NotFound('Navigation link does not exist.');
          });
        if (!existing) throw new HttpErrors.NotFound('Navigation link does not exist.');
        ctx.navigationTargetEntity = existing;
        const navId = ctx.navigationTargetId ?? this.extractEntityId(existing);
        if (navId == null) throw new HttpErrors.NotFound('Navigation link does not exist.');
        ctx.navigationTargetId = navId;
        const plain = this.toPlainEntity(existing) ?? {};
        this.stripODataAnnotations(plain);
        this.removeEntityIdProperties(plain, navRepo);
        plain[keyTo] = null;
        await navRepo.replaceById(navId as any, plain as AnyObject, this.repositoryOptions());
      };

      const helpers = this.helpersForEntity(entityContext, op);
      const onCtx = this.buildOnContext(ctx, helpers);
      const res = await this.runOn(op, undefined, onCtx, execDefault);
      ctx.result = res;
      if (!this.response.headersSent) {
        await this.runAfter(op, undefined, ctx);
      }
      return ctx.result as AnyObject | undefined;
    }

    parseODataIdReference(reference: string): { entitySet: string; keyExpression: string } {
      const path = this.normalizeReferencePath(reference);
      const match = /\/([^/]+)\((.+)\)/.exec(path);
      if (!match) {
        throw new HttpErrors.BadRequest(`Invalid @odata.id value: ${reference}`);
      }
      const entitySet = this.stripNamespacePrefix(match[1]);
      return { entitySet, keyExpression: match[2] };
    }

    normalizeReferencePath(reference: string): string {
      const trimmed = (reference ?? '').trim();
      const normalizedBasePath = this.normalizeConfiguredBasePath(this.cfg?.basePath);
      const requestOrigin = this.getRequestOrigin();
      const serviceRoot =
        requestOrigin && normalizedBasePath && normalizedBasePath !== '/'
          ? `${requestOrigin}${normalizedBasePath}`
          : requestOrigin;
      const absolutePattern = /^[a-z][a-z0-9+.-]*:/i;
      const isAbsolute =
        Boolean(trimmed) && (absolutePattern.test(trimmed) || trimmed.startsWith('//'));
      let path = trimmed;

      if (isAbsolute) {
        const baseForParsing = serviceRoot ?? requestOrigin ?? 'http://localhost';
        let url: URL;
        try {
          url = new URL(trimmed, baseForParsing);
        } catch {
          throw new HttpErrors.BadRequest(`Invalid @odata.id value: ${reference}`);
        }
        if (!requestOrigin || url.origin !== requestOrigin) {
          throw new HttpErrors.BadRequest(`Invalid @odata.id value: ${reference}`);
        }
        if (!this.matchesServiceRootPrefix(url.pathname, normalizedBasePath)) {
          throw new HttpErrors.BadRequest(`Invalid @odata.id value: ${reference}`);
        }
        path = url.pathname || '';
      }

      if (!path.startsWith('/')) {
        path = `/${path}`;
      }
      path = path.split('?')[0]?.split('#')[0] ?? path;
      path = path.replace(/^\/+/g, '/');
      path = this.stripBasePath(path, normalizedBasePath);
      path = this.stripBasePath(path, '/odata');
      if (!path.startsWith('/')) {
        path = `/${path}`;
      }
      return path;
    }

    stripBasePath(path: string, basePath: string): string {
      if (!basePath || basePath === '/') return path;
      const normalizedPath = path.toLowerCase();
      const normalizedBase = basePath.toLowerCase();
      if (normalizedPath === normalizedBase) return '/';
      if (normalizedPath.startsWith(`${normalizedBase}/`)) {
        return path.slice(basePath.length);
      }
      return path;
    }

    normalizeConfiguredBasePath(configured?: string): string {
      let basePath = configured?.trim();
      if (!basePath) return '/odata';
      if (!basePath.startsWith('/')) basePath = `/${basePath}`;
      if (basePath.length > 1 && basePath.endsWith('/')) {
        basePath = basePath.slice(0, -1);
      }
      return basePath || '/';
    }

    stripNamespacePrefix(entitySet: string): string {
      const prefixes = [this.cfg?.namespace, this.cfg?.namespaceAlias]
        .filter((value): value is string => Boolean(value))
        .map((value) => `${value}.`);
      for (const prefix of prefixes) {
        if (entitySet.startsWith(prefix)) {
          return entitySet.slice(prefix.length);
        }
      }
      return entitySet;
    }

    matchesServiceRootPrefix(path: string, basePath: string): boolean {
      if (!path || !path.startsWith('/')) return false;
      if (!basePath || basePath === '/') return true;
      const normalizedPath = path.toLowerCase();
      const normalizedBase = basePath.toLowerCase();
      if (normalizedPath === normalizedBase) return true;
      return normalizedPath.startsWith(`${normalizedBase}/`);
    }

    getRequestOrigin(): string | undefined {
      const host = this.getEffectiveHost();
      if (!host) return undefined;
      const protocol = this.getEffectiveProtocol() ?? 'http';
      return `${protocol}://${host}`;
    }

    getEffectiveProtocol(): string | undefined {
      const trustProxy = this.shouldTrustProxyHeaders();
      if (trustProxy) {
        const forwarded = this.parseForwardedHeader();
        const forwardedProto = this.normalizeProtocol(forwarded?.proto);
        if (forwardedProto) return forwardedProto;
        const headerProto = this.normalizeProtocol(
          this.getCommaSeparatedHeaderValue(this.getRequestHeader('x-forwarded-proto')),
        );
        if (headerProto) return headerProto;
      }
      const rawProtocol =
        typeof this.request.protocol === 'string' ? this.request.protocol.trim() : undefined;
      const normalized = this.normalizeProtocol(rawProtocol);
      if (normalized) {
        return normalized;
      }
      const secure = (this.request as AnyObject)?.secure;
      if (secure === true) {
        return 'https';
      }
      return undefined;
    }

    getEffectiveHost(): string | undefined {
      const trustProxy = this.shouldTrustProxyHeaders();
      if (trustProxy) {
        const forwarded = this.parseForwardedHeader();
        const forwardedHost = this.normalizeHost(forwarded?.host);
        if (forwardedHost) return forwardedHost;
        const headerHost = this.normalizeHost(
          this.getCommaSeparatedHeaderValue(this.getRequestHeader('x-forwarded-host')),
        );
        if (headerHost) return headerHost;
      }
      const hostHeader = this.normalizeHost(this.getRequestHeader('host'));
      if (hostHeader) return hostHeader;
      const authority = this.normalizeHost(this.getRequestHeader(':authority'));
      if (authority) return authority;
      return undefined;
    }

    parseForwardedHeader(): { host?: string; proto?: string } | undefined {
      const header = this.getRequestHeader('forwarded');
      if (!header) return undefined;
      const firstEntry = header.split(',')[0];
      if (!firstEntry) return undefined;
      const directives = firstEntry.split(';');
      const result: { host?: string; proto?: string } = {};
      for (const directive of directives) {
        const [rawKey, rawValue] = directive.split('=');
        if (!rawKey || !rawValue) continue;
        const key = rawKey.trim().toLowerCase();
        if (!key) continue;
        const value = rawValue.trim().replace(/^\"(.*)\"$/, '$1');
        if (key === 'host' && !result.host) {
          result.host = value;
        } else if (key === 'proto' && !result.proto) {
          result.proto = value;
        }
      }
      if (!result.host && !result.proto) {
        return undefined;
      }
      return result;
    }

    getCommaSeparatedHeaderValue(value: string | undefined): string | undefined {
      if (!value) return undefined;
      const first = value.split(',')[0]?.trim();
      if (!first) return undefined;
      return first;
    }

    getRequestHeader(name: string): string | undefined {
      if (!name) return undefined;
      const getter =
        typeof this.request.get === 'function'
          ? this.request.get.bind(this.request)
          : typeof (this.request as AnyObject).header === 'function'
            ? (this.request as AnyObject).header.bind(this.request)
            : undefined;
      if (getter) {
        const value = getter(name);
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed) return trimmed;
        } else if (value != null) {
          const cast = String(value).trim();
          if (cast) return cast;
        }
      }
      const headers = (this.request.headers ?? {}) as AnyObject;
      const normalized = name.toLowerCase();
      const direct = headers[normalized] ?? headers[name];
      if (Array.isArray(direct)) {
        for (const candidate of direct) {
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
        return undefined;
      }
      if (direct == null) return undefined;
      const raw = typeof direct === 'string' ? direct : String(direct);
      const trimmed = raw.trim();
      return trimmed || undefined;
    }

    shouldTrustProxyHeaders(): boolean {
      const configured = this.cfg?.trustProxyHeaders;
      if (configured === true) return true;
      if (configured === false) return false;
      if (!this.getTrustedProxyRanges().length) return false;
      return this.isTrustedRemoteAddress(this.getRemoteAddress());
    }

    getTrustedProxyRanges(): Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> {
      if (this._trustedProxyRanges) return this._trustedProxyRanges;
      const configured = Array.isArray(this.cfg?.trustedProxySubnets)
        ? (this.cfg?.trustedProxySubnets ?? [])
        : [];
      const parsed: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [];
      for (const entry of configured) {
        const raw = entry?.trim();
        if (!raw) continue;
        try {
          const cidr = raw.includes('/') ? raw : raw.includes(':') ? `${raw}/128` : `${raw}/32`;
          const [addr, prefix] = ipaddr.parseCIDR(cidr);
          parsed.push([this.normalizeIpAddress(addr), prefix]);
        } catch {
          this.logger?.warn('Ignoring invalid trustedProxySubnets entry.', {
            event: 'invalid-trusted-proxy-subnet',
            subnet: raw,
          });
        }
      }
      this._trustedProxyRanges = parsed;
      return parsed;
    }

    getRemoteAddress(): string | undefined {
      const reqAny = this.request as AnyObject;
      const socket =
        reqAny?.socket ??
        reqAny?.connection ??
        (reqAny?.res && typeof reqAny.res === 'object'
          ? (reqAny.res as AnyObject).connection
          : undefined);
      const remote = socket?.remoteAddress;
      if (typeof remote === 'string' && remote.trim()) {
        return remote.trim();
      }
      return undefined;
    }

    isTrustedRemoteAddress(address: string | undefined): boolean {
      if (!address) return false;
      const ranges = this.getTrustedProxyRanges();
      if (!ranges.length) return false;
      try {
        const parsed = this.normalizeIpAddress(ipaddr.parse(address));
        return ranges.some((range) => this.matchIpAddress(parsed, range));
      } catch {
        return false;
      }
    }

    normalizeIpAddress(addr: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
      if (addr.kind() === 'ipv6') {
        const ipv6 = addr as ipaddr.IPv6;
        if (ipv6.isIPv4MappedAddress()) {
          return ipv6.toIPv4Address();
        }
      }
      return addr;
    }

    matchIpAddress(
      candidate: ipaddr.IPv4 | ipaddr.IPv6,
      range: [ipaddr.IPv4 | ipaddr.IPv6, number],
    ): boolean {
      const [rangeAddr, prefix] = range;
      if (candidate.kind() === 'ipv4' && rangeAddr.kind() === 'ipv4') {
        return (candidate as ipaddr.IPv4).match([rangeAddr as ipaddr.IPv4, prefix]);
      }
      if (candidate.kind() === 'ipv6' && rangeAddr.kind() === 'ipv6') {
        return (candidate as ipaddr.IPv6).match([rangeAddr as ipaddr.IPv6, prefix]);
      }
      return false;
    }

    normalizeProtocol(value: string | undefined): string | undefined {
      if (!value) return undefined;
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const normalized = trimmed.replace(/:$/, '').toLowerCase();
      if (normalized === 'http' || normalized === 'https') return normalized;
      return undefined;
    }

    normalizeHost(value: string | undefined): string | undefined {
      if (!value) return undefined;
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      if (/\s/.test(trimmed)) return undefined;
      for (let i = 0; i < trimmed.length; i++) {
        const code = trimmed.charCodeAt(i);
        if (code <= 31 || code === 127) return undefined;
      }
      if (/[\/\\]/.test(trimmed)) return undefined;
      if (trimmed.startsWith('[')) {
        const closingBracket = trimmed.indexOf(']');
        if (closingBracket >= 0) {
          const address = trimmed.slice(0, closingBracket + 1).toLowerCase();
          const remainder = trimmed.slice(closingBracket + 1);
          return `${address}${remainder}`;
        }
        return trimmed.toLowerCase();
      }
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex >= 0) {
        const host = trimmed.slice(0, colonIndex).toLowerCase();
        const port = trimmed.slice(colonIndex);
        return `${host}${port}`;
      }
      return trimmed.toLowerCase();
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
          throw new HttpErrors.InternalServerError(
            'Unable to resolve target repository for hasOne relation.',
          );
        }
        const getter = dict[keys[0]];
        return getter();
      }
      throw new HttpErrors.NotImplemented(
        `Unable to resolve target repository for relation ${relationMeta?.name ?? '[unknown]'}.`,
      );
    }

    coerceTargetId(targetRepo: CrudRepo | AnyObject, literal: string): unknown {
      const entityClass = (targetRepo as AnyObject).entityClass as typeof Entity | undefined;
      const idProps = entityClass?.getIdProperties?.() ?? [];
      const idName = idProps[0] ?? 'id';
      const idDef = (entityClass as AnyObject)?.definition?.properties?.[idName] as
        | PropertyDefinition
        | undefined;
      return this.coerceIdentifierLiteral(literal, idDef, 'identifier');
    }

    coerceParentId(raw: unknown): unknown {
      if (typeof raw !== 'string') return raw;
      const idName = idProperties[0];
      const idDef = modelDefinition?.properties?.[idName] as PropertyDefinition | undefined;
      return this.coerceIdentifierLiteral(raw, idDef, 'identifier');
    }

    extractEntityId(entity: CrudEntity | AnyObject | undefined): unknown {
      if (!entity) return undefined;
      const repoAny = this.repository as CrudRepo & { entityClass?: typeof Entity };
      try {
        const idFromRepo = repoAny.entityClass?.getIdOf?.(entity as AnyObject);
        if (idFromRepo != null) return idFromRepo;
      } catch {
        /* noop */
      }
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

    setEntityLocationHeaders(entityUrl: string) {
      if (!entityUrl || this.response.headersSent) return;
      this.response.set('Location', entityUrl);
      this.response.set('OData-EntityId', entityUrl);
    }

    buildEntityLocationUrl(id: unknown, entity?: AnyObject): string | undefined {
      const keyLiteral = this.buildEntityKeyLiteral(id, entity);
      if (!keyLiteral) return undefined;
      const basePath = normalizeBasePath(this.cfg?.basePath);
      const prefix = basePath === '/' ? '' : basePath;
      const relativePath = `${prefix}/${setName}${keyLiteral}`;
      const host = this.getEffectiveHost();
      const protocol = this.getEffectiveProtocol();
      if (host) {
        const scheme = protocol ?? 'http';
        return `${scheme}://${host}${relativePath}`;
      }
      return relativePath;
    }

    buildEntityKeyLiteral(id: unknown, entity?: AnyObject): string | undefined {
      if (!idProperties.length) return undefined;
      if (idProperties.length === 1) {
        const property = idProperties[0];
        const literal = this.serializeKeyLiteralValue(
          id ?? (entity as AnyObject | undefined)?.[property],
          property,
        );
        if (!literal) return undefined;
        return `(${literal})`;
      }
      const source =
        (typeof id === 'object' && id !== null ? (id as AnyObject) : undefined) ?? entity;
      if (!source) return undefined;
      const segments: string[] = [];
      for (const property of idProperties) {
        const literal = this.serializeKeyLiteralValue((source as AnyObject)[property], property);
        if (!literal) return undefined;
        segments.push(`${property}=${literal}`);
      }
      return `(${segments.join(',')})`;
    }

    serializeKeyLiteralValue(value: unknown, propertyName: string): string | undefined {
      if (value === undefined || value === null) return undefined;
      const definition = (modelDefinition?.properties ?? {})[propertyName] as
        | PropertyDefinition
        | undefined;
      const plan = this.classifyProperty(definition);
      if (plan?.kind === 'datetimeoffset') {
        const normalized = this.normalizeDateTimeOffsetValue(value);
        const literal =
          typeof normalized === 'string'
            ? normalized
            : normalized instanceof Date
              ? normalized.toISOString()
              : undefined;
        return literal ? `datetimeoffset'${literal}'` : undefined;
      }
      if (plan?.kind === 'date') {
        const normalized = this.normalizeDateValue(value);
        const literal =
          typeof normalized === 'string'
            ? normalized
            : normalized instanceof Date
              ? normalized.toISOString().slice(0, 10)
              : undefined;
        return literal ? `date'${literal}'` : undefined;
      }
      if (plan?.kind === 'timeOfDay') {
        const normalized = this.normalizeTimeOfDayValue(value);
        return typeof normalized === 'string' ? `timeofday'${normalized}'` : undefined;
      }
      if (plan?.kind === 'duration') {
        const normalized = this.normalizeDurationValue(value);
        return typeof normalized === 'string' ? `duration'${normalized}'` : undefined;
      }
      if (plan?.kind === 'int64') {
        const normalized = this.normalizeInt64Value(value);
        return normalized?.value ? String(normalized.value) : undefined;
      }
      if (plan?.kind === 'decimal') {
        const normalized = this.normalizeDecimalValue(value);
        return normalized?.value ? String(normalized.value) : undefined;
      }

      if (this.isGuidProperty(definition)) {
        const literal = this.normalizeGuidLiteralValue(value);
        return literal ? `guid'${literal}'` : undefined;
      }

      const primitive = classifyPrimitiveProperty(definition);
      if (primitive === 'boolean') {
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (typeof value === 'string') {
          const normalized = value.trim().toLowerCase();
          if (normalized === 'true' || normalized === 'false') return normalized;
        }
        return undefined;
      }
      if (primitive === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (!trimmed) return undefined;
          return trimmed;
        }
        return undefined;
      }

      const stringValue = String(value);
      return `'${this.escapeODataString(stringValue)}'`;
    }

    normalizeGuidLiteralValue(value: unknown): string | undefined {
      if (value === undefined || value === null) return undefined;
      let literal = String(value).trim();
      if (!literal) return undefined;
      const prefix = /^guid'/i;
      if (prefix.test(literal)) {
        literal = literal.replace(prefix, '');
        if (literal.endsWith("'")) {
          literal = literal.slice(0, -1);
        }
      }
      if (literal.startsWith('{') && literal.endsWith('}')) {
        literal = literal.slice(1, -1);
      }
      return literal ? literal.toLowerCase() : undefined;
    }

    isGuidProperty(definition: PropertyDefinition | undefined): boolean {
      if (!definition) return false;
      const rawType = (definition as AnyObject)?.type;
      if (typeof rawType === 'string') {
        const normalized = rawType.toLowerCase();
        if (normalized === 'guid' || normalized === 'uuid') return true;
      }
      if (typeof rawType === 'function') {
        const typeName = rawType.name.toLowerCase();
        if (typeName === 'guid' || typeName === 'uuid') return true;
      }
      const schema = (definition as AnyObject)?.jsonSchema as AnyObject | undefined;
      const format = typeof schema?.format === 'string' ? schema.format.toLowerCase() : undefined;
      const dataType =
        typeof schema?.dataType === 'string' ? schema.dataType.toLowerCase() : undefined;
      const odataType =
        typeof schema?.['x-odata-type'] === 'string'
          ? (schema['x-odata-type'] as string).toLowerCase()
          : undefined;
      if (format === 'uuid' || format === 'guid') return true;
      if (dataType === 'guid') return true;
      if (odataType === 'edm.guid') return true;
      return false;
    }

    escapeODataString(value: string): string {
      return value.replace(/'/g, "''");
    }

    async findEntityForDeleteRepresentation(
      id: unknown,
      where: Filter<CrudEntity>['where'] | undefined,
      options?: Options,
    ): Promise<AnyObject | undefined> {
      const entityId = this.coerceParentId(id);
      if (where) {
        const existing = await this.repository.findOne({ where } as Filter<CrudEntity>, options);
        return this.toPlainEntity(existing ?? undefined);
      }
      const entity = await this.repository.findById(entityId as any, undefined, options);
      return this.toPlainEntity(entity);
    }

    executeAggregation(rows: AnyObject[], stage: ApplyAggregationStage): AnyObject[] {
      const spec = stage.spec;
      const navigationGroups = this.groupNavigationPaths(stage.navigationPaths ?? []);
      const groupMap = new Map<
        string,
        {
          groupValues: Record<string, unknown>;
          aggregates: Record<string, AggregationAccumulatorState>;
        }
      >();

      for (const row of rows) {
        const variants = this.expandNavigationVariants(row, navigationGroups);
        const variantList = variants.length ? variants : [{ values: {} }];

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
            entry = { groupValues, aggregates };
            groupMap.set(key, entry);
          }

          for (const aggregate of spec.aggregates) {
            const value = this.evaluateAggregateOperand(aggregate, row, variant);
            this.updateAccumulatorState(entry.aggregates[aggregate.alias], value);
          }
        }
      }

      const results: AnyObject[] = [];
      for (const { groupValues, aggregates } of groupMap.values()) {
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

    evaluateAggregateOperand(
      aggregate: AggregationExpression,
      row: AnyObject,
      variant: { values: Record<string, unknown> },
    ): unknown {
      if (aggregate.expression) {
        return this.evaluateComputeNode(aggregate.expression, row, variant);
      }
      if (aggregate.field) {
        return this.resolveVariantValue(row, variant, aggregate.field);
      }
      return undefined;
    }

    groupNavigationPaths(paths: ResolvedNavigationPath[]): Map<string, ResolvedNavigationPath[]> {
      const groups = new Map<string, ResolvedNavigationPath[]>();
      for (const path of paths) {
        if (!path.joins.length) continue;
        const key = path.joins.map((j) => j.relationName).join('/');
        const existing = groups.get(key);
        if (existing) {
          existing.push(path);
        } else {
          groups.set(key, [path]);
        }
      }
      return groups;
    }

    expandNavigationVariants(
      row: AnyObject,
      groups: Map<string, ResolvedNavigationPath[]>,
    ): Array<{ values: Record<string, unknown> }> {
      const maxFanout = this.cfg?.maxApplyNavigationFanout ?? 1000;
      let variants: Array<{ values: Record<string, unknown> }> = [{ values: {} }];

      for (const paths of groups.values()) {
        const primaryPath = paths[0];
        const targets = this.collectNavigationTargets(row, primaryPath);
        const safeTargets = targets.length ? targets : [undefined];
        const next: Array<{ values: Record<string, unknown> }> = [];

        for (const variant of variants) {
          for (const target of safeTargets) {
            const values = { ...variant.values };
            for (const path of paths) {
              values[path.originalPath] = this.resolvePropertyFromTarget(
                target as AnyObject | undefined,
                path.propertyPath,
              );
            }
            next.push({ values });
            if (next.length > maxFanout) {
              throw new HttpErrors.BadRequest(
                `$apply navigation expansion exceeds the configured limit of ${maxFanout} combinations.`,
              );
            }
          }
        }

        variants = next;
      }

      if (variants.length > maxFanout) {
        throw new HttpErrors.BadRequest(
          `$apply navigation expansion exceeds the configured limit of ${maxFanout} combinations.`,
        );
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

    resolveVariantValue(
      row: AnyObject,
      variant: { values: Record<string, unknown> },
      path: string,
    ): unknown {
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
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((part) => {
          const [field, direction] = part.split(/\s+/);
          return {
            field,
            direction: direction?.toUpperCase() === 'DESC' ? -1 : 1,
          };
        })
        .filter((item) => item.field);
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
      return data.filter((entity) => this.evaluatePredicate(expr, entity, '', entity));
    }

    applyPostFilters(data: AnyObject[], expressions: ParsedExpression[]): AnyObject[] {
      if (!expressions.length) return data;
      let result = data;
      for (const expr of expressions) {
        result = this.applyPostFilter(result, expr);
      }
      return result;
    }

    applyPostFiltersPreservingFields(
      data: AnyObject[],
      expressions: ParsedExpression[],
    ): AnyObject[] {
      if (!expressions.length) return data;

      // For concat operations, we only filter entities that have the relevant field,
      // but preserve entities that don't have the field
      let result = data;
      for (const expr of expressions) {
        if ('field' in expr && typeof expr.field === 'string') {
          const fieldName = expr.field.split('/')[0];
          // Only apply filter to entities that have the field, keep those that don't
          result = result.filter((entity) => {
            if (entity.hasOwnProperty(fieldName)) {
              // If entity has the field, evaluate the predicate normally
              return this.evaluatePredicate(expr, entity, '', entity);
            } else {
              // If entity doesn't have the field, preserve it in results
              return true;
            }
          });
        } else {
          // For other filter types, apply normal filtering
          result = this.applyPostFilter(result, expr);
        }
      }
      return result;
    }

    collectAggregationRelations(plan: ApplyExecutionPlan | undefined): string[] {
      const relations = new Set<string>();
      const addRelation = (name?: string) => {
        if (!name) return;
        if (!(modelRelations as Record<string, unknown>)[name]) return;
        relations.add(name);
      };
      const traverse = (current?: ApplyExecutionPlan) => {
        if (!current) return;
        for (const stage of current.stages) {
          stage.navigationPaths.forEach((path) => {
            const firstJoin = path.joins[0];
            if (firstJoin) addRelation(firstJoin.relationName);
          });
          stage.spec.groupBy.forEach((field) => {
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
            if (aggregate.expression) {
              this.collectRelationsFromComputeNode(aggregate.expression, addRelation);
            }
          }
        }
        current.concat?.forEach((branch) => traverse(branch));
      };
      traverse(plan);
      return Array.from(relations);
    }

    collectRelationsFromComputeNode(node: ComputeNode, addRelation: (name?: string) => void) {
      switch (node.type) {
        case 'path': {
          if (node.path.length > 1) {
            addRelation(node.path[0]);
          }
          break;
        }
        case 'binary':
          this.collectRelationsFromComputeNode(node.left, addRelation);
          this.collectRelationsFromComputeNode(node.right, addRelation);
          break;
        case 'function':
          for (const arg of node.args) {
            this.collectRelationsFromComputeNode(arg, addRelation);
          }
          break;
        case 'literal':
        default:
          break;
      }
    }

    planHasConcat(plan: ApplyExecutionPlan | undefined): boolean {
      if (!plan) return false;
      if (plan.concat?.length) return true;
      return plan.concat?.some((branch) => this.planHasConcat(branch)) ?? false;
    }

    planHasComputedAggregates(plan: ApplyExecutionPlan | undefined): boolean {
      if (!plan) return false;
      if (
        plan.stages.some((stage) =>
          stage.spec.aggregates.some((aggregate) => Boolean(aggregate.expression)),
        )
      ) {
        return true;
      }
      return plan.concat?.some((branch) => this.planHasComputedAggregates(branch)) ?? false;
    }

    planHasInternalOrder(plan: ApplyExecutionPlan | undefined): boolean {
      if (!plan) return false;
      if (plan.postOrderBy?.length) return true;
      if (plan.stages.some((stage) => (stage.orderBy?.length ?? 0) > 0)) return true;
      return plan.concat?.some((branch) => this.planHasInternalOrder(branch)) ?? false;
    }

    planRequiresPostProcessing(plan: ApplyExecutionPlan | undefined): boolean {
      if (!plan) return false;
      if (plan.preAggregationFilters.length > 0) return true;
      if (plan.stages.length > 1) return true;
      if (
        plan.stages.some(
          (stage) =>
            stage.postAggregationFilters.length > 0 ||
            stage.skip !== undefined ||
            stage.top !== undefined ||
            (stage.orderBy?.length ?? 0) > 0,
        )
      ) {
        return true;
      }
      if (
        (plan.postOrderBy?.length ?? 0) > 0 ||
        plan.postTop !== undefined ||
        plan.postSkip !== undefined
      ) {
        return true;
      }
      if (plan.postFilters?.length) {
        return true;
      }
      if (plan.concat?.length) {
        return true;
      }
      return plan.concat?.some((branch) => this.planRequiresPostProcessing(branch)) ?? false;
    }

    countApplyPlanStages(plan: ApplyExecutionPlan | undefined): number {
      if (!plan) return 0;
      const current = plan.stages.length;
      const branchTotal =
        plan.concat?.reduce((sum, branch) => sum + this.countApplyPlanStages(branch), 0) ?? 0;
      return current + branchTotal;
    }

    findFirstPlanStage(plan: ApplyExecutionPlan | undefined): ApplyAggregationStage | undefined {
      if (!plan) return undefined;
      if (plan.stages.length) return plan.stages[0];
      if (plan.concat) {
        for (const branch of plan.concat) {
          const found = this.findFirstPlanStage(branch);
          if (found) return found;
        }
      }
      return undefined;
    }

    findFinalPlanStage(plan: ApplyExecutionPlan | undefined): ApplyAggregationStage | undefined {
      if (!plan) return undefined;
      if (plan.stages.length) {
        return plan.stages[plan.stages.length - 1];
      }
      if (plan.concat) {
        for (const branch of plan.concat) {
          const found = this.findFinalPlanStage(branch);
          if (found) return found;
        }
      }
      return undefined;
    }

    runApplyPlanFallback(
      plan: ApplyExecutionPlan,
      input: AnyObject[],
      options?: ApplyFallbackOptions,
    ): { rows: AnyObject[]; lastStageOrdered: boolean; branchSegments?: AnyObject[][] } {
      const stageCount = Math.max(this.countApplyPlanStages(plan), 1);
      const cursor = { value: 0 };
      return this.executeApplyPlanBranch(plan, input, stageCount, cursor, options);
    }

    executeApplyPlanBranch(
      plan: ApplyExecutionPlan,
      input: AnyObject[],
      stageCount: number,
      cursor: { value: number },
      options?: ApplyFallbackOptions,
    ): { rows: AnyObject[]; lastStageOrdered: boolean; branchSegments?: AnyObject[][] } {
      let working = input;
      if (plan.preAggregationFilters.length) {
        working = this.applyPostFilters(working, plan.preAggregationFilters);
      }
      this.ensureApplyFallbackLimit(working.length, options?.maxRows);

      let lastStageOrdered = false;
      let branchSegments: AnyObject[][] | undefined;

      for (const stage of plan.stages) {
        working = this.executeAggregation(working, stage);
        if (stage.postAggregationFilters.length) {
          working = this.applyPostFilters(working, stage.postAggregationFilters);
        }
        this.ensureApplyFallbackLimit(working.length, options?.maxRows);
        if (stage.orderBy?.length) {
          const clauses = stage.orderBy.map(
            (item) => `${item.field} ${item.direction.toUpperCase()}`,
          );
          working = this.orderResults(working, clauses);
          lastStageOrdered = true;
        } else {
          lastStageOrdered = false;
        }
        if (stage.skip !== undefined || stage.top !== undefined) {
          working = this.sliceResults(working, stage.skip, stage.top);
        }
        this.ensureApplyFallbackLimit(working.length, options?.maxRows);
        this.emitApplyTelemetry('fallback', cursor.value, stageCount, {
          rows: working.length,
          joinCount: stage.navigationPaths?.length,
        });
        cursor.value += 1;
      }

      if (plan.concat?.length) {
        const branchResults: AnyObject[] = [];
        const segments: AnyObject[][] = [];
        for (const branch of plan.concat) {
          const branchOutcome = this.executeApplyPlanBranch(
            branch,
            working,
            stageCount,
            cursor,
            options,
          );
          branchResults.push(...branchOutcome.rows);
          this.ensureApplyFallbackLimit(branchResults.length, options?.maxRows);
          if (branchOutcome.branchSegments?.length) {
            segments.push(...branchOutcome.branchSegments);
          } else {
            segments.push(branchOutcome.rows);
          }
        }
        working = branchResults;
        lastStageOrdered = false;
        branchSegments = segments;
      }

      if (plan.postFilters?.length) {
        const filters = plan.postFilters;
        if (branchSegments?.length) {
          branchSegments = branchSegments.map((segment) =>
            this.applyPostFiltersPreservingFields(segment, filters),
          );
          working = branchSegments.flat();
        } else {
          working = this.applyPostFilters(working, filters);
        }
      }
      this.ensureApplyFallbackLimit(working.length, options?.maxRows);

      if (plan.postOrderBy?.length) {
        const clauses = plan.postOrderBy.map(
          (item) => `${item.field} ${item.direction.toUpperCase()}`,
        );
        if (branchSegments?.length) {
          branchSegments = branchSegments.map((segment) => this.orderResults(segment, clauses));
          working = branchSegments.flat();
        } else {
          working = this.orderResults(working, clauses);
        }
        lastStageOrdered = true;
      }
      this.ensureApplyFallbackLimit(working.length, options?.maxRows);

      if (plan.postSkip !== undefined || plan.postTop !== undefined) {
        working = this.sliceResults(working, plan.postSkip, plan.postTop);
        branchSegments = undefined;
      }
      this.ensureApplyFallbackLimit(working.length, options?.maxRows);

      return { rows: working, lastStageOrdered, branchSegments };
    }

    ensureApplyFallbackLimit(count: number, limit?: number) {
      if (typeof limit !== 'number' || limit <= 0) return;
      if (count > limit) {
        throw new ApplyResultLimitExceededError(limit, count);
      }
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

    coerceLimit(value: unknown): number | undefined {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) {
        return Math.floor(num);
      }
      return undefined;
    }

    getPaginationLimits(): {
      maxTop?: number;
      maxSkip?: number;
      maxPageSize?: number;
      maxApplyPageSize?: number;
    } {
      const global = this.cfg?.pagination ?? {};
      const entityLimits = def.pagination ?? {};
      const maxPageSize =
        this.coerceLimit(entityLimits.maxPageSize) ?? this.coerceLimit(global.maxPageSize);
      const maxApplyPageSize =
        this.coerceLimit(entityLimits.maxApplyPageSize) ??
        this.coerceLimit(global.maxApplyPageSize) ??
        maxPageSize;
      return {
        maxTop:
          this.coerceLimit(entityLimits.maxTop) ??
          this.coerceLimit(global.maxTop) ??
          this.coerceLimit(this.cfg?.maxTop),
        maxSkip:
          this.coerceLimit(entityLimits.maxSkip) ??
          this.coerceLimit(global.maxSkip) ??
          this.coerceLimit(this.cfg?.maxSkip),
        maxPageSize,
        maxApplyPageSize,
      };
    }

    logPaginationClamp(parameter: string, requested: number, limit: number, context?: string) {
      this.logger.warn('Pagination parameter clamped to maximum.', {
        entitySet: setName,
        parameter,
        requested,
        limit,
        ...(context ? { context } : {}),
      });
    }

    logApplyFallback(
      event: string,
      detail: { entitySet: string; transformations?: number; rows?: number; limit?: number },
      plan?: ApplyExecutionPlan,
    ) {
      const payload = { event, ...detail };
      this.cfg?.onApplyFallback?.(payload);
      if (this.cfg?.logApplyFallbacks) {
        this.logger.warn('$apply fallback', detail);
      }
      if (typeof detail.rows === 'number') {
        this.recordTelemetryStats({ rows: detail.rows });
      }
      const includePlan = plan && this.includeApplyPlanInTelemetry() ? { plan } : {};
      this.emitTelemetry({
        category: 'apply',
        event: 'apply-fallback',
        level: 'warn',
        context: {
          reason: event,
          ...detail,
          ...includePlan,
        },
      });
    }

    throwDeltaValidationError(
      result: Exclude<DeltaTokenValidationResult, { ok: true; payload?: DeltaTokenPayload }>,
    ): never {
      if (result.code === 'expired') {
        throw new HttpErrors.Gone(result.message);
      }
      throw new HttpErrors.BadRequest(result.message);
    }

    emitApplyTelemetry(
      mode: 'pushdown' | 'fallback',
      stageIndex: number,
      stageCount: number,
      data: { rows?: number; durationMs?: number; joinCount?: number; reason?: string } = {},
    ) {
      const shouldNotifyHandler = Boolean(this.cfg?.onApplyTelemetry);
      const shouldLogApply = Boolean(this.cfg?.logApplyTelemetry);
      if (shouldNotifyHandler || shouldLogApply) {
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
        if (shouldNotifyHandler && this.cfg?.onApplyTelemetry) {
          try {
            this.cfg.onApplyTelemetry(event);
          } catch (err) {
            this.logger.error(
              'Failed to emit apply telemetry handler.',
              { entitySet: setName },
              err as Error,
            );
          }
        }
        if (shouldLogApply) {
          this.logger.debug('$apply telemetry', {
            entitySet: setName,
            mode,
            stageIndex: stageIndex + 1,
            stageCount,
            rows: data.rows,
            durationMs: data.durationMs,
            joinCount: data.joinCount,
            reason: data.reason,
          });
        }
      }

      this.emitTelemetry({
        category: 'apply',
        event: 'apply-stage',
        level: mode === 'pushdown' ? 'debug' : 'info',
        context: {
          entitySet: setName,
          mode,
          stageIndex: stageIndex + 1,
          stageCount,
          rows: data.rows,
          durationMs: data.durationMs,
          joinCount: data.joinCount,
          reason: data.reason,
        },
      });

      if (stageIndex + 1 === stageCount && typeof data.rows === 'number') {
        this.recordTelemetryStats({ rows: data.rows });
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
      paging?: {
        orderDescriptors: OrderDescriptor[];
        skipTokenParts?: string[];
        pageSize?: number;
        stageTop?: number;
        stageSkip?: number;
      },
    ): Promise<AnyObject | undefined> {
      if (!def.applyPushdown || !def.applyExecutorId) return undefined;
      const registry = this.applyExecutors;
      if (!registry) return undefined;
      const executor = registry.get(def.applyExecutorId);
      if (!executor) return undefined;

      const paginationLimits = this.getPaginationLimits();

      const emitReason = (reason: string) => {
        this.emitApplyTelemetry('pushdown', stageIndex, stageCount || 1, { reason });
      };

      if (
        aggregation.aggregates.some((item) => Boolean(item.expression)) ||
        this.planHasComputedAggregates(plan)
      ) {
        emitReason('computed-aggregate');
        return undefined;
      }

      const planContainsConcat = this.planHasConcat(plan);
      const executorSupportsConcat = executor.capabilities?.concat === true;
      if (planContainsConcat && !executorSupportsConcat) {
        emitReason('concat-unsupported');
        return undefined;
      }

      const cloneExpression = (expression: ParsedExpression): ParsedExpression =>
        JSON.parse(JSON.stringify(expression));

      const cloneStage = (stageToClone: ApplyAggregationStage): ApplyAggregationStage => ({
        spec: {
          groupBy: [...stageToClone.spec.groupBy],
          aggregates: stageToClone.spec.aggregates.map((expr) => ({ ...expr })),
        },
        postAggregationFilters: stageToClone.postAggregationFilters.map(cloneExpression),
        orderBy: stageToClone.orderBy
          ? stageToClone.orderBy.map((item) => ({ ...item }))
          : undefined,
        top: stageToClone.top,
        skip: stageToClone.skip,
        navigationPaths: stageToClone.navigationPaths
          ? stageToClone.navigationPaths.map((path) => ({
              ...path,
              joins: path.joins.map((join) => ({ ...join })),
            }))
          : [],
      });

      const clonePlan = (sourcePlan?: ApplyExecutionPlan): ApplyExecutionPlan | undefined => {
        if (!sourcePlan) return undefined;
        const clonedConcat = sourcePlan.concat
          ?.map((branch) => clonePlan(branch))
          .filter((branch): branch is ApplyExecutionPlan => Boolean(branch));
        const clonedOrder =
          sourcePlan.postOrderBy?.map((item) => ({
            field: item.field,
            direction: item.direction,
          })) ?? undefined;
        const clonedFilters = sourcePlan.postFilters?.map(cloneExpression) ?? undefined;
        return {
          pushdownWhere: sourcePlan.pushdownWhere,
          preAggregationFilters: [...sourcePlan.preAggregationFilters],
          stages: sourcePlan.stages.map(cloneStage),
          ...(clonedConcat?.length ? { concat: clonedConcat } : {}),
          ...(clonedOrder?.length ? { postOrderBy: clonedOrder } : {}),
          ...(sourcePlan.postTop !== undefined ? { postTop: sourcePlan.postTop } : {}),
          ...(sourcePlan.postSkip !== undefined ? { postSkip: sourcePlan.postSkip } : {}),
          ...(clonedFilters?.length ? { postFilters: clonedFilters } : {}),
        };
      };

      const buildFallbackPlan = (): ApplyExecutionPlan | undefined => {
        if (!aggregation?.aggregates?.length) return undefined;
        const spec: AggregationSpec = {
          groupBy: [...aggregation.groupBy],
          aggregates: aggregation.aggregates.map((expr) => ({ ...expr })),
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
          postFilters: [],
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

      const effectivePipeline: ApplyPipeline = pipeline ?? { transformations: [] };
      const fetchFilterCopy: Filter<CrudEntity> = { ...fetchFilter };
      if (fetchFilter.where) {
        fetchFilterCopy.where = { ...(fetchFilter.where as CrudWhere) } as CrudWhere;
      }
      if (Array.isArray(fetchFilter.include)) {
        fetchFilterCopy.include = [...fetchFilter.include];
      }

      const executorPaging = paging
        ? {
            order: paging.orderDescriptors.map((item) => ({
              field: item.field,
              direction: item.direction,
            })),
            skipTokenValues: paging.skipTokenParts ? [...paging.skipTokenParts] : undefined,
            pageSize: paging.pageSize,
            stageTop: paging.stageTop,
            stageSkip: paging.stageSkip,
          }
        : undefined;

      const context: ODataApplyExecutorContext = {
        entitySet: def,
        repository: this.repository,
        plan: executionPlan,
        pipeline: effectivePipeline,
        aggregation,
        baseFilter: { ...baseFilter },
        fetchFilter: fetchFilterCopy,
        options,
        requestedLimit,
        requestedOffset,
        stageIndex,
        stageCount: planStages.length,
        telemetry: (payload) => {
          this.emitApplyTelemetry('pushdown', stageIndex, planStages.length, {
            rows: payload.rows,
            durationMs: payload.durationMs,
            joinCount: payload.joinCount,
          });
        },
        paging: executorPaging,
      };

      try {
        const execOutcome = await executor.execute(context);
        if (!execOutcome) {
          const reason = 'executor-declined';
          this.emitApplyTelemetry('pushdown', stageIndex, planStages.length, {
            reason,
          });
          this.logApplyFallback(
            reason,
            {
              entitySet: setName,
              transformations: effectivePipeline.transformations.length,
              rows: 0,
            },
            executionPlan,
          );
          return undefined;
        }
        if ('declineReason' in execOutcome) {
          this.emitApplyTelemetry('pushdown', stageIndex, planStages.length, {
            reason: execOutcome.declineReason,
          });
          this.logApplyFallback(
            execOutcome.declineReason,
            {
              entitySet: setName,
              transformations: effectivePipeline.transformations.length,
              rows: 0,
            },
            executionPlan,
          );
          return undefined;
        }
        const execResult = execOutcome;

        let working = execResult.rows ?? [];

        const requiresStageFilters = planStages.some(
          (item) => item.postAggregationFilters.length > 0,
        );
        if (requiresStageFilters && execResult.appliedStageFilters !== true) {
          emitReason('missing-stage-filters');
          this.logApplyFallback(
            'stage-filters-not-applied',
            {
              entitySet: setName,
              transformations: effectivePipeline.transformations.length,
              rows: execResult.rows?.length ?? 0,
            },
            executionPlan,
          );
          return undefined;
        }

        const requiresStagePagination = planStages.some(
          (item) => item.top !== undefined || item.skip !== undefined,
        );
        if (requiresStagePagination && execResult.appliedPipelinePagination !== true) {
          emitReason('missing-stage-pagination');
          this.logApplyFallback(
            'stage-pagination-not-applied',
            {
              entitySet: setName,
              transformations: effectivePipeline.transformations.length,
              rows: execResult.rows?.length ?? 0,
            },
            executionPlan,
          );
          return undefined;
        }
        if (postFilterExpr) {
          working = this.applyPostFilter(working, postFilterExpr);
        }

        const finalStage = planStages[planStages.length - 1];
        const stageOrderClauses = finalStage?.orderBy?.map(
          (item) => `${item.field} ${item.direction.toUpperCase()}`,
        );
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
        } else if (fallbackOrder && execResult.appliedOrder !== true) {
          ordered = this.orderResults(working, fallbackOrder);
        }

        const descriptorList = paging?.orderDescriptors ?? [];
        let nextLinkValues = execResult.nextSkipTokenValues;
        let nextLinkToken: string | undefined;

        if (execResult.appliedExternalPagination !== true) {
          if (descriptorList.length) {
            const descriptorOrder = descriptorList.map((item) => `${item.field} ${item.direction}`);
            ordered = this.orderResults(ordered, descriptorOrder);
            ordered = this.filterRowsAfterSkipToken(
              ordered,
              descriptorList,
              paging?.skipTokenParts,
            );
            const pageSize =
              paging?.pageSize ??
              this.resolvePageSize(undefined, {
                maxPageSize: paginationLimits.maxApplyPageSize ?? paginationLimits.maxPageSize,
                context: '$apply',
              });
            const pagination = this.applyServerDrivenPaging(ordered, descriptorList, pageSize);
            ordered = pagination.items;
            nextLinkToken = pagination.token;
            nextLinkValues = undefined;
          } else {
            ordered = this.sliceResults(ordered, requestedOffset, requestedLimit);
          }
        } else if (!nextLinkToken && nextLinkValues?.length) {
          nextLinkToken = this.signSkipTokenValues(nextLinkValues, descriptorList) ?? undefined;
        }

        if (postFilterExpr) {
          nextLinkToken = undefined;
          nextLinkValues = undefined;
        }

        this.ensureODataHeaders();
        const response = {
          '@odata.context': contextBase,
          value: ordered,
        } as AnyObject;
        if (nextLinkToken) {
          response['@odata.nextLink'] = this.buildNextLink(nextLinkToken);
        }
        if (Array.isArray(ordered)) {
          this.recordTelemetryStats({ rows: ordered.length });
        }
        return response;
      } catch (error) {
        this.emitApplyTelemetry('pushdown', stageIndex, planStages.length, {
          reason: 'executor-error',
        });
        this.logApplyFallback(
          'executor-error',
          {
            entitySet: setName,
            transformations: effectivePipeline.transformations.length ?? 0,
            rows: 0,
          },
          executionPlan,
        );
        return undefined;
      }
    }

    resolveFunctionArgValue(
      arg: FunctionArg,
      current: AnyObject,
      alias: string,
      root: AnyObject,
    ): unknown {
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

    evaluateStringFunction(
      expr: Extract<ParsedExpression, { operator: 'stringfncmp' }>,
      current: AnyObject,
      alias: string,
      root: AnyObject,
    ): string | undefined {
      switch (expr.name) {
        case 'trim': {
          const value = this.resolveFunctionArgValue(expr.args[0], current, alias, root);
          if (value == null) return undefined;
          return String(value).trim();
        }
        case 'concat': {
          const parts = expr.args.map((arg) => {
            const value = this.resolveFunctionArgValue(arg, current, alias, root);
            return value == null ? '' : String(value);
          });
          return parts.join('');
        }
        default:
          return undefined;
      }
    }

    extractDatePart(
      value: unknown,
      part: 'month' | 'day' | 'hour' | 'minute' | 'second',
    ): number | undefined {
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
      ensureIncludeProjection(
        filter as Filter<AnyObject>,
        filter.include as InclusionFilter[] | undefined,
        modelRelations,
      );
      this.ensureLambdaFieldProjection(filter, lambda.path[0]);
    }

    cloneIncludeEntry(entry: string | InclusionFilter): NormalizedInclusion {
      if (typeof entry === 'string') {
        return { relation: entry };
      }
      const scope = entry.scope ? { ...entry.scope } : undefined;
      if (scope?.include) {
        if (Array.isArray(scope.include)) {
          scope.include = scope.include.map((item) => this.cloneIncludeEntry(item));
        } else {
          scope.include = [this.cloneIncludeEntry(scope.include)];
        }
      }
      return { relation: entry.relation, scope };
    }

    normalizeIncludeList(include: Filter<CrudEntity>['include']): NormalizedInclusion[] {
      if (!include) return [];
      if (Array.isArray(include)) {
        return include.map((entry) => this.cloneIncludeEntry(entry));
      }
      return [this.cloneIncludeEntry(include)];
    }

    ensureIncludePath(include: NormalizedInclusion[], path: string[]) {
      const [current, ...rest] = path;
      if (!current) return;
      let entry = include.find((item) => item.relation === current);
      if (!entry) {
        entry = rest.length ? { relation: current, scope: { include: [] } } : { relation: current };
        include.push(entry);
      }
      if (!rest.length) return;
      entry.scope = entry.scope ?? {};
      const rawInclude = entry.scope.include;
      const nested = Array.isArray(rawInclude)
        ? rawInclude.map((item) => this.cloneIncludeEntry(item))
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
      return current.filter((item) => item != null) as AnyObject[];
    }

    filterEntitiesByLambda(entities: AnyObject[], lambda: LambdaExpression): AnyObject[] {
      return entities.filter((entity) => this.evaluateLambda(entity, lambda));
    }

    evaluateLambda(entity: AnyObject, lambda: LambdaExpression): boolean {
      const items = this.resolveCollectionPath(entity, lambda.path);
      if (lambda.type === 'any') {
        return items.some((item) =>
          this.evaluatePredicate(lambda.predicate, item, lambda.alias, entity),
        );
      }
      // all
      if (!items.length) return true;
      return items.every((item) =>
        this.evaluatePredicate(lambda.predicate, item, lambda.alias, entity),
      );
    }

    evaluatePredicate(
      expr: ParsedExpression,
      current: AnyObject,
      alias: string,
      root: AnyObject,
    ): boolean {
      switch (expr.operator) {
        case 'comparison': {
          const left = this.resolvePredicateValue(expr.field, current, alias, root);
          const right = expr.value;
          switch (expr.comparator) {
            case 'eq':
              return this.compareValues(left, right) === 0;
            case 'neq':
              return this.compareValues(left, right) !== 0;
            case 'gt':
              return this.compareValues(left, right) > 0;
            case 'gte':
              return this.compareValues(left, right) >= 0;
            case 'lt':
              return this.compareValues(left, right) < 0;
            case 'lte':
              return this.compareValues(left, right) <= 0;
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
            case 'eq':
              return compare === 0;
            case 'neq':
              return compare !== 0;
            case 'gt':
              return compare > 0;
            case 'gte':
              return compare >= 0;
            case 'lt':
              return compare < 0;
            case 'lte':
              return compare <= 0;
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
            case 'eq':
              return compare === 0;
            case 'neq':
              return compare !== 0;
            case 'gt':
              return compare > 0;
            case 'gte':
              return compare >= 0;
            case 'lt':
              return compare < 0;
            case 'lte':
              return compare <= 0;
          }
          return false;
        }
        case 'substrcmp': {
          const value = this.resolvePredicateValue(expr.field, current, alias, root);
          if (typeof value !== 'string') return false;
          const start = Math.max(0, expr.start);
          const segment =
            expr.length !== undefined ? value.substr(start, expr.length) : value.slice(start);
          return expr.comparator === 'eq' ? segment === expr.literal : segment !== expr.literal;
        }
        case 'lengthcmp': {
          const value = this.resolvePredicateValue(expr.field, current, alias, root);
          const len =
            typeof value === 'string' ? value.length : Array.isArray(value) ? value.length : 0;
          switch (expr.comparator) {
            case 'eq':
              return len === expr.value;
            case 'gt':
              return len > expr.value;
            case 'gte':
              return len >= expr.value;
            case 'lt':
              return len < expr.value;
            case 'lte':
              return len <= expr.value;
            case 'neq':
              return len !== expr.value;
            default:
              return false;
          }
        }
        case 'logical': {
          if (expr.type === 'and') {
            return expr.expressions.every((child) =>
              this.evaluatePredicate(child, current, alias, root),
            );
          }
          return expr.expressions.some((child) =>
            this.evaluatePredicate(child, current, alias, root),
          );
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

    resolvePredicateValue(
      path: string,
      current: AnyObject,
      alias: string,
      root: AnyObject,
    ): unknown {
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

    allowedProperties(): { props: Set<string>; relations: Set<string> } {
      const props = new Set<string>(Object.keys(modelDefinition?.properties ?? {}));
      const relations = new Set<string>(Object.keys(modelRelations ?? {}));
      return { props, relations };
    }

    getModelPropertySet(modelCtor: typeof Entity): Set<string> {
      if (!modelCtor) return new Set<string>();
      const cached = this.modelPropertyCache.get(modelCtor);
      if (cached) return cached;
      const definition =
        ensureModelDefinitionWithRelations(modelCtor) ?? this.getModelDefinition(modelCtor);
      const props = new Set<string>(Object.keys(definition?.properties ?? {}));
      this.modelPropertyCache.set(modelCtor, props);
      return props;
    }

    getModelPropertyDefinition(
      modelCtor: typeof Entity,
      propertyName: string,
    ): PropertyDefinition | undefined {
      if (!modelCtor || !propertyName) return undefined;
      const definition =
        ensureModelDefinitionWithRelations(modelCtor) ?? this.getModelDefinition(modelCtor);
      return definition?.properties?.[propertyName] as PropertyDefinition | undefined;
    }

    isPrimitiveModelProperty(modelCtor: typeof Entity, propertyName: string): boolean {
      const propDef = this.getModelPropertyDefinition(modelCtor, propertyName);
      if (!propDef) return false;
      return Boolean(classifyPrimitiveProperty(propDef));
    }

    isStructuredPathAllowed(field: string, options: { requireProperty: boolean }): boolean {
      if (!field || typeof field !== 'string' || !field.includes('/')) return false;
      try {
        const resolved = resolveNavigationPath(this.entityCtor, field, {
          maxDepth: this.cfg?.maxExpandDepth ?? 5,
        });
        const hasNavigation = resolved.joins.length > 0;
        if (hasNavigation && resolved.joins.some((join) => join.relationType === 'hasMany')) {
          return false;
        }
        const propertyPath = resolved.propertyPath;
        if (!propertyPath) {
          return !options.requireProperty;
        }
        const propertySegments = propertyPath.split('/').filter(Boolean);
        if (!propertySegments.length) {
          return !options.requireProperty;
        }
        const baseModel = hasNavigation ? resolved.targetModel : this.entityCtor;
        return this.validateStructuredPropertyPath(baseModel, propertySegments);
      } catch (error) {
        if (error instanceof NavigationPathError) {
          return false;
        }
        throw error;
      }
    }

    validateStructuredPropertyPath(modelCtor: typeof Entity, segments: string[]): boolean {
      if (!modelCtor || !segments.length) return false;
      const resolution = resolveStructuredPropertySegments(modelCtor, segments);
      return Boolean(resolution);
    }

    isStructuredFieldPath(field: string): boolean {
      if (!field || typeof field !== 'string' || !field.includes('/')) return false;
      try {
        const resolved = resolveNavigationPath(this.entityCtor, field, {
          maxDepth: this.cfg?.maxExpandDepth ?? 5,
        });
        const propertySegments = resolved.propertyPath?.split('/').filter(Boolean) ?? [];
        if (!propertySegments.length) return false;
        const baseModel = resolved.joins.length ? resolved.targetModel : this.entityCtor;
        return this.pathRequiresStructuredLookup(baseModel, propertySegments);
      } catch (error) {
        if (error instanceof NavigationPathError) {
          const segments = field.split('/').filter(Boolean);
          if (segments.length <= 1) return false;
          return this.pathRequiresStructuredLookup(this.entityCtor, segments);
        }
        throw error;
      }
    }

    pathRequiresStructuredLookup(modelCtor: typeof Entity, segments: string[]): boolean {
      if (!modelCtor || segments.length <= 1) return false;
      const resolution = resolveStructuredPropertySegments(modelCtor, segments);
      return Boolean(resolution && resolution.jsonPath.length);
    }

    combinePostFilterExpressions(
      left: ParsedExpression | undefined,
      right: ParsedExpression | undefined,
    ): ParsedExpression | undefined {
      if (!left) return right;
      if (!right) return left;
      return { operator: 'logical', type: 'and', expressions: [left, right] };
    }

    splitWhereExpression(expr: ParsedExpression | undefined): {
      repoExpr?: ParsedExpression;
      structuredExpr?: ParsedExpression;
    } {
      if (!expr) return {};
      return this.splitParsedExpression(expr);
    }

    splitParsedExpression(expr: ParsedExpression): {
      repoExpr?: ParsedExpression;
      structuredExpr?: ParsedExpression;
    } {
      switch (expr.operator) {
        case 'comparison':
          return this.isStructuredFieldPath(expr.field)
            ? { structuredExpr: expr }
            : { repoExpr: expr };
        case 'logical':
          if (expr.type === 'and') {
            const repoChildren: ParsedExpression[] = [];
            const structuredChildren: ParsedExpression[] = [];
            for (const child of expr.expressions) {
              const split = this.splitParsedExpression(child);
              if (split.repoExpr) repoChildren.push(split.repoExpr);
              if (split.structuredExpr) structuredChildren.push(split.structuredExpr);
            }
            return {
              repoExpr: this.combineParsedExpressions('and', repoChildren),
              structuredExpr: this.combineParsedExpressions('and', structuredChildren),
            };
          }
          if (expr.type === 'or') {
            const childSplits = expr.expressions.map((child) => this.splitParsedExpression(child));
            const canPushdown = childSplits.every(
              (split) => !split.structuredExpr && Boolean(split.repoExpr),
            );
            if (!canPushdown) {
              return { structuredExpr: expr };
            }
            const repoChildren = childSplits
              .map((split) => split.repoExpr)
              .filter((child): child is ParsedExpression => Boolean(child));
            return { repoExpr: this.combineParsedExpressions('or', repoChildren) };
          }
          return {};
        case 'not': {
          const childSplit = this.splitParsedExpression(expr.expr);
          if (!childSplit.repoExpr || childSplit.structuredExpr) {
            return { structuredExpr: expr };
          }
          return { repoExpr: { operator: 'not', expr: childSplit.repoExpr } };
        }
        default: {
          const fields = this.extractExpressionFields(expr);
          if (fields.some((field) => this.isStructuredFieldPath(field))) {
            return { structuredExpr: expr };
          }
          return { repoExpr: expr };
        }
      }
    }

    combineParsedExpressions(
      type: 'and' | 'or',
      expressions: ParsedExpression[],
    ): ParsedExpression | undefined {
      if (!expressions.length) return undefined;
      if (expressions.length === 1) return expressions[0];
      return { operator: 'logical', type, expressions };
    }

    extractExpressionFields(expr: ParsedExpression): string[] {
      switch (expr.operator) {
        case 'function':
        case 'fncmp':
        case 'datepart':
        case 'indexofcmp':
        case 'substrcmp':
        case 'lengthcmp':
          return [expr.field];
        case 'stringfncmp':
          return expr.args
            .filter((arg): arg is FunctionArg & { kind: 'field' } => arg.kind === 'field')
            .map((arg) => arg.name);
        default:
          return [];
      }
    }

    validateParsedExpressionFields(expr: ParsedExpression, clause: string) {
      switch (expr.operator) {
        case 'comparison': {
          this.ensureFieldAllowedStrict(expr.field, clause);
          return;
        }
        case 'logical': {
          for (const child of expr.expressions) {
            this.validateParsedExpressionFields(child, clause);
          }
          return;
        }
        case 'not': {
          this.validateParsedExpressionFields(expr.expr, clause);
          return;
        }
        case 'function':
        case 'fncmp':
        case 'datepart':
        case 'indexofcmp':
        case 'substrcmp':
        case 'lengthcmp': {
          this.ensureFieldAllowedStrict(expr.field, clause);
          return;
        }
        case 'stringfncmp': {
          for (const arg of expr.args) {
            if (arg.kind === 'field') {
              this.ensureFieldAllowedStrict(arg.name, clause);
            }
          }
          return;
        }
        case 'lambda': {
          this.validateParsedExpressionFields(expr.predicate, clause);
          return;
        }
        default:
          return;
      }
    }

    ensureApplyFieldAllowedOnModel(
      modelCtor: typeof Entity,
      field: string,
      clause: string,
      options?: { allowNavigationOnly?: boolean },
    ) {
      if (!field) {
        throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
      }
      let resolved: ResolvedNavigationPath;
      try {
        resolved = resolveNavigationPath(modelCtor, field, {
          maxDepth: this.cfg?.maxExpandDepth ?? 5,
        });
      } catch (error) {
        if (error instanceof NavigationPathError) {
          throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
        }
        throw error;
      }
      const propertyPath = resolved.propertyPath;
      if (!propertyPath) {
        if (options?.allowNavigationOnly && resolved.joins.length) {
          return;
        }
        throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
      }
      const segments = propertyPath.split('/').filter(Boolean);
      if (!segments.length) {
        if (options?.allowNavigationOnly && resolved.joins.length) {
          return;
        }
        throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
      }
      const targetModel = resolved.joins.length ? resolved.targetModel : modelCtor;
      if (segments.length === 1) {
        const propDef = this.getModelPropertyDefinition(targetModel, segments[0]);
        if (!propDef) {
          throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
        }
        return;
      }
      const structured = resolveStructuredPropertySegments(targetModel, segments);
      if (!structured) {
        throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
      }
    }

    resolveApplyLambdaTargetModel(
      modelCtor: typeof Entity,
      path: string,
      clause: string,
    ): typeof Entity {
      let resolved: ResolvedNavigationPath;
      try {
        resolved = resolveNavigationPath(modelCtor, path, {
          maxDepth: this.cfg?.maxExpandDepth ?? 5,
        });
      } catch (error) {
        if (error instanceof NavigationPathError) {
          throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${path}`);
        }
        throw error;
      }
      if (!resolved.joins.length || resolved.propertyPath) {
        throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${path}`);
      }
      return resolved.targetModel;
    }

    resolveApplyInputColumn(field: string, columns: Set<string>): string | undefined {
      if (!field) return undefined;
      if (columns.has(field)) return field;
      const lowered = field.toLowerCase();
      for (const candidate of columns) {
        if (candidate.toLowerCase() === lowered) return candidate;
      }
      return undefined;
    }

    ensureApplyFieldAllowedOnInput(input: ApplyFieldInput, field: string, clause: string) {
      if (input.kind === 'model') {
        this.ensureApplyFieldAllowedOnModel(input.modelCtor, field, clause);
        return;
      }
      const match = this.resolveApplyInputColumn(field, input.columns);
      if (!match) {
        throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
      }
    }

    validateApplyExpressionFields(
      expr: ParsedExpression,
      clause: string,
      input: ApplyFieldInput,
      options?: {
        outputFields?: Set<string>;
        restrictToOutput?: boolean;
        lambdaContext?: { alias: string; modelCtor: typeof Entity };
      },
    ) {
      const outputFields = options?.outputFields;
      const restrictToOutput = options?.restrictToOutput === true;
      const lambdaContext = options?.lambdaContext;
      const validateField = (field: string) => {
        if (!field) {
          throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
        }
        if (outputFields && this.resolveApplyInputColumn(field, outputFields)) return;
        if (restrictToOutput) {
          throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
        }
        if (lambdaContext && field.startsWith(`${lambdaContext.alias}/`)) {
          const stripped = field.slice(lambdaContext.alias.length + 1);
          this.ensureApplyFieldAllowedOnModel(lambdaContext.modelCtor, stripped, clause);
          return;
        }
        this.ensureApplyFieldAllowedOnInput(input, field, clause);
      };

      switch (expr.operator) {
        case 'comparison':
          validateField(expr.field);
          return;
        case 'logical':
          for (const child of expr.expressions) {
            this.validateApplyExpressionFields(child, clause, input, options);
          }
          return;
        case 'not':
          this.validateApplyExpressionFields(expr.expr, clause, input, options);
          return;
        case 'function':
        case 'fncmp':
        case 'datepart':
        case 'indexofcmp':
        case 'substrcmp':
        case 'lengthcmp':
          validateField(expr.field);
          return;
        case 'stringfncmp':
          for (const arg of expr.args) {
            if (arg.kind === 'field') {
              validateField(arg.name);
            }
          }
          return;
        case 'lambda': {
          if (input.kind !== 'model') {
            const path = expr.path.join('/');
            throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${path}`);
          }
          const path = expr.path.join('/');
          const targetModel = this.resolveApplyLambdaTargetModel(input.modelCtor, path, clause);
          this.validateApplyExpressionFields(expr.predicate, clause, input, {
            outputFields,
            restrictToOutput,
            lambdaContext: { alias: expr.alias, modelCtor: targetModel },
          });
          return;
        }
        default:
          return;
      }
    }

    buildApplyStageOutputColumns(stage: ApplyAggregationStage): Set<string> {
      const output = new Set<string>();
      for (const field of stage.spec.groupBy ?? []) {
        if (field) output.add(field);
      }
      for (const aggregate of stage.spec.aggregates ?? []) {
        if (aggregate.alias) output.add(aggregate.alias);
      }
      return output;
    }

    resolveApplyPlanOutputFields(
      plan: ApplyExecutionPlan,
      input: ApplyFieldInput,
    ): ApplyFieldOutput {
      let stageInput: ApplyFieldInput = input;
      if (plan.stages.length) {
        const stageColumns = this.buildApplyStageOutputColumns(plan.stages[plan.stages.length - 1]);
        stageInput = { kind: 'columns', columns: stageColumns };
      }

      if (plan.concat?.length) {
        const columns = new Set<string>();
        let allowModel = false;
        for (const branch of plan.concat) {
          const output = this.resolveApplyPlanOutputFields(branch, stageInput);
          if (output.kind === 'model') {
            allowModel = true;
          }
          if (output.kind === 'columns') {
            output.columns.forEach((col) => columns.add(col));
          } else if (output.columns) {
            output.columns.forEach((col) => columns.add(col));
          }
        }
        if (allowModel && stageInput.kind === 'model') {
          return {
            kind: 'model',
            modelCtor: stageInput.modelCtor,
            columns: columns.size ? columns : undefined,
          };
        }
        if (columns.size) {
          return { kind: 'columns', columns };
        }
        return stageInput.kind === 'model'
          ? { kind: 'model', modelCtor: stageInput.modelCtor }
          : { kind: 'columns', columns: stageInput.columns };
      }

      return stageInput.kind === 'model'
        ? { kind: 'model', modelCtor: stageInput.modelCtor }
        : { kind: 'columns', columns: stageInput.columns };
    }

    validateApplyPlanFields(plan: ApplyExecutionPlan, input?: ApplyFieldInput) {
      const clause = '$apply';
      const baseInput = input ?? ({ kind: 'model', modelCtor: this.entityCtor } as const);
      const validateStage = (
        stage: ApplyAggregationStage,
        input: ApplyFieldInput,
      ): ApplyFieldInput => {
        const output = this.buildApplyStageOutputColumns(stage);
        for (const field of stage.spec.groupBy ?? []) {
          this.ensureApplyFieldAllowedOnInput(input, field, clause);
        }
        for (const aggregate of stage.spec.aggregates ?? []) {
          if (aggregate.field) {
            this.ensureApplyFieldAllowedOnInput(input, aggregate.field, clause);
          }
          if (aggregate.expression) {
            this.collectPathsFromComputeNode(aggregate.expression, (path) =>
              this.ensureApplyFieldAllowedOnInput(input, path, clause),
            );
          }
        }
        const outputInput = { kind: 'columns', columns: output } as const;
        for (const expr of stage.postAggregationFilters ?? []) {
          this.validateApplyExpressionFields(expr, clause, outputInput, {
            outputFields: output,
            restrictToOutput: true,
          });
        }
        for (const item of stage.orderBy ?? []) {
          if (!item.field || !this.resolveApplyInputColumn(item.field, output)) {
            throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${item.field}`);
          }
        }
        return outputInput;
      };

      for (const expr of plan.preAggregationFilters ?? []) {
        this.validateApplyExpressionFields(expr, clause, baseInput);
      }

      let finalInput: ApplyFieldInput = baseInput;
      for (const stage of plan.stages ?? []) {
        finalInput = validateStage(stage, finalInput);
      }

      if (plan.concat?.length) {
        for (const branch of plan.concat) {
          this.validateApplyPlanFields(branch, finalInput);
        }
      }

      const output = this.resolveApplyPlanOutputFields(plan, baseInput);
      const outputInput =
        output.kind === 'columns'
          ? ({ kind: 'columns', columns: output.columns } as const)
          : ({ kind: 'model', modelCtor: output.modelCtor } as const);

      if (plan.postOrderBy?.length) {
        for (const item of plan.postOrderBy) {
          if (output.columns && this.resolveApplyInputColumn(item.field, output.columns)) {
            continue;
          }
          this.ensureApplyFieldAllowedOnInput(outputInput, item.field, clause);
        }
      }

      if (plan.postFilters?.length) {
        for (const expr of plan.postFilters) {
          this.validateApplyExpressionFields(expr, clause, outputInput, {
            outputFields: output.columns,
            restrictToOutput: output.kind === 'columns',
          });
        }
      }
    }

    collectPathsFromComputeNode(node: ComputeNode, visit: (path: string) => void) {
      switch (node.type) {
        case 'path':
          visit(node.path.join('/'));
          return;
        case 'binary':
          this.collectPathsFromComputeNode(node.left, visit);
          this.collectPathsFromComputeNode(node.right, visit);
          return;
        case 'function':
          node.args.forEach((arg) => this.collectPathsFromComputeNode(arg, visit));
          return;
        case 'literal':
        default:
          return;
      }
    }

    serializePrimitiveValue(
      value: unknown,
      kind: PrimitivePropertyKind,
    ): { body: string | Buffer; contentType: string } {
      switch (kind) {
        case 'string': {
          return {
            body: value == null ? '' : String(value),
            contentType: 'text/plain; charset=utf-8',
          };
        }
        case 'number': {
          const numeric = typeof value === 'number' ? value : Number(value);
          if (Number.isNaN(numeric) || !Number.isFinite(numeric)) {
            throw new HttpErrors.InternalServerError('Property value is not a valid number.');
          }
          return {
            body: numeric.toString(),
            contentType: 'text/plain; charset=utf-8',
          };
        }
        case 'boolean': {
          const bool =
            typeof value === 'boolean'
              ? value
              : typeof value === 'string'
                ? value.toLowerCase() === 'true'
                : Boolean(value);
          return {
            body: bool ? 'true' : 'false',
            contentType: 'text/plain; charset=utf-8',
          };
        }
        case 'date': {
          let date: Date;
          if (value instanceof Date) {
            date = value;
          } else if (typeof value === 'string' || typeof value === 'number') {
            date = new Date(value);
          } else {
            throw new HttpErrors.InternalServerError('Property value is not a valid date.');
          }
          if (Number.isNaN(date.getTime())) {
            throw new HttpErrors.InternalServerError('Property value is not a valid date.');
          }
          return {
            body: date.toISOString(),
            contentType: 'text/plain; charset=utf-8',
          };
        }
        case 'buffer': {
          let buffer: Buffer;
          if (typeof Buffer === 'undefined') {
            throw new HttpErrors.InternalServerError(
              'Binary responses are not supported in this runtime.',
            );
          }
          if (Buffer.isBuffer(value)) {
            buffer = value;
          } else if (value instanceof Uint8Array) {
            buffer = Buffer.from(value);
          } else if (value instanceof ArrayBuffer) {
            buffer = Buffer.from(value);
          } else if (typeof value === 'string') {
            buffer = Buffer.from(value, 'base64');
          } else {
            throw new HttpErrors.InternalServerError('Property value is not binary data.');
          }
          return {
            body: buffer,
            contentType: 'application/octet-stream',
          };
        }
        default:
          throw new HttpErrors.InternalServerError('Unsupported primitive property kind.');
      }
    }

    stringPropertyNames(): string[] {
      const props = modelDefinition?.properties ?? {};
      const out: string[] = [];
      for (const [name, def] of Object.entries(props)) {
        const type = (def as any)?.type;
        const typeName =
          typeof type === 'function' ? type.name.toLowerCase() : String(type ?? '').toLowerCase();
        if (type === String || typeName === 'string') out.push(name);
      }
      return out;
    }

    stripComputedFields(
      fields: Filter<CrudEntity>['fields'],
      aliases: string[],
    ): Filter<CrudEntity>['fields'] | undefined {
      if (!fields || !aliases.length) return fields;
      if (Array.isArray(fields)) {
        const filtered = fields.filter((field) => !aliases.includes(field));
        return filtered.length ? filtered : undefined;
      }
      if (typeof fields === 'string') {
        return aliases.includes(fields) ? undefined : fields;
      }
      if (typeof fields === 'object') {
        const clone: AnyObject = { ...(fields as AnyObject) };
        let removed = false;
        for (const alias of aliases) {
          if (Object.prototype.hasOwnProperty.call(clone, alias)) {
            delete clone[alias];
            removed = true;
          }
        }
        if (!removed) return fields;
        return Object.keys(clone).length ? (clone as Filter<CrudEntity>['fields']) : undefined;
      }
      return fields;
    }

    applyComputeExpressions(rows: AnyObject[], expressions: ComputeExpression[] | undefined) {
      if (!expressions?.length) return;
      for (const row of rows) {
        for (const expr of expressions) {
          row[expr.alias] = this.evaluateComputeNode(expr.expression, row);
        }
      }
    }

    collectComputeDependencies(expressions: ComputeExpression[] | undefined): Set<string> {
      const deps = new Set<string>();
      if (!expressions?.length) return deps;
      const visit = (node: ComputeNode) => {
        switch (node.type) {
          case 'path': {
            const head = node.path[0];
            if (head) deps.add(head);
            break;
          }
          case 'binary':
            visit(node.left);
            visit(node.right);
            break;
          case 'function':
            for (const arg of node.args) visit(arg);
            break;
          case 'literal':
          default:
            break;
        }
      };
      for (const expr of expressions) {
        visit(expr.expression);
      }
      return deps;
    }

    ensureComputeFieldProjection(
      fields: Filter<CrudEntity>['fields'],
      dependencies: Set<string>,
    ): Filter<CrudEntity>['fields'] {
      if (!dependencies.size) return fields;
      const toObject = (source: Filter<CrudEntity>['fields']): Record<string, boolean> => {
        if (!source) return {};
        if (Array.isArray(source)) {
          return source.reduce<Record<string, boolean>>((acc, item) => {
            if (item) acc[item] = true;
            return acc;
          }, {});
        }
        if (typeof source === 'string') {
          return source ? { [source]: true } : {};
        }
        return { ...(source as AnyObject) } as Record<string, boolean>;
      };
      const projection = toObject(fields);
      for (const dep of dependencies) {
        if (!Object.prototype.hasOwnProperty.call(projection, dep)) {
          projection[dep] = true;
        }
      }
      return Object.keys(projection).length ? (projection as Filter<CrudEntity>['fields']) : fields;
    }

    evaluateComputeNode(
      node: ComputeNode,
      current: AnyObject,
      variant?: { values: Record<string, unknown> },
    ): unknown {
      switch (node.type) {
        case 'path': {
          const joined = node.path.join('/');
          if (variant && node.path.length) {
            if (variant.values && Object.prototype.hasOwnProperty.call(variant.values, joined)) {
              return variant.values[joined];
            }
            if (joined.includes('/')) {
              const values = this.extractPathValues(current, joined.split('/'));
              return values.length ? values[0] : undefined;
            }
          }
          return this.resolvePath(current, node.path);
        }
        case 'literal':
          return node.value;
        case 'binary': {
          const left = this.evaluateComputeNode(node.left, current, variant);
          const right = this.evaluateComputeNode(node.right, current, variant);
          return this.evaluateNumericBinary(node.operator, left, right);
        }
        case 'function': {
          return this.evaluateComputeFunction(node, current, variant);
        }
        default:
          return undefined;
      }
    }

    evaluateNumericBinary(
      operator: 'add' | 'sub' | 'mul' | 'div' | 'mod',
      left: unknown,
      right: unknown,
    ): number | null {
      if (left == null || right == null) return null;
      const a = this.coerceComputeNumber(left);
      const b = this.coerceComputeNumber(right);
      if (a == null || b == null) return null;
      switch (operator) {
        case 'add':
          return a + b;
        case 'sub':
          return a - b;
        case 'mul':
          return a * b;
        case 'div':
          return b === 0 ? null : a / b;
        case 'mod':
          return b === 0 ? null : a % b;
        default:
          return null;
      }
    }

    coerceComputeNumber(value: unknown): number | null {
      if (value == null) return null;
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
      }
      if (typeof value === 'bigint') {
        return Number(value);
      }
      if (typeof value === 'string' && value.trim() !== '') {
        const numeric = Number(value);
        return Number.isNaN(numeric) ? null : numeric;
      }
      return null;
    }

    evaluateComputeFunction(
      node: Extract<ComputeNode, { type: 'function' }>,
      current: AnyObject,
      variant?: { values: Record<string, unknown> },
    ): unknown {
      const args = node.args.map((arg) => this.evaluateComputeNode(arg, current, variant));
      switch (node.name) {
        case 'tolower': {
          const value = args[0];
          if (value == null) return null;
          return String(value).toLowerCase();
        }
        case 'toupper': {
          const value = args[0];
          if (value == null) return null;
          return String(value).toUpperCase();
        }
        case 'concat': {
          if (!args.length) return '';
          return args.map((entry) => (entry == null ? '' : String(entry))).join('');
        }
        default:
          return undefined;
      }
    }

    resolveSearchableFields(): string[] {
      const mode = this.cfg?.searchMode ?? 'annotated';
      if (mode === 'disabled') return [];
      const set = def.name;
      const cfgFields = this.cfg?.searchFields?.[set];
      if (cfgFields?.length) return cfgFields.slice();
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

    getRepositoryConnectorName(): string | undefined {
      const dataSource = (
        this.repository as CrudRepo & {
          dataSource?: juggler.DataSource;
        }
      ).dataSource;
      if (!dataSource) return undefined;
      const fromConnector = (dataSource.connector as { name?: string } | undefined)?.name;
      if (typeof fromConnector === 'string' && fromConnector.length > 0) {
        return fromConnector;
      }
      const connectorSetting = (dataSource.settings as { connector?: string } | undefined)
        ?.connector;
      if (typeof connectorSetting === 'string' && connectorSetting.length > 0) {
        return connectorSetting;
      }
      return undefined;
    }

    connectorSupportsIlike(connectorName?: string): boolean {
      if (!connectorName) return false;
      const normalized = connectorName.toLowerCase();
      if (normalized.includes('postgres')) return true;
      if (normalized.includes('cockroach')) return true;
      if (normalized.includes('memory')) return true;
      return false;
    }

    getSearchComparisonStrategy(): SearchComparisonStrategy {
      if (this.searchComparisonStrategy) return this.searchComparisonStrategy;
      const connector = this.getRepositoryConnectorName();
      if (this.connectorSupportsIlike(connector)) {
        this.searchComparisonStrategy = {
          positive: 'ilike',
          negative: 'nilike',
        };
        return this.searchComparisonStrategy;
      }
      this.searchComparisonStrategy = {
        positive: 'like',
        negative: 'nlike',
      };
      return this.searchComparisonStrategy;
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
        if (ch === '"' || ch === "'") {
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
            throw new HttpErrors.BadRequest(
              'Invalid $search expression: unterminated quoted phrase.',
            );
          }
          if (!value) {
            throw new HttpErrors.BadRequest(
              'Invalid $search expression: quoted phrase cannot be empty.',
            );
          }
          tokens.push({ type: 'TERM', value });
          continue;
        }
        let value = '';
        while (i < text.length) {
          const current = text[i];
          if (
            current === '(' ||
            current === ')' ||
            /\s/.test(current) ||
            current === '"' ||
            current === "'"
          ) {
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
          const children = node.nodes.map((child) => this.buildSearchWhere(child, fields, negate));
          const combined = negate ? this.combineWithOr(children) : this.combineWithAnd(children);
          if (!combined) {
            throw new HttpErrors.BadRequest('Invalid $search expression: empty conjunction.');
          }
          return combined;
        }
        case 'or': {
          const children = node.nodes.map((child) => this.buildSearchWhere(child, fields, negate));
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
      const strategy = this.getSearchComparisonStrategy();
      const pattern = `%${this.escapeSearchTerm(term)}%`;
      const operator = strategy.positive;
      const clauses = fields.map((field) => {
        return {
          [field]: { [operator]: pattern },
        } as unknown as CrudWhere;
      });
      if (!clauses.length) return undefined;
      if (clauses.length === 1) return clauses[0];
      return this.combineWithOr(clauses) ?? clauses[0];
    }

    buildNegatedTermClause(term: string, fields: string[]): CrudWhere | undefined {
      const strategy = this.getSearchComparisonStrategy();
      const pattern = `%${this.escapeSearchTerm(term)}%`;
      const operator = strategy.negative;
      const clauses = fields.map((field) => {
        // To properly handle NOT LIKE with NULL values,
        // we need: (field NOT LIKE 'pattern' OR field IS NULL)
        // This ensures that NULL fields don't cause the condition to fail
        return {
          or: [{ [field]: { [operator]: pattern } }, { [field]: null }],
        } as unknown as CrudWhere;
      });
      if (!clauses.length) return undefined;
      if (clauses.length === 1) return clauses[0];
      return this.combineWithAnd(clauses) ?? clauses[0];
    }

    escapeSearchTerm(term: string): string {
      return term.replace(/[%_]/g, (ch) => `\\${ch}`);
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

    normalizeOrderDescriptors(
      order: Filter<CrudEntity>['order'],
      idProperties: string[],
    ): OrderDescriptor[] {
      const orderArray = Array.isArray(order) ? order : order ? [order] : [];
      const descriptors: OrderDescriptor[] = [];
      const seen = new Set<string>();

      for (const clause of orderArray) {
        const segment = String(clause ?? '').trim();
        if (!segment) continue;
        const [rawField, rawDirection] = segment.split(/\s+/);
        if (!rawField) continue;
        if (rawField.includes('/')) {
          throw new HttpErrors.BadRequest(
            '$orderby with navigation paths cannot be combined with server-driven paging.',
          );
        }
        const direction = rawDirection?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        if (seen.has(rawField)) continue;
        seen.add(rawField);
        descriptors.push({ field: rawField, direction });
      }

      for (const id of idProperties) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        descriptors.push({ field: id, direction: 'ASC' });
      }

      if (!descriptors.length) {
        const fallback = idProperties[0] ?? 'id';
        descriptors.push({ field: fallback, direction: 'ASC' });
      }

      return descriptors;
    }

    ensureManualSkipOrderDeterminism(
      filter: Filter<CrudEntity>,
      idProperties: string[],
    ): OrderDescriptor[] | undefined {
      if (this.cfg?.appendKeysForClientPaging === false) return undefined;
      if (!idProperties.length) return undefined;
      const descriptors = this.normalizeOrderDescriptors(filter.order, idProperties);
      if (!descriptors.length) return undefined;
      filter.order = descriptors.map((item) => `${item.field} ${item.direction}`);
      if (filter.fields) {
        filter.fields = this.ensureOrderProjection(filter.fields, descriptors);
      }
      return descriptors;
    }

    resolvePageSize(
      requested?: number,
      options: { maxPageSize?: number; context?: string } = {},
    ): number {
      const limits = this.getPaginationLimits();
      const maxPageSize = options.maxPageSize ?? limits.maxPageSize;
      const configSize = Number(this.cfg?.pageSize ?? 0);
      let base = Number.isFinite(configSize) && configSize > 0 ? Math.floor(configSize) : 200;
      if (maxPageSize && base > maxPageSize) {
        this.logPaginationClamp('pageSize(default)', base, maxPageSize, options.context);
        base = maxPageSize;
      }
      const normalized = Number.isFinite(requested) ? Math.floor(Number(requested)) : undefined;
      if (!normalized || normalized <= 0) {
        return base;
      }
      if (maxPageSize && normalized > maxPageSize) {
        this.logPaginationClamp('pageSize', normalized, maxPageSize, options.context);
        return Math.min(base, maxPageSize);
      }
      if (normalized > base) {
        this.logPaginationClamp('pageSize', normalized, base, options.context);
        return base;
      }
      return normalized;
    }

    normalizeTtlSeconds(value: number | undefined, fallback: number): number {
      if (Number.isFinite(value) && value && value > 0) {
        return Math.floor(Number(value));
      }
      return fallback;
    }

    requireTokenSecret(purpose: 'skip' | 'delta'): string {
      const secret = this.cfg?.tokenSecret;
      if (secret) return secret;
      const hint = purpose === 'skip' ? '$skiptoken' : '$deltatoken';
      throw new HttpErrors.InternalServerError(
        `ODataConfig.tokenSecret must be configured to issue ${hint} values.`,
      );
    }

    buildSkipTokenOptions(): TokenSecurityOptions {
      return {
        secret: this.requireTokenSecret('skip'),
        ttlSeconds: this.normalizeTtlSeconds(this.cfg?.skipTokenTtl, 900),
        allowLegacyUnsigned: this.cfg?.allowLegacyUnsignedTokens === true,
      };
    }

    buildDeltaTokenOptions(): DeltaTokenSecurityOptions {
      const ttlSeconds =
        this.cfg?.deltaTokenTtl && this.cfg.deltaTokenTtl > 0
          ? Math.floor(Number(this.cfg.deltaTokenTtl))
          : undefined;
      return {
        secret: this.requireTokenSecret('delta'),
        ttlSeconds,
        allowLegacyUnsigned: this.cfg?.allowLegacyUnsignedTokens === true,
      };
    }

    buildSkipTokenDescriptorKey(descriptors: OrderDescriptor[]): string {
      return descriptors.map((item) => `${item.field}:${item.direction}`).join('|');
    }

    canonicalizeQueryValue(value: unknown): string {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) {
        return `[${value.map((entry) => this.canonicalizeQueryValue(entry)).join(',')}]`;
      }
      if (typeof value === 'object') return stableStringify(value);
      return String(value);
    }

    buildSkipTokenContext(): string {
      const method = (this.request.method ?? 'GET').toUpperCase();
      const path = this.request.path ?? '';
      const params: Array<[string, string]> = [];
      const query = this.request.query ?? {};
      for (const [key, paramValue] of Object.entries(query)) {
        if (key === '$skiptoken' || key === '$skip') continue;
        if (Array.isArray(paramValue)) {
          for (const entry of paramValue) {
            params.push([key, this.canonicalizeQueryValue(entry)]);
          }
          continue;
        }
        params.push([key, this.canonicalizeQueryValue(paramValue)]);
      }
      params.sort((a, b) => {
        if (a[0] === b[0]) return a[1].localeCompare(b[1]);
        return a[0].localeCompare(b[0]);
      });
      const serialized = params
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
      return `${method}:${path}?${serialized}`;
    }

    signSkipTokenValues(values: string[], descriptors: OrderDescriptor[]): string | undefined {
      if (!descriptors.length || !values.length) return undefined;
      if (values.length !== descriptors.length) {
        throw new HttpErrors.InternalServerError('Failed to serialize $skiptoken values.');
      }
      const descriptorKey = this.buildSkipTokenDescriptorKey(descriptors);
      const context = this.buildSkipTokenContext();
      const options = this.buildSkipTokenOptions();
      return signSkipToken({ descriptor: descriptorKey, context, values }, options);
    }

    buildApplyOrderDescriptors(
      stage: ApplyAggregationStage | undefined,
      fallbackSpec: AggregationSpec,
    ): OrderDescriptor[] {
      const descriptors: OrderDescriptor[] = [];
      const seen = new Set<string>();
      const spec = stage?.spec ?? fallbackSpec;
      const orderItems = stage?.orderBy ?? [];

      const addDescriptor = (field: string | undefined, direction: 'ASC' | 'DESC' = 'ASC') => {
        if (!field) return;
        if (seen.has(field)) return;
        seen.add(field);
        descriptors.push({ field, direction });
      };

      for (const item of orderItems) {
        const direction = item.direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        addDescriptor(item.field, direction);
      }

      if (!descriptors.length) {
        for (const groupField of spec.groupBy ?? []) {
          addDescriptor(groupField, 'ASC');
        }
        for (const aggregate of spec.aggregates ?? []) {
          if (aggregate.alias) {
            addDescriptor(aggregate.alias, 'ASC');
          }
        }
      }

      if (!descriptors.length) {
        addDescriptor('value', 'ASC');
      }

      return descriptors;
    }

    decodeSkipTokenValues(
      token: string,
      descriptors: OrderDescriptor[],
      phase: 'apply' | 'collection',
    ): string[] {
      const descriptorKey = this.buildSkipTokenDescriptorKey(descriptors);
      const context = this.buildSkipTokenContext();
      const options = this.buildSkipTokenOptions();
      try {
        const decoded = verifySkipToken(token, descriptorKey, context, options);
        if (decoded.values.length !== descriptors.length) {
          throw new HttpErrors.BadRequest('Invalid $skiptoken value.');
        }
        this.emitTokenTelemetry('skip', 'valid', {
          phase,
          descriptorKey,
        });
        return decoded.values.map((value) => value ?? '');
      } catch (error) {
        if (error instanceof TokenVerificationError) {
          const status = error.reason === 'expired' ? 'expired' : 'invalid';
          this.emitTokenTelemetry('skip', status, {
            phase,
            descriptorKey,
          });
          throw new HttpErrors.BadRequest('Invalid $skiptoken value.');
        }
        this.emitTokenTelemetry('skip', 'invalid', {
          phase,
          descriptorKey,
        });
        throw error;
      }
    }

    parseApplySkipToken(
      token: string | undefined,
      descriptors: OrderDescriptor[],
    ): string[] | undefined {
      if (!token) return undefined;
      return this.decodeSkipTokenValues(token, descriptors, 'apply');
    }

    coerceTokenValue(raw: string, sample: unknown): unknown {
      if (sample == null) {
        return raw === 'null' ? null : raw;
      }
      if (sample instanceof Date) {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) {
          throw new HttpErrors.BadRequest('Invalid date value in $skiptoken.');
        }
        return date;
      }
      switch (typeof sample) {
        case 'number': {
          const num = Number(raw);
          if (Number.isNaN(num)) {
            throw new HttpErrors.BadRequest('Invalid numeric value in $skiptoken.');
          }
          return num;
        }
        case 'boolean':
          if (raw === 'true') return true;
          if (raw === 'false') return false;
          throw new HttpErrors.BadRequest('Invalid boolean value in $skiptoken.');
        default:
          return raw;
      }
    }

    compareRowAgainstToken(
      row: AnyObject,
      descriptors: OrderDescriptor[],
      tokenParts: string[],
    ): number {
      for (let index = 0; index < descriptors.length; index++) {
        const descriptor = descriptors[index];
        const tokenRaw = tokenParts[index];
        const rowValue = this.extractFieldValue(row, descriptor.field);
        const tokenValue = this.coerceTokenValue(tokenRaw, rowValue);
        let cmp = this.compareValues(rowValue, tokenValue);
        if (descriptor.direction === 'DESC') cmp = -cmp;
        if (cmp > 0) return 1;
        if (cmp < 0) return -1;
      }
      return 0;
    }

    filterRowsAfterSkipToken(
      rows: AnyObject[],
      descriptors: OrderDescriptor[],
      tokenParts: string[] | undefined,
    ): AnyObject[] {
      if (!tokenParts?.length) return rows;
      const filtered: AnyObject[] = [];
      for (const row of rows) {
        const cmp = this.compareRowAgainstToken(row, descriptors, tokenParts);
        if (cmp > 0) {
          filtered.push(row);
        }
      }
      return filtered;
    }

    parseSkipTokenValues(
      token: string,
      descriptors: OrderDescriptor[],
      definition: ModelDefinition | undefined,
    ): unknown[] {
      if (!token) {
        throw new HttpErrors.BadRequest('Empty $skiptoken is not allowed.');
      }
      const values = this.decodeSkipTokenValues(token, descriptors, 'collection');
      return descriptors.map((descriptor, index) =>
        this.coerceSkipTokenValue(descriptor.field, values[index] ?? '', definition),
      );
    }

    coerceSkipTokenValue(
      field: string,
      raw: string,
      definition: ModelDefinition | undefined,
    ): unknown {
      if (raw === 'null') return null;
      const properties = (definition?.properties ?? {}) as Record<
        string,
        PropertyDefinition | undefined
      >;
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
      if (
        type === Date ||
        type === 'date' ||
        type === 'datetime' ||
        property?.jsonSchema?.format === 'date-time'
      ) {
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) {
          throw new HttpErrors.BadRequest(`Invalid date value in $skiptoken for ${field}.`);
        }
        return date;
      }
      return raw;
    }

    buildEqualityClause(field: string, value: unknown): CrudWhere {
      const clause: AnyObject = value === null ? { [field]: null } : { [field]: value };
      return clause as CrudWhere;
    }

    buildSkipTokenConstraint(
      token: string,
      descriptors: OrderDescriptor[],
      definition: ModelDefinition | undefined,
    ): CrudWhere | undefined {
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
            comparison = { [descriptor.field]: { neq: null } } as CrudWhere;
          }
        } else {
          const comparator = descriptor.direction === 'DESC' ? 'lt' : 'gt';
          comparison = { [descriptor.field]: { [comparator]: value } } as CrudWhere;
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

    ensureOrderProjection(
      fields: Filter<CrudEntity>['fields'],
      descriptors: OrderDescriptor[],
    ): Filter<CrudEntity>['fields'] {
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

    createSkipToken(
      record: AnyObject | undefined,
      descriptors: OrderDescriptor[],
    ): string | undefined {
      if (!record || !descriptors.length) return undefined;
      const parts: string[] = [];
      for (const descriptor of descriptors) {
        const value = this.extractFieldValue(record, descriptor.field);
        if (value === undefined) return undefined;
        parts.push(this.stringifySkipTokenValue(value));
      }
      return this.signSkipTokenValues(parts, descriptors);
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
      const basePath = this.resolveLinkBasePath();
      return queryString ? `${basePath}?${queryString}` : basePath;
    }

    buildDeltaLink(deltaToken: string): string {
      const params = new URLSearchParams();
      const query = this.request.query ?? {};
      for (const [key, paramValue] of Object.entries(query)) {
        if (!paramValue || key === '$skiptoken' || key === '$skip' || key === '$deltatoken')
          continue;
        if (Array.isArray(paramValue)) {
          for (const entry of paramValue) {
            params.append(key, String(entry));
          }
        } else if (typeof paramValue === 'object') {
          params.set(key, String(paramValue));
        } else {
          params.set(key, String(paramValue));
        }
      }
      params.set('$deltatoken', deltaToken);
      const queryString = params.toString();
      const basePath = this.resolveLinkBasePath();
      return queryString ? `${basePath}?${queryString}` : basePath;
    }

    resolveLinkBasePath(): string {
      const originalUrl = this.request.originalUrl;
      if (typeof originalUrl === 'string' && originalUrl.trim()) {
        const question = originalUrl.indexOf('?');
        return question >= 0 ? originalUrl.slice(0, question) : originalUrl;
      }
      const baseUrl =
        typeof (this.request as AnyObject)?.baseUrl === 'string'
          ? (this.request as AnyObject).baseUrl
          : '';
      const path = this.request.path ?? '';
      if (baseUrl) return `${baseUrl}${path}`;
      return path || '/';
    }

    createDeltaTokenForRows(
      entitySet: string,
      rows: AnyObject[],
      deltaField: string,
      idProps: string[],
      previousToken?: string,
      buckets?: DeltaTokenBucketState[],
      pageRows?: AnyObject[],
    ): string {
      if (!rows.length) {
        return (
          previousToken ??
          encodeDeltaToken(
            { entitySet, lastValue: new Date().toISOString(), buckets },
            this.buildDeltaTokenOptions(),
          )
        );
      }
      const filteredPageRows = this.filterDeltaPageRows(pageRows, deltaField);
      let visibleRows = filteredPageRows && filteredPageRows.length ? filteredPageRows : undefined;
      if (!visibleRows || !visibleRows.length) {
        visibleRows = rows;
      }
      const anchor = visibleRows[visibleRows.length - 1] ?? rows[rows.length - 1];
      const deltaValue = this.extractFieldValue(anchor, deltaField);
      if (deltaValue === undefined) {
        return (
          previousToken ??
          encodeDeltaToken(
            { entitySet, lastValue: new Date().toISOString(), buckets },
            this.buildDeltaTokenOptions(),
          )
        );
      }
      const payload: DeltaTokenPayload = {
        entitySet,
        lastValue: this.stringifySkipTokenValue(deltaValue),
        buckets,
      };
      const cursorKeys = this.collectKeyValues(anchor, idProps);
      if (cursorKeys) {
        payload.keyValues = cursorKeys;
      }
      const pageKeySource =
        filteredPageRows && filteredPageRows.length ? filteredPageRows : visibleRows;
      const pageKeys = pageKeySource
        .map((row) => this.collectKeyValues(row, idProps))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));
      if (pageKeys.length) {
        payload.pageKeys = pageKeys;
      }
      return encodeDeltaToken(payload, this.buildDeltaTokenOptions());
    }

    collectKeyValues(
      row: AnyObject | undefined,
      idProps: string[],
    ): Record<string, unknown> | undefined {
      if (!row || !idProps.length) return undefined;
      const keyValues: Record<string, unknown> = {};
      for (const key of idProps) {
        const value = this.extractFieldValue(row, key);
        if (value === undefined) {
          return undefined;
        }
        keyValues[key] = value;
      }
      return Object.keys(keyValues).length ? keyValues : undefined;
    }

    filterDeltaPageRows(
      rows: AnyObject[] | undefined,
      deltaField: string,
    ): AnyObject[] | undefined {
      if (!rows?.length) return undefined;
      const filtered = rows.filter(
        (row) => !this.isTombstoneRow(row) && this.extractFieldValue(row, deltaField) !== undefined,
      );
      return filtered.length ? filtered : undefined;
    }

    isTombstoneRow(row: AnyObject | undefined): boolean {
      if (!row || typeof row !== 'object') return false;
      const marker = (row as AnyObject)['@removed'];
      if (!marker || typeof marker !== 'object') return false;
      const reason = (marker as AnyObject)['reason'];
      return typeof reason === 'string' ? reason.trim().length > 0 : true;
    }

    async computeTombstones(
      keyCandidates: Record<string, unknown>[] | undefined,
    ): Promise<AnyObject[]> {
      const entries = keyCandidates?.filter((entry) => entry && Object.keys(entry).length);
      if (!entries?.length) return [];
      const tombstones: AnyObject[] = [];
      const seen = new Set<string>();
      for (const candidate of entries) {
        const signature = JSON.stringify(
          Object.keys(candidate)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
              acc[key] = candidate[key];
              return acc;
            }, {}),
        );
        if (seen.has(signature)) continue;
        seen.add(signature);
        const existing = await this.repository.findOne({ where: candidate as CrudWhere });
        if (existing) continue;
        tombstones.push({
          ...candidate,
          '@removed': { reason: 'deleted' },
        });
      }
      return tombstones;
    }

    async computeDeltaTokenFromRepository(
      entitySet: string,
      deltaField: string | undefined,
      where: CrudWhere | undefined,
      idProps: string[],
      options: Options | undefined,
    ): Promise<string | undefined> {
      if (!deltaField) return undefined;
      const order: string[] = [`${deltaField} DESC`];
      for (const key of idProps) {
        if (key !== deltaField) {
          order.push(`${key} DESC`);
        }
      }
      const latest = await this.repository.findOne({ where, order }, options);
      if (!latest) return undefined;
      const plain = this.toPlainEntity(latest) ?? {};
      return this.createDeltaTokenForRows(
        entitySet,
        [plain],
        deltaField,
        idProps,
        undefined,
        undefined,
        [plain],
      );
    }

    buildBucketState(groupKeys: string[], rows: AnyObject[]): DeltaTokenBucketState[] {
      if (!rows.length) return [];
      const buckets = new Map<string, DeltaTokenBucketState>();
      for (const row of rows) {
        const key = this.buildBucketKeyFromRow(row, groupKeys);
        const signature = this.serializeBucketKey(key, groupKeys);
        const snapshot = this.cloneBucketSnapshot(row);
        buckets.set(signature, snapshot ? { key, data: snapshot } : { key });
      }
      return Array.from(buckets.values());
    }

    buildRemovedBuckets(
      previous: DeltaTokenBucketState[] | undefined,
      current: AnyObject[],
      groupKeys: string[],
    ): AnyObject[] {
      if (!previous?.length) return [];
      const currentSignatures = new Set(
        current.map((row) =>
          this.serializeBucketKey(this.buildBucketKeyFromRow(row, groupKeys), groupKeys),
        ),
      );
      const tombstones: AnyObject[] = [];
      for (const entry of previous) {
        const key = entry?.key ?? {};
        const signature = this.serializeBucketKey(key, groupKeys);
        if (currentSignatures.has(signature)) continue;
        const tombstoneBase = entry?.data ? this.clonePlainRecord(entry.data) : {};
        Object.assign(tombstoneBase, key);
        tombstoneBase['@removed'] = { reason: 'deleted' };
        tombstones.push(tombstoneBase);
      }
      return tombstones;
    }

    serializeBucketKey(key: Record<string, unknown>, groupKeys: string[]): string {
      if (!groupKeys.length) return JSON.stringify({});
      const ordered: Record<string, unknown> = {};
      for (const bucketKey of groupKeys) {
        ordered[bucketKey] = key?.[bucketKey];
      }
      return JSON.stringify(ordered);
    }

    clonePlainRecord(source: Record<string, unknown> | undefined): Record<string, unknown> {
      if (!source) return {};
      const clone: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(source)) {
        clone[field] = this.cloneBucketValue(value);
      }
      return clone;
    }

    cloneBucketSnapshot(row: AnyObject): Record<string, unknown> | undefined {
      const snapshot: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(row)) {
        if (field.startsWith('@')) continue;
        snapshot[field] = this.cloneBucketValue(value);
      }
      return Object.keys(snapshot).length ? snapshot : undefined;
    }

    cloneBucketValue(value: unknown): unknown {
      if (value === null || value === undefined) return value;
      if (Array.isArray(value)) {
        return value.map((item) => this.cloneBucketValue(item));
      }
      if (value instanceof Date) {
        return new Date(value.getTime());
      }
      if (typeof value === 'object') {
        const record: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          if (key.startsWith('@')) continue;
          record[key] = this.cloneBucketValue(nested);
        }
        return record;
      }
      return value;
    }

    buildBucketKeyFromRow(row: AnyObject, groupKeys: string[]): Record<string, unknown> {
      if (!groupKeys.length) return {};
      const key: Record<string, unknown> = {};
      for (const bucketKey of groupKeys) {
        key[bucketKey] = this.extractFieldValue(row, bucketKey);
      }
      return key;
    }

    buildLexKeyPredicate(
      idProperties: string[],
      keyValues: Record<string, unknown>,
    ): CrudWhere | undefined {
      if (!idProperties.length) return undefined;
      const branches: CrudWhere[] = [];
      for (let index = 0; index < idProperties.length; index++) {
        const parts: CrudWhere[] = [];
        for (let eqIndex = 0; eqIndex < index; eqIndex++) {
          const eqField = idProperties[eqIndex];
          const eqValue = keyValues[eqField];
          if (eqValue === undefined) return undefined;
          parts.push({ [eqField]: eqValue } as CrudWhere);
        }
        const field = idProperties[index];
        const value = keyValues[field];
        if (value === undefined) return undefined;
        parts.push({ [field]: { gt: value } } as CrudWhere);
        const branch = this.combineWithAnd(parts);
        if (branch) branches.push(branch);
      }
      return this.combineWithOr(branches);
    }

    buildDeltaPredicate(
      deltaField: string,
      lastValueRaw: string,
      definition: ModelDefinition | undefined,
      idProperties: string[],
      rawKeyValues?: Record<string, unknown>,
    ): CrudWhere {
      const typedLast = this.coerceSkipTokenValue(deltaField, lastValueRaw, definition);
      const greaterClause = { [deltaField]: { gt: typedLast } } as CrudWhere;
      if (!idProperties.length || !rawKeyValues || !Object.keys(rawKeyValues).length) {
        return greaterClause;
      }
      const typedKeyValues: Record<string, unknown> = {};
      for (const key of idProperties) {
        const raw = rawKeyValues[key];
        if (raw === undefined) {
          return greaterClause;
        }
        typedKeyValues[key] = this.coerceSkipTokenValue(
          key,
          this.stringifySkipTokenValue(raw),
          definition,
        );
      }
      const equalityClause = { [deltaField]: typedLast } as CrudWhere;
      const keyPredicate = this.buildLexKeyPredicate(idProperties, typedKeyValues);
      if (!keyPredicate) return greaterClause;
      const combinedEquality = this.combineWithAnd([equalityClause, keyPredicate]);
      return this.combineWithOr([greaterClause, combinedEquality]) ?? greaterClause;
    }

    applyServerDrivenPaging(
      data: AnyObject[],
      descriptors: OrderDescriptor[],
      pageSize: number,
    ): { items: AnyObject[]; token?: string } {
      if (!pageSize || pageSize <= 0) {
        return { items: data };
      }
      if (data.length <= pageSize) {
        return { items: data };
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
      this.validateOrderByFields(filter);
      if (!this.cfg?.strict) return;
      const { relations } = this.allowedProperties();

      if (filter.fields && typeof filter.fields === 'object' && !Array.isArray(filter.fields)) {
        for (const key of Object.keys(filter.fields as AnyObject)) {
          if (relations.has(key)) continue;
          this.ensureFieldAllowedStrict(key, '$select', { allowStructuredLeaf: true });
        }
      }

      if (filter.where) {
        const used = new Set<string>();
        this.collectWhereFields(filter.where as AnyObject, used);
        for (const field of used) {
          this.ensureFieldAllowedStrict(field, '$filter');
        }
      }
    }

    validateOrderByFields(filter: Filter<CrudEntity>) {
      if (!filter?.order) return;
      const list = Array.isArray(filter.order) ? filter.order : [filter.order];
      for (const item of list) {
        const raw = String(item ?? '').trim();
        if (!raw) continue;
        const field = raw.split(/\s+/)[0];
        if (field) {
          this.ensureFieldAllowedStrict(field, '$orderby');
        }
      }
    }

    ensureFieldAllowedStrict(
      field: string,
      clause: string,
      options?: { allowStructuredLeaf?: boolean },
    ) {
      if (!field) {
        throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
      }
      if (this.isPrimitiveModelProperty(this.entityCtor, field)) return;
      if (field.includes('/')) {
        if (this.isStructuredPathAllowed(field, { requireProperty: true })) return;
      } else {
        const def = this.getModelPropertyDefinition(this.entityCtor, field);
        const primitive = classifyPrimitiveProperty(def);
        if (!primitive && options?.allowStructuredLeaf && def) return;
      }
      throw new HttpErrors.BadRequest(`Unknown property in ${clause}: ${field}`);
    }

    computeIncludeDepth(includes?: InclusionFilter[]): number {
      if (!includes?.length) return 0;
      const depthOf = (inc: InclusionFilter): number => {
        const obj = typeof inc === 'string' ? { relation: inc } : inc;
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

    enforceSkipLimit(filter: Filter<CrudEntity>, limits?: { maxSkip?: number }) {
      const limitCandidate = this.coerceLimit(limits?.maxSkip ?? this.cfg?.maxSkip);
      if (limitCandidate === undefined) return;
      const requested = typeof filter.offset === 'number' ? filter.offset : undefined;
      if (requested == null) return;
      if (this.cfg?.strict && requested > limitCandidate) {
        throw new HttpErrors.BadRequest(`$skip exceeds maximum allowed (${limitCandidate}).`);
      }
      if (!this.cfg?.strict && requested > limitCandidate) {
        this.logPaginationClamp('$skip', requested, limitCandidate, 'collection');
        filter.offset = limitCandidate;
      }
    }

    applyFormatPreference(format?: string) {
      this.formatOverridden = false;
      if (!format) return;
      const normalized = format.trim().toLowerCase();
      if (!normalized) return;
      const isJson =
        normalized === 'json' ||
        normalized.startsWith('json;') ||
        normalized === 'application/json' ||
        normalized.startsWith('application/json');
      if (isJson) {
        this.formatOverridden = true;
        this.response.type('application/json');
        return;
      }
      const err = new HttpErrors.NotAcceptable('Only JSON $format values are supported.');
      (err as any).code = 'NotAcceptable';
      throw err;
    }

    ensureAcceptsJson(additionalTypes?: string[]) {
      if (this.formatOverridden) return;
      if (!this.cfg?.strict) return;
      const acceptHeader = this.request.get('Accept') ?? this.request.headers?.['accept'];
      const accept = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader;
      if (!accept?.trim()) return; // no Accept means accept anything
      const extras =
        additionalTypes?.map((type) => type?.split(';')[0]?.trim().toLowerCase()).filter(Boolean) ??
        [];
      const allowedTypes = ['application/json', ...extras];
      if (!acceptsAnyMediaType(accept, allowedTypes)) {
        const err = new HttpErrors.NotAcceptable(
          `Accept header must allow one of: ${allowedTypes.join(', ')}.`,
        );
        (err as any).code = 'NotAcceptable';
        throw err;
      }
    }

    ensureJsonContentType() {
      if (!this.cfg?.strict) return;
      const type =
        this.request.get('Content-Type') ??
        (this.request.headers?.['content-type'] as string | undefined);
      if (!type?.trim()) return; // let framework handle missing content-type
      const lower = type.toLowerCase();
      const ok = lower.includes('application/json') || lower.endsWith('+json');
      if (!ok) {
        const err = new HttpErrors.UnsupportedMediaType('Content-Type must be application/json.');
        (err as any).code = 'UnsupportedMediaType';
        throw err;
      }
    }

    isApplyEnabled(): boolean {
      return def.capabilities?.applySupported ?? this.cfg?.capabilities?.applySupported ?? true;
    }

    enforceApplyCapability(
      applyAllowed: boolean,
      parsed: { apply?: AggregationSpec; applyPipeline?: ApplyPipeline } | undefined,
    ) {
      if (applyAllowed) return;
      if (parsed?.apply || parsed?.applyPipeline) {
        throw new HttpErrors.NotImplemented('$apply is disabled for this entity set.');
      }
    }

    async enforceTenantLimit(operation?: CrudOperation, scope?: CrudScope) {
      if (!this.throttler) return;
      if (!this.tenantQuotasEnabled()) return;
      if (this._throttleApplied) return;
      const tenantId = this.resolveTenantId();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.throttler?.release(tenantId);
        this._throttleApplied = false;
      };
      this.response.once('finish', release);
      this.response.once('close', release);
      try {
        const telemetryState = this.getRequestTelemetryState();
        const correlationId = telemetryState?.correlationId;
        const requestId =
          this.request.get('x-request-id') ??
          (this.request.headers?.['x-request-id'] as string | undefined) ??
          ((this.request as AnyObject).id as string | undefined);
        const rawUrl = (this.request as AnyObject).originalUrl ?? this.request.url;
        await this.throttler.check(tenantId, {
          entitySet: setName,
          operation,
          scope,
          method: this.request.method,
          url: rawUrl,
          requestId,
          correlationId,
        });
        this._throttleApplied = true;
        this.emitTelemetry({
          category: 'throttle',
          event: 'tenant-throttle-check',
          level: 'debug',
          context: {
            tenantId,
            operation,
            scope,
            method: this.request.method,
            url: rawUrl,
            result: 'allowed',
          },
        });
      } catch (error) {
        release();
        const message = (error as Error).message;
        this.emitTelemetry({
          category: 'throttle',
          event: 'tenant-throttle-check',
          level: 'warn',
          context: {
            tenantId,
            operation,
            scope,
            method: this.request.method,
            url: (this.request as AnyObject).originalUrl ?? this.request.url,
            result: 'rejected',
            reason: message,
          },
          requireSample: false,
        });
        if (message === 'tenant-rate-limit-exceeded') {
          throw new HttpErrors.TooManyRequests(
            'Tenant request rate exceeded. Retry after a short delay.',
          );
        }
        if (message === 'tenant-concurrent-limit-exceeded') {
          throw new HttpErrors.TooManyRequests(
            'Tenant concurrent request limit exceeded. Retry after a short delay.',
          );
        }
        if (message === 'tenant-lease-refreshers-exhausted') {
          throw new HttpErrors.ServiceUnavailable(
            'Tenant throttling is temporarily saturated. Retry after a short delay.',
          );
        }
        throw error;
      }
    }

    resolveTenantId(): string {
      const resolver = this.cfg?.tenantResolver;
      if (!resolver) return 'default';
      try {
        const resolved = resolver(this.request);
        return resolved ?? 'default';
      } catch (error) {
        if (error instanceof HttpErrors.HttpError) {
          throw error;
        }
        const err = new HttpErrors.BadRequest('Unable to resolve tenant identifier from request.');
        (err as AnyObject).code = 'TenantResolutionFailed';
        throw err;
      }
    }

    tenantQuotasEnabled(): boolean {
      const quotas = this.cfg?.tenantQuotas;
      if (!quotas) return false;
      if (quotas.maxConcurrentRequests || quotas.maxRequestsPerMinute) return true;
      return Object.values(quotas.overrides ?? {}).some((override) =>
        Boolean(override?.maxConcurrentRequests || override?.maxRequestsPerMinute),
      );
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
        const condition =
          expected.length > 1 ? { [property]: { inq: expected } } : { [property]: expected[0] };
        return { and: [idWhere, condition] } as Filter<CrudEntity>['where'];
      }

      const compositeConditions = expected
        .filter(
          (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
        )
        .map((token) => {
          const clauses = (etagProperties ?? []).map((prop) => ({
            [prop]: (token as Record<string, unknown>)[prop],
          }));
          if (!clauses.length) return undefined;
          if (clauses.length === 1) return clauses[0];
          return { and: clauses };
        })
        .filter((value): value is Record<string, unknown> => Boolean(value));

      if (!compositeConditions.length) this.throwPreconditionFailed();

      const condition =
        compositeConditions.length === 1 ? compositeConditions[0] : { or: compositeConditions };

      return { and: [idWhere, condition] } as Filter<CrudEntity>['where'];
    }

    parseIfMatchHeader() {
      const raw =
        this.request.get('If-Match') ?? (this.request.headers?.['if-match'] as string | undefined);
      return parseIfMatch(raw);
    }

    parseIfNoneMatchHeader() {
      const raw =
        this.request.get('If-None-Match') ??
        (this.request.headers?.['if-none-match'] as string | undefined);
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

    hookMatches(
      op: CrudOperation,
      scope: CrudScope | undefined,
      meta: { op: CrudOperation; scope?: CrudScope },
    ): boolean {
      if (meta.op !== op) return false;
      if (op !== 'READ') return true;
      if (!meta.scope) return true;
      return meta.scope === scope;
    }

    getRequestTelemetryState(): ODataRequestState | undefined {
      if (this.requestStateCache !== undefined) {
        return this.requestStateCache ?? undefined;
      }
      try {
        const state = this.httpCtx.getSync(ODATA_BINDINGS.REQUEST_STATE, {
          optional: true,
        }) as ODataRequestState | undefined;
        this.requestStateCache = state ?? null;
      } catch {
        this.requestStateCache = null;
      }
      return this.requestStateCache ?? undefined;
    }

    emitTelemetry(event: TelemetryEventOptions): void {
      emitTelemetryEvent(this.logger, this.getRequestTelemetryState(), event);
    }

    recordTelemetryStats(update: StatisticsUpdate): void {
      recordStatistics(this.getRequestTelemetryState(), update);
    }

    includeApplyPlanInTelemetry(): boolean {
      return Boolean(this.getRequestTelemetryState()?.telemetry?.includeApplyPlanOnFallback);
    }

    wrapRepository(repo: CrudRepo): CrudRepo {
      const self = this;
      return new Proxy(repo, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          const methodName = String(prop);
          if (!DB_METHODS.has(methodName)) {
            return value.bind(target);
          }
          return function (...args: unknown[]) {
            return self.trackDbOperation(methodName, () => value.apply(target, args));
          };
        },
      });
    }

    async trackDbOperation<T>(operation: string, fn: () => Promise<T>): Promise<T> {
      const startedAt = process.hrtime.bigint();
      try {
        const result = await fn();
        this.recordTelemetryStats({
          dbTimeNs: process.hrtime.bigint() - startedAt,
          roundTripsIncrement: 1,
        });
        return result;
      } catch (error) {
        this.recordTelemetryStats({
          dbTimeNs: process.hrtime.bigint() - startedAt,
          roundTripsIncrement: 1,
        });
        throw error;
      }
    }

    getHookMethods(op: CrudOperation, scope?: CrudScope) {
      const before = (hooks?.before ?? [])
        .filter((h) => this.hookMatches(op, scope, h))
        .map((h) => h.methodName);
      const after = (hooks?.after ?? [])
        .filter((h) => this.hookMatches(op, scope, h))
        .map((h) => h.methodName);
      const on = (hooks?.on ?? []).find((h) => this.hookMatches(op, scope, h))?.methodName;
      return { before, after, on };
    }

    emitHookTelemetry(
      phase: 'before' | 'after' | 'on',
      op: CrudOperation,
      scope: CrudScope | undefined,
      hookName: string,
      startedAt: bigint,
      error?: Error,
    ): void {
      const durationNs = process.hrtime.bigint() - startedAt;
      const durationMs = Number(durationNs) / 1e6;
      this.emitTelemetry({
        category: 'hooks',
        event: `hook.${phase}`,
        level: error ? 'warn' : 'debug',
        context: {
          entitySet: setName,
          operation: op,
          scope,
          hookName,
          status: error ? 'error' : 'completed',
          durationMs,
        },
        error,
      });
    }

    emitTokenTelemetry(
      tokenType: 'skip' | 'delta',
      status: 'valid' | 'invalid' | 'expired' | 'legacy-denied',
      context?: Record<string, unknown>,
    ): void {
      this.emitTelemetry({
        category: 'tokens',
        event: 'token.validation',
        level: status === 'valid' ? 'debug' : 'warn',
        context: {
          tokenType,
          status,
          ...(context ?? {}),
        },
      });
    }

    buildHookContext(base: Partial<CrudHookContext>): CrudHookContext {
      return {
        operation: base.operation!,
        scope: base.scope,
        entitySet: def as unknown as any,
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
      return Object.assign({} as CrudOnContext, ctx, { helpers });
    }

    helpersForEntity(entityContextStr: string, operation?: CrudOperation) {
      const self = this;
      return {
        entity(plain: AnyObject | undefined) {
          self.ensureODataHeaders();
          if (plain) self.setEtagHeaderFromPlain(plain);
          const etag = self.computeEtagFromPlain(plain);
          const decorated = self.decoratePlainEntity(plain ?? {}, etag);
          if (operation === 'CREATE' && !self.response.headersSent) {
            const entityId = self.extractEntityId(plain ?? decorated);
            const entityUrl = self.buildEntityLocationUrl(entityId, plain ?? decorated);
            if (entityUrl) {
              self.setEntityLocationHeaders(entityUrl);
            }
            self.response.status(201);
          }
          return {
            '@odata.context': entityContextStr,
            ...decorated,
          } as AnyObject;
        },
        collection(items: Array<AnyObject | Entity>, totalCount?: number) {
          self.ensureODataHeaders();
          const values = items.map((it) => self.toPlainEntity(it as any) ?? (it as AnyObject));
          const decorated = self.decoratePlainEntities(values);
          return {
            '@odata.context': contextBase,
            ...(totalCount !== undefined ? { '@odata.count': totalCount } : {}),
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
      if (!hooks?.before?.length) return;
      const source = await this.resolveSourceController();
      if (!source) return;
      const names = this.getHookMethods(op, scope).before;
      for (const name of names) {
        if (typeof source[name] === 'function') {
          const startedAt = process.hrtime.bigint();
          try {
            await source[name](ctx);
            this.emitHookTelemetry('before', op, scope, name, startedAt);
          } catch (error) {
            this.emitHookTelemetry('before', op, scope, name, startedAt, error as Error);
            throw error;
          }
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
      const startedAt = process.hrtime.bigint();
      try {
        const result = await source[name](onCtx, wrappedNext);
        this.emitHookTelemetry('on', op, scope, name, startedAt);
        if (!nextCalled) return result;
        return result ?? onCtx.result;
      } catch (error) {
        this.emitHookTelemetry('on', op, scope, name, startedAt, error as Error);
        throw error;
      }
    }

    async runAfter(op: CrudOperation, scope: CrudScope | undefined, ctx: CrudHookContext) {
      if (this.response.headersSent) return; // don't mutate after commit
      if (!hooks?.after?.length) return;
      const source = await this.resolveSourceController();
      if (!source) return;
      const names = this.getHookMethods(op, scope).after;
      for (const name of names) {
        if (typeof source[name] !== 'function') continue;
        const startedAt = process.hrtime.bigint();
        let maybe: unknown;
        try {
          maybe = await source[name](ctx);
          this.emitHookTelemetry('after', op, scope, name, startedAt);
        } catch (error) {
          this.emitHookTelemetry('after', op, scope, name, startedAt, error as Error);
          throw error;
        }
        if (maybe !== undefined) {
          ctx.result = maybe;
        }
      }
    }

    @get(
      `/odata/${setName}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `List ${setName}`,
              content: { 'application/json': { schema: collectionResponseSchema } },
            },
          },
        },
        operationVisibility,
      ),
    )
    async list(@filterParam filter?: Filter<CrudEntity>) {
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

      const baseFilter: Filter<CrudEntity> = filter ? { ...filter } : {};
      const applySupported = this.isApplyEnabled();
      const aggregationEnabled = Boolean(
        def.capabilities?.aggregation ?? this.cfg?.capabilities?.aggregation,
      );
      let hadClientExpand = false;

      let inlineCountRequested = false;
      let aggregationSpec: AggregationSpec | undefined;
      let applyPipeline: ApplyPipeline | undefined;
      let applyPlan: ApplyExecutionPlan | undefined;
      let lambdaExpression: LambdaExpression | undefined;
      let postFilterExpr: ParsedExpression | undefined;
      let unsupportedFunctions: string[] = [];
      let deltaTokenValue: string | undefined;
      let deltaEnabled = false;
      let deltaField: string | undefined;
      let deltaLinkToken: string | undefined;
      let skipTokenValue: string | undefined;
      let computeExpressions: ComputeExpression[] | undefined;
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
        deltaTokenValue = parsed.deltaToken;
        applyPipeline = parsed.applyPipeline;
        this.enforceApplyCapability(applySupported, parsed);
        if (applyPipeline) {
          applyPlan = buildApplyExecutionPlan(applyPipeline, {
            strict: Boolean(this.cfg?.strict),
            modelCtor,
            maxNavigationDepth: this.cfg?.maxExpandDepth ?? 5,
          });
          const pipelineHasOrder = this.planHasInternalOrder(applyPlan);
          if (
            pipelineHasOrder &&
            externalOrder &&
            (Array.isArray(externalOrder) ? externalOrder.length : true)
          ) {
            throw new HttpErrors.BadRequest(
              'Combining $orderby outside $apply with orderby() inside the pipeline is not supported.',
            );
          }
          this.validateApplyPlanFields(applyPlan);
        }
        computeExpressions = parsed.compute;
        const primaryStage = this.findFirstPlanStage(applyPlan);
        aggregationSpec = primaryStage?.spec ?? parsed.apply;
        if (computeExpressions?.length && (aggregationSpec || applyPlan)) {
          throw new HttpErrors.BadRequest('Combining $compute with $apply is not supported.');
        }
        lambdaExpression = parsed.lambda;
        postFilterExpr = parsed.postFilter;
        unsupportedFunctions = parsed.unsupportedFunctions ?? [];
        skipTokenValue = parsed.skipToken;
        const computeAliases = computeExpressions?.map((item) => item.alias) ?? [];
        const computeDeps = this.collectComputeDependencies(computeExpressions);
        if (computeAliases.length && Array.isArray(externalOrder)) {
          const aliasOrdered = externalOrder.some((clause) => {
            const [field] = clause.split(/\s+/);
            return computeAliases.includes(field);
          });
          if (aliasOrdered) {
            throw new HttpErrors.BadRequest('$orderby on $compute aliases is not supported.');
          }
        }
        if (computeAliases.length && parsed.fields) {
          parsed.fields = this.stripComputedFields(
            parsed.fields as Filter<CrudEntity>['fields'],
            computeAliases,
          ) as typeof parsed.fields;
        }
        if (computeDeps.size) {
          parsed.fields = this.ensureComputeFieldProjection(
            parsed.fields as Filter<CrudEntity>['fields'],
            computeDeps,
          ) as typeof parsed.fields;
        }
        this.applyFormatPreference(parsed.format);
        if (postFilterExpr && unsupportedFunctions.length && this.cfg?.strict) {
          throw new HttpErrors.BadRequest(
            `Unsupported filter functions in strict mode: ${unsupportedFunctions.join(', ')}`,
          );
        }
        const splitWhere = this.splitWhereExpression(parsed.whereExpression);
        if (splitWhere.structuredExpr) {
          if (this.cfg?.strict) {
            this.validateParsedExpressionFields(splitWhere.structuredExpr, '$filter');
          }
          postFilterExpr = this.combinePostFilterExpressions(
            postFilterExpr,
            splitWhere.structuredExpr,
          );
        }
        if (splitWhere.repoExpr) {
          try {
            parsed.where = buildWhereFromParsedExpression(splitWhere.repoExpr) as CrudWhere;
          } catch (error) {
            if (error instanceof UnsupportedFilterError) {
              postFilterExpr = this.combinePostFilterExpressions(
                postFilterExpr,
                splitWhere.repoExpr,
              );
              const combined = [...(unsupportedFunctions ?? []), ...(error.functions ?? [])];
              unsupportedFunctions = Array.from(new Set(combined));
              delete parsed.where;
            } else {
              throw error;
            }
          }
        } else {
          delete parsed.where;
        }
        delete (parsed as { whereExpression?: ParsedExpression }).whereExpression;
        const parsedFilter = { ...parsed } as Filter<CrudEntity> & {
          inlineCount?: boolean;
          apply?: AggregationSpec;
          applyPipeline?: ApplyPipeline;
          lambda?: LambdaExpression;
          skipToken?: string;
          deltaToken?: string;
        };
        delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
        delete (parsedFilter as { apply?: AggregationSpec }).apply;
        delete (parsedFilter as { applyPipeline?: ApplyPipeline }).applyPipeline;
        delete (parsedFilter as { lambda?: LambdaExpression }).lambda;
        delete (parsedFilter as { postFilter?: ParsedExpression }).postFilter;
        delete (parsedFilter as { unsupportedFunctions?: string[] }).unsupportedFunctions;
        delete (parsedFilter as { skipToken?: string }).skipToken;
        delete (parsedFilter as { deltaToken?: string }).deltaToken;
        delete (parsedFilter as { format?: string }).format;
        delete (parsedFilter as { compute?: ComputeExpression[] }).compute;
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
            const additions = relationsToInclude.map((relation) => ({ relation }));
            baseFilter.include = mergeIncludes(
              baseFilter.include as InclusionFilter[] | undefined,
              additions,
            );
            ensureIncludeProjection(
              baseFilter as Filter<AnyObject>,
              baseFilter.include as InclusionFilter[] | undefined,
              modelRelations,
            );
          }
        } else if (aggregationSpec) {
          const fallbackSpec: AggregationSpec = {
            groupBy: [...aggregationSpec.groupBy],
            aggregates: aggregationSpec.aggregates.map((expr) => ({ ...expr })),
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
            const additions = relationsToInclude.map((relation) => ({ relation }));
            baseFilter.include = mergeIncludes(
              baseFilter.include as InclusionFilter[] | undefined,
              additions,
            );
            ensureIncludeProjection(
              baseFilter as Filter<AnyObject>,
              baseFilter.include as InclusionFilter[] | undefined,
              modelRelations,
            );
          }
        }
        this.ensureEtagField(baseFilter);
        // apply $search if present
        this.applySearch(baseFilter, (parsed as any).search);
        // enforce expand depth
        this.enforceExpandDepth((parsed as any).include as InclusionFilter[] | undefined);
      } catch (error) {
        if (error instanceof HttpErrors.HttpError) {
          throw error;
        }
        const message = (error as Error).message ?? 'Invalid OData query.';
        throw new HttpErrors.BadRequest(message);
      }

      let deltaPayload: DeltaTokenPayload | undefined;

      let deltaPreference = def.deltaEnabled;
      if (deltaPreference === undefined) {
        deltaPreference = this.cfg?.enableDelta;
      }
      deltaEnabled = Boolean(deltaPreference);
      deltaField = deltaEnabled ? (def.deltaField ?? etagProperties?.[0]) : undefined;
      if (deltaEnabled && !deltaField) {
        deltaEnabled = false;
      }
      if (deltaTokenValue) {
        const validation = validateDeltaToken({
          deltaEnabled,
          entitySet: setName,
          logger: this.logger,
          onTelemetry: (event) => {
            this.cfg?.onDeltaTokenInvalid?.(event);
            const status = event.code === 'expired' ? 'expired' : 'invalid';
            this.emitTokenTelemetry('delta', status, {
              entitySet: event.entitySet,
              code: event.code,
            });
          },
          decode: () => decodeDeltaToken(deltaTokenValue!, this.buildDeltaTokenOptions()),
        });
        if (!validation.ok) {
          this.throwDeltaValidationError(validation);
        } else {
          deltaPayload = validation.payload;
          this.emitTokenTelemetry('delta', 'valid', { entitySet: setName });
        }
      }

      if (aggregationSpec) {
        if (inlineCountRequested) {
          throw new HttpErrors.BadRequest('The $count option cannot be combined with $apply.');
        }
        if (hadClientExpand) {
          throw new HttpErrors.BadRequest(
            'The $expand option is not supported together with $apply.',
          );
        }
        if (!aggregationEnabled) {
          throw new HttpErrors.NotImplemented('Aggregations are not enabled for this entity set.');
        }
      }

      if (lambdaExpression) {
        if (aggregationSpec) {
          throw new HttpErrors.BadRequest(
            'Combining $apply with lambda expressions is not supported.',
          );
        }
        this.ensureLambdaInclusion(baseFilter, lambdaExpression);
      }

      const paginationLimits = this.getPaginationLimits();

      // Enforce maxTop if configured
      const maxTop = paginationLimits.maxTop;
      if (typeof maxTop === 'number') {
        const cap = maxTop;
        const requestedTopRaw = this.request.query?.['$top'] as string | undefined;
        const requested = requestedTopRaw != null ? Number(requestedTopRaw) : undefined;
        if (this.cfg?.strict && Number.isFinite(requested) && (requested as number) > cap) {
          throw new HttpErrors.BadRequest(
            `The $top value (${requested}) exceeds the maximum allowed (${cap}).`,
          );
        }
        if (!this.cfg?.strict) {
          const current = typeof baseFilter.limit === 'number' ? baseFilter.limit : undefined;
          if (current != null && current > cap) {
            this.logPaginationClamp('$top', current, cap, 'collection');
          }
          baseFilter.limit = current == null ? cap : Math.min(current, cap);
        }
      }

      this.ensureEtagField(baseFilter);
      this.ensureAcceptsJson();
      this.validateFieldsStrict(baseFilter);
      this.enforceSkipLimit(baseFilter, paginationLimits);

      const queryParams = this.request.query ?? {};
      const extractQueryValue = (value: unknown): string | undefined => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value) && value.length) {
          const [first] = value;
          return typeof first === 'string' ? first : String(first);
        }
        return undefined;
      };
      const clientSkipProvided = Object.prototype.hasOwnProperty.call(queryParams, '$skip');
      const clientTopRaw = extractQueryValue(queryParams['$top']);
      const clientTopNumber = clientTopRaw != null ? Number(clientTopRaw) : undefined;
      const clientTopProvided =
        Number.isFinite(clientTopNumber) && (clientTopNumber as number) > 0
          ? (clientTopNumber as number)
          : undefined;
      const skipApplied = typeof baseFilter.offset === 'number' && baseFilter.offset > 0;
      const explicitClientSkip = clientSkipProvided || skipApplied;
      if (explicitClientSkip && skipTokenValue) {
        throw new HttpErrors.BadRequest('$skip cannot be combined with $skiptoken.');
      }
      const manualPagingRequested =
        !skipTokenValue &&
        !aggregationSpec &&
        clientSkipProvided &&
        clientTopProvided !== undefined;

      if (deltaPayload && deltaField) {
        const deltaWhere = this.buildDeltaPredicate(
          deltaField,
          deltaPayload.lastValue,
          modelDefinition,
          idProperties,
          deltaPayload.keyValues,
        );
        baseFilter.where =
          this.combineWithAnd([baseFilter.where as CrudWhere | undefined, deltaWhere]) ??
          deltaWhere;
        deltaEnabled = true;
      }

      const originalTop = typeof baseFilter.limit === 'number' ? baseFilter.limit : undefined;
      const serverPagingEnabled = !aggregationSpec && !manualPagingRequested;
      let pageSize = serverPagingEnabled
        ? this.resolvePageSize(originalTop, {
            maxPageSize: paginationLimits.maxPageSize,
            context: 'collection',
          })
        : originalTop;
      let orderDescriptors: OrderDescriptor[] = [];
      if (serverPagingEnabled) {
        orderDescriptors = this.normalizeOrderDescriptors(
          baseFilter.order as Filter<CrudEntity>['order'],
          idProperties,
        );
        baseFilter.order = orderDescriptors.map((item) => `${item.field} ${item.direction}`);
        const skipConstraint = skipTokenValue
          ? this.buildSkipTokenConstraint(skipTokenValue, orderDescriptors, modelDefinition)
          : undefined;
        if (skipConstraint) {
          baseFilter.where =
            this.combineWithAnd([baseFilter.where as CrudWhere | undefined, skipConstraint]) ??
            skipConstraint;
        }
        pageSize =
          pageSize ??
          this.resolvePageSize(undefined, {
            maxPageSize: paginationLimits.maxPageSize,
            context: 'collection',
          });
        const effectiveOffset =
          typeof baseFilter.offset === 'number' && baseFilter.offset > 0
            ? Math.floor(baseFilter.offset)
            : 0;
        baseFilter.limit = (pageSize ?? 0) + 1;
        baseFilter.offset = effectiveOffset;
      } else if (manualPagingRequested) {
        const manualRequestedTop =
          typeof baseFilter.limit === 'number' ? baseFilter.limit : clientTopProvided;
        const manualPageSize = this.resolvePageSize(manualRequestedTop, {
          maxPageSize: paginationLimits.maxPageSize,
          context: 'collection',
        });
        baseFilter.limit = manualPageSize;
        orderDescriptors =
          this.ensureManualSkipOrderDeterminism(baseFilter as Filter<CrudEntity>, idProperties) ??
          orderDescriptors;
      }

      if (serverPagingEnabled && baseFilter.fields) {
        baseFilter.fields = this.ensureOrderProjection(baseFilter.fields, orderDescriptors);
      }

      if (!orderDescriptors.length) {
        orderDescriptors = this.normalizeOrderDescriptors(
          baseFilter.order as Filter<CrudEntity>['order'],
          idProperties,
        );
      }
      if (deltaEnabled && deltaField) {
        const deduped = orderDescriptors.filter((item) => item.field !== deltaField);
        orderDescriptors = [{ field: deltaField, direction: 'DESC' }, ...deduped];
        baseFilter.order = orderDescriptors.map((item) => `${item.field} ${item.direction}`);
        if (baseFilter.fields) {
          baseFilter.fields = this.ensureOrderProjection(baseFilter.fields, orderDescriptors);
        }
      }

      const requestedOffset = serverPagingEnabled
        ? 0
        : typeof baseFilter.offset === 'number'
          ? baseFilter.offset
          : 0;
      const requestedLimit = serverPagingEnabled
        ? pageSize
        : typeof baseFilter.limit === 'number'
          ? baseFilter.limit
          : undefined;
      const planRequiresPostProcessing = this.planRequiresPostProcessing(applyPlan);
      const requiresPostFilter = Boolean(postFilterExpr) || planRequiresPostProcessing;

      if (requiresPostFilter) {
        delete baseFilter.offset;
        delete baseFilter.limit;
      }

      const op: CrudOperation = 'READ';
      const scope: CrudScope = 'collection';
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        filter: baseFilter as any,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op, scope);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();

        if (aggregationSpec) {
          const finalStage = this.findFinalPlanStage(applyPlan);
          const applyOrderDescriptors = this.buildApplyOrderDescriptors(
            finalStage,
            aggregationSpec,
          );
          if (!applyOrderDescriptors.length) {
            throw new HttpErrors.BadRequest('Unable to derive ordering for $apply pagination.');
          }
          const applyTokenParts = this.parseApplySkipToken(skipTokenValue, applyOrderDescriptors);
          let applyPageSize = this.resolvePageSize(originalTop, {
            maxPageSize: paginationLimits.maxApplyPageSize ?? paginationLimits.maxPageSize,
            context: '$apply',
          });
          if (finalStage?.top != null) {
            applyPageSize = Math.min(applyPageSize, finalStage.top);
          }
          const fetchFilter: Filter<CrudEntity> = { ...baseFilter };
          delete fetchFilter.order;
          delete fetchFilter.limit;
          delete fetchFilter.offset;

          const stageCount = this.countApplyPlanStages(applyPlan);
          const primaryStage = applyPlan?.stages?.[0];
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
            primaryStage,
            0,
            stageCount || 1,
            {
              orderDescriptors: applyOrderDescriptors,
              skipTokenParts: applyTokenParts,
              pageSize: applyPageSize,
              stageTop: finalStage?.top,
              stageSkip: finalStage?.skip,
            },
          );
          if (pushdownResult) {
            let pushdownRows = Array.isArray(pushdownResult.value) ? pushdownResult.value : [];
            pushdownRows = pushdownRows.map((row) => this.decoratePlainEntity(row) ?? row);
            const bucketState = this.buildBucketState(finalStage?.spec.groupBy ?? [], pushdownRows);
            const aggregatedTombstones = deltaEnabled
              ? this.buildRemovedBuckets(
                  deltaPayload?.buckets,
                  pushdownRows,
                  finalStage?.spec.groupBy ?? [],
                )
              : [];
            const combinedRows = aggregatedTombstones.length
              ? [...pushdownRows, ...aggregatedTombstones]
              : pushdownRows;
            pushdownResult.value = combinedRows;
            if (deltaEnabled && deltaField) {
              const filteredPageRows = this.filterDeltaPageRows(combinedRows, deltaField);
              const applyDeltaToken = this.createDeltaTokenForRows(
                setName,
                pushdownRows,
                deltaField,
                [],
                deltaTokenValue,
                bucketState,
                filteredPageRows,
              );
              pushdownResult['@odata.deltaLink'] = this.buildDeltaLink(applyDeltaToken);
            }
            ctx.result = pushdownResult;
            return pushdownResult;
          }

          const entities = await this.repository.find(fetchFilter, options);
          const plainEntities = entities.map((entity) => this.toPlainEntity(entity) ?? {});
          let working = plainEntities;
          let lastStageHasOrder = false;
          let branchSegments: AnyObject[][] | undefined;
          const maxApplySize = this.cfg?.maxApplyResultSize;

          let planForFallback: ApplyExecutionPlan | undefined = applyPlan;
          if (!planForFallback && aggregationSpec) {
            const fallbackSpec: AggregationSpec = {
              groupBy: [...aggregationSpec.groupBy],
              aggregates: aggregationSpec.aggregates.map((expr) => ({ ...expr })),
            };
            planForFallback = {
              pushdownWhere: undefined,
              preAggregationFilters: [],
              stages: [
                {
                  spec: fallbackSpec,
                  postAggregationFilters: [],
                  navigationPaths: collectNavigationPathsForStage(
                    modelCtor,
                    fallbackSpec,
                    this.cfg?.maxExpandDepth ?? 5,
                  ),
                },
              ],
            };
          }

          if (planForFallback) {
            try {
              const fallbackOutcome = this.runApplyPlanFallback(planForFallback, working, {
                maxRows: maxApplySize,
              });
              working = fallbackOutcome.rows;
              lastStageHasOrder = fallbackOutcome.lastStageOrdered;
              branchSegments = fallbackOutcome.branchSegments;
            } catch (error) {
              if (error instanceof ApplyResultLimitExceededError) {
                this.logApplyFallback(
                  'limit-exceeded',
                  {
                    entitySet: setName,
                    transformations: applyPipeline?.transformations.length ?? 0,
                    rows: error.currentSize,
                    limit: error.limit,
                  },
                  planForFallback,
                );
              }
              throw error;
            }
          }

          if (postFilterExpr) {
            working = this.applyPostFilter(working, postFilterExpr);
            branchSegments = undefined;
          }

          this.logApplyFallback(
            'in-memory-apply',
            {
              entitySet: setName,
              transformations: applyPipeline?.transformations.length ?? 0,
              rows: working.length,
            },
            planForFallback,
          );
          if (
            typeof maxApplySize === 'number' &&
            maxApplySize > 0 &&
            working.length > maxApplySize
          ) {
            this.logApplyFallback(
              'limit-exceeded',
              {
                entitySet: setName,
                transformations: applyPipeline?.transformations.length ?? 0,
                rows: working.length,
                limit: maxApplySize,
              },
              planForFallback,
            );
            throw new HttpErrors.BadRequest(
              `$apply result exceeds the server limit of ${maxApplySize} records. Refine the query or increase maxApplyResultSize.`,
            );
          }

          const planIncludesConcat = this.planHasConcat(applyPlan);
          const orderClauses = applyOrderDescriptors.map(
            (item) => `${item.field} ${item.direction}`,
          );
          let paged: AnyObject[];
          let nextLinkToken: string | undefined;

          if (planIncludesConcat && branchSegments?.length) {
            const preservedCount = Math.max(branchSegments.length - 1, 0);
            let detailRows = branchSegments[branchSegments.length - 1] ?? [];

            if (!lastStageHasOrder && baseFilter.order) {
              detailRows = this.orderResults(detailRows, baseFilter.order);
            }
            detailRows = this.orderResults(detailRows, orderClauses);
            detailRows = this.filterRowsAfterSkipToken(
              detailRows,
              applyOrderDescriptors,
              applyTokenParts,
            );

            const pagination = this.applyServerDrivenPaging(
              detailRows,
              applyOrderDescriptors,
              applyPageSize,
            );
            const pagedDetail = pagination.items;
            if (preservedCount > 0) {
              const combined: AnyObject[] = [];
              for (let i = 0; i < preservedCount; i++) {
                combined.push(...branchSegments[i]);
              }
              combined.push(...pagedDetail);
              paged = combined;
            } else {
              paged = pagedDetail;
            }
            nextLinkToken = pagination.token;
          } else {
            let ordered = working;
            if (!lastStageHasOrder && baseFilter.order) {
              ordered = this.orderResults(working, baseFilter.order);
            }
            ordered = this.orderResults(ordered, orderClauses);
            ordered = this.filterRowsAfterSkipToken(
              ordered,
              applyOrderDescriptors,
              applyTokenParts,
            );

            const pagination = this.applyServerDrivenPaging(
              ordered,
              applyOrderDescriptors,
              applyPageSize,
            );
            paged = pagination.items;
            nextLinkToken = pagination.token;
          }

          this.ensureODataHeaders();
          const decorated = paged.map((item) => this.decoratePlainEntity(item) ?? item);
          const aggregatedTombstones = deltaEnabled
            ? this.buildRemovedBuckets(
                deltaPayload?.buckets,
                decorated,
                finalStage?.spec.groupBy ?? [],
              )
            : [];
          const bucketState = this.buildBucketState(finalStage?.spec.groupBy ?? [], decorated);
          const result = {
            '@odata.context': contextBase,
            value: aggregatedTombstones.length
              ? [...decorated, ...aggregatedTombstones]
              : decorated,
          } as AnyObject;
          if (nextLinkToken) {
            result['@odata.nextLink'] = this.buildNextLink(nextLinkToken);
          }
          if (deltaEnabled && deltaField) {
            const rawPageRows = Array.isArray(result.value)
              ? (result.value as AnyObject[])
              : decorated;
            const deltaPageRows = this.filterDeltaPageRows(rawPageRows, deltaField);
            const applyDeltaToken = this.createDeltaTokenForRows(
              setName,
              decorated,
              deltaField,
              [],
              deltaTokenValue,
              bucketState,
              deltaPageRows,
            );
            result['@odata.deltaLink'] = this.buildDeltaLink(applyDeltaToken);
          }
          ctx.result = result;
          return result;
        }

        if (lambdaExpression) {
          const fetchFilter: Filter<CrudEntity> = { ...baseFilter };
          delete fetchFilter.order;
          delete fetchFilter.limit;
          delete fetchFilter.offset;

          const entities = await this.repository.find(fetchFilter, options);
          const plainEntities = entities.map((entity) => this.toPlainEntity(entity) ?? {});
          let filtered = this.filterEntitiesByLambda(plainEntities, lambdaExpression);
          if (requiresPostFilter) {
            filtered = this.applyPostFilter(filtered, postFilterExpr);
          }
          this.applyComputeExpressions(filtered, computeExpressions);
          const ordered = this.orderResults(filtered, baseFilter.order);
          const paged = this.sliceResults(ordered, requestedOffset, requestedLimit);

          this.ensureODataHeaders();
          const result = {
            '@odata.context': contextBase,
            value: this.decoratePlainEntities(paged),
          } as AnyObject;
          this.recordTelemetryStats({ rows: paged.length });
          ctx.result = result;
          return result;
        }

        const results = await this.repository.find(baseFilter, options);
        let workingResults = results.map((entity) => this.toPlainEntity(entity) ?? {});

        if (applyPlan && !aggregationSpec) {
          try {
            const outcome = this.runApplyPlanFallback(applyPlan, workingResults, {
              maxRows: this.cfg?.maxApplyResultSize,
            });
            workingResults = outcome.rows;
          } catch (error) {
            if (error instanceof ApplyResultLimitExceededError) {
              this.logApplyFallback(
                'limit-exceeded',
                {
                  entitySet: setName,
                  transformations: applyPipeline?.transformations.length ?? 0,
                  rows: error.currentSize,
                  limit: error.limit,
                },
                applyPlan,
              );
            }
            throw error;
          }
        }

        const filteredResults = requiresPostFilter
          ? this.applyPostFilter(workingResults, postFilterExpr)
          : workingResults;
        this.applyComputeExpressions(filteredResults, computeExpressions);
        let totalCount: number | undefined;
        const tombstoneKeys = deltaPayload?.pageKeys?.length
          ? deltaPayload.pageKeys
          : deltaPayload?.keyValues
            ? [deltaPayload.keyValues]
            : undefined;
        const tombstones =
          deltaEnabled && tombstoneKeys?.length ? await this.computeTombstones(tombstoneKeys) : [];

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
          const effectivePageSize =
            pageSize ??
            this.resolvePageSize(undefined, {
              maxPageSize: paginationLimits.maxPageSize,
              context: 'collection',
            });
          const pagination = this.applyServerDrivenPaging(
            ordered,
            orderDescriptors,
            effectivePageSize,
          );
          paged = pagination.items;
          nextLinkToken = pagination.token;
        } else if (requiresPostFilter) {
          paged = this.sliceResults(ordered, requestedOffset, requestedLimit);
        } else {
          paged = ordered;
        }

        if (deltaEnabled && deltaField) {
          deltaLinkToken = this.createDeltaTokenForRows(
            setName,
            ordered,
            deltaField,
            idProperties,
            deltaTokenValue,
            undefined,
            paged,
          );
        }

        this.ensureODataHeaders();
        const decorated = this.decoratePlainEntities(paged);
        const combined = tombstones.length ? [...decorated, ...tombstones] : decorated;
        this.recordTelemetryStats({ rows: combined.length });
        const result = {
          '@odata.context': contextBase,
          ...(inlineCountRequested ? { '@odata.count': totalCount ?? filteredResults.length } : {}),
          value: combined,
        } as AnyObject;
        if (serverPagingEnabled && nextLinkToken) {
          result['@odata.nextLink'] = this.buildNextLink(nextLinkToken);
        }
        if (deltaEnabled && deltaLinkToken) {
          result['@odata.deltaLink'] = this.buildDeltaLink(deltaLinkToken);
        }
        ctx.result = result;
        return result;
      };

      const helpers = this.helpersForEntity(entityContext, op);
      const onCtx = this.buildOnContext(ctx, helpers);
      const res = await this.runOn(op, scope, onCtx, execDefault);
      ctx.result = res;
      await this.runAfter(op, scope, ctx);
      return ctx.result as AnyObject;
    }

    @get(
      `/odata/${setName}/$count`,
      withODataSpecMetadata(
        {
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
        },
        operationVisibility,
      ),
    )
    async count() {
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

      if (this.cfg && this.cfg.enableCount === false) {
        throw new HttpErrors.NotImplemented(
          'Standalone $count is disabled by server configuration.',
        );
      }

      const baseFilter: Filter<CrudEntity> = {};
      const applySupported = this.isApplyEnabled();
      let postFilterExpr: ParsedExpression | undefined;
      let unsupportedFunctions: string[] = [];

      try {
        const parsed = parseODataQuery(
          this.request.query as Record<string, string | string[] | undefined>,
          { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
        );
        this.enforceApplyCapability(applySupported, parsed);
        if (parsed.format) {
          const err = new HttpErrors.NotAcceptable(
            '$format is not supported for $count responses.',
          );
          (err as any).code = 'NotAcceptable';
          throw err;
        }
        if (parsed.compute?.length) {
          throw new HttpErrors.BadRequest('$compute is not supported for $count responses.');
        }
        const splitWhere = this.splitWhereExpression(parsed.whereExpression);
        if (splitWhere.structuredExpr) {
          if (this.cfg?.strict) {
            this.validateParsedExpressionFields(splitWhere.structuredExpr, '$filter');
          }
          postFilterExpr = this.combinePostFilterExpressions(
            postFilterExpr,
            splitWhere.structuredExpr,
          );
        }
        if (splitWhere.repoExpr) {
          try {
            parsed.where = buildWhereFromParsedExpression(splitWhere.repoExpr) as CrudWhere;
          } catch (error) {
            if (error instanceof UnsupportedFilterError) {
              postFilterExpr = this.combinePostFilterExpressions(
                postFilterExpr,
                splitWhere.repoExpr,
              );
              const combined = [...(unsupportedFunctions ?? []), ...(error.functions ?? [])];
              unsupportedFunctions = Array.from(new Set(combined));
              delete parsed.where;
            } else {
              throw error;
            }
          }
        } else {
          delete parsed.where;
        }
        delete (parsed as { whereExpression?: ParsedExpression }).whereExpression;
        const parsedFilter = { ...parsed } as Filter<CrudEntity> & { inlineCount?: boolean };
        delete (parsedFilter as { inlineCount?: boolean }).inlineCount;
        postFilterExpr = parsed.postFilter;
        unsupportedFunctions = parsed.unsupportedFunctions ?? [];
        if (postFilterExpr && unsupportedFunctions.length && this.cfg?.strict) {
          throw new HttpErrors.BadRequest(
            `Unsupported filter functions in strict mode: ${unsupportedFunctions.join(', ')}`,
          );
        }
        delete (parsedFilter as { postFilter?: ParsedExpression }).postFilter;
        delete (parsedFilter as { unsupportedFunctions?: string[] }).unsupportedFunctions;
        delete (parsedFilter as { compute?: ComputeExpression[] }).compute;
        delete (parsedFilter as { format?: string }).format;
        this.mergeFilters(baseFilter, parsedFilter);
        this.applySearch(baseFilter, (parsed as any).search);
        this.enforceExpandDepth((parsed as any).include as InclusionFilter[] | undefined);
      } catch (error) {
        if (error instanceof HttpErrors.HttpError) {
          throw error;
        }
        const message = (error as Error).message ?? 'Invalid OData query.';
        throw new HttpErrors.BadRequest(message);
      }

      this.ensureAcceptsJson(['text/plain']);
      this.response.type('text/plain');
      this.validateFieldsStrict(baseFilter);

      const op: CrudOperation = 'READ';
      const scope: CrudScope = 'count';
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        filter: baseFilter as any,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op, scope);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        if (postFilterExpr) {
          const entities = await this.repository.find(baseFilter, options);
          const plain = entities.map((entity) => this.toPlainEntity(entity) ?? {});
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

      const helpers = this.helpersForEntity(entityContext, op);
      const onCtx = this.buildOnContext(ctx, helpers);
      const res = await this.runOn(op, scope, onCtx, execDefault);
      ctx.result = res;
      await this.runAfter(op, scope, ctx);
      return ctx.result as string;
    }

    @get(
      `/odata/${setName}/{id}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `${setName} entity by id`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
          },
        },
        operationVisibility,
      ),
    )
    async findById(
      @idParam id: unknown,
      @filterExcludingWhereParam filter?: FilterExcludingWhere<CrudEntity>,
    ) {
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

      const baseFilter: FilterExcludingWhere<CrudEntity> = filter ? { ...filter } : {};
      const applySupported = this.isApplyEnabled();
      const options = this.repositoryOptions();
      this.ensureEtagField(baseFilter as Filter<CrudEntity>);
      const ifNoneMatch = this.parseIfNoneMatchHeader();
      let postFilterExpr: ParsedExpression | undefined;
      let unsupportedFunctions: string[] = [];
      let computeExpressions: ComputeExpression[] | undefined;

      try {
        const parsed = parseODataQuery(
          this.request.query as Record<string, string | string[] | undefined>,
          { relations: modelRelations, strict: Boolean(this.cfg?.strict) },
        );
        this.enforceApplyCapability(applySupported, parsed);
        this.applyFormatPreference(parsed.format);
        computeExpressions = parsed.compute;
        postFilterExpr = parsed.postFilter;
        unsupportedFunctions = parsed.unsupportedFunctions ?? [];
        if (postFilterExpr && unsupportedFunctions.length && this.cfg?.strict) {
          throw new HttpErrors.BadRequest(
            `Unsupported filter functions in strict mode: ${unsupportedFunctions.join(', ')}`,
          );
        }
        const sanitized: Filter<CrudEntity> = {};
        if (parsed.fields) {
          const aliases = computeExpressions?.map((expr) => expr.alias) ?? [];
          const adjusted = aliases.length
            ? this.stripComputedFields(parsed.fields as Filter<CrudEntity>['fields'], aliases)
            : parsed.fields;
          if (adjusted) sanitized.fields = adjusted;
          const dependencies = this.collectComputeDependencies(computeExpressions);
          if (dependencies.size) {
            sanitized.fields = this.ensureComputeFieldProjection(sanitized.fields, dependencies);
          }
        }
        if (parsed.include) sanitized.include = parsed.include;
        this.mergeFilters(baseFilter as Filter<CrudEntity>, sanitized);
        this.ensureEtagField(baseFilter as Filter<CrudEntity>);
        this.applySearch(baseFilter as Filter<CrudEntity>, (parsed as any).search);
        this.enforceExpandDepth((parsed as any).include as InclusionFilter[] | undefined);
      } catch (error) {
        if (error instanceof HttpErrors.HttpError) {
          throw error;
        }
        const message = (error as Error).message ?? 'Invalid OData query.';
        throw new HttpErrors.BadRequest(message);
      }

      this.ensureAcceptsJson();
      this.validateFieldsStrict(baseFilter as Filter<CrudEntity>);
      this.enforceSkipLimit(baseFilter as Filter<CrudEntity>);

      const entityId = this.coerceParentId(id);
      const op: CrudOperation = 'READ';
      const scope: CrudScope = 'entity';
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        id: entityId,
        filter: baseFilter as any,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op, scope);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        const entity = await this.repository.findById(entityId as any, baseFilter, options);
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

        this.applyComputeExpressions([plain], computeExpressions);
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

      const helpers = this.helpersForEntity(entityContext, op);
      const onCtx = this.buildOnContext(ctx, helpers);
      const res = await this.runOn(op, scope, onCtx, execDefault);
      ctx.result = res;
      if (!this.response.headersSent) {
        await this.runAfter(op, scope, ctx);
      }
      return ctx.result as AnyObject | undefined;
    }

    @get(
      `/odata/${setName}/{id}/$value`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `${setName} media stream`,
              content: {
                'application/octet-stream': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
            '204': { description: 'Stream is empty.' },
            '304': { description: 'Not Modified' },
          },
        },
        operationVisibility,
      ),
    )
    async getMediaValue(@idParam id: unknown) {
      if (!hasStream) {
        throw new HttpErrors.NotFound('Media stream is not configured for this entity set.');
      }
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');
      const baseFilter: Filter<CrudEntity> = {
        fields: this.buildMediaProjectionFields(),
      };
      this.ensureEtagField(baseFilter);
      const ifNoneMatch = this.parseIfNoneMatchHeader();
      const entityId = this.coerceParentId(id);
      const op: CrudOperation = 'READ';
      const scope: CrudScope = 'entity';
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        id: entityId,
        filter: baseFilter as any,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op, scope);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        const entity = await this.repository.findById(entityId as any, baseFilter, options);
        const plain = this.toPlainEntity(entity) ?? {};
        const storedContentType = this.readMediaContentType(plain);
        const mediaEtag = this.readMediaEtag(plain);

        if (
          ifNoneMatch &&
          !ifNoneMatch.any &&
          mediaEtag &&
          matchesEtag(mediaEtag, ifNoneMatch.values)
        ) {
          this.ensureMediaAccepts(storedContentType);
          this.ensureODataHeaders();
          this.setMediaEtagHeader(plain);
          this.response.status(304).end();
          return undefined;
        }

        const handler = await this.requireMediaHandler();
        const result = await handler.read({
          id: entityId,
          entitySet: def,
          entity: plain,
          repository: this.repository as unknown as DefaultCrudRepository<CrudEntity, unknown>,
          options,
        });

        this.ensureODataHeaders();
        this.setMediaEtagHeader(plain);

        if (!result) {
          this.response.status(204).end();
          return undefined;
        }

        const contentType = result.contentType ?? storedContentType ?? 'application/octet-stream';
        this.ensureMediaAccepts(contentType);
        const length = result.length ?? this.readMediaLength(plain);
        this.response.type(contentType);
        if (typeof length === 'number' && Number.isFinite(length)) {
          this.response.set('Content-Length', `${length}`);
        }

        await this.streamToResponse(result.stream);
        this.logMediaTelemetry('media.read', {
          entityId,
          bytes: length,
          contentType,
        });
        return undefined;
      };

      const result = await execDefault();
      ctx.result = result;
      if (!this.response.headersSent) {
        await this.runAfter(op, scope, ctx);
      }
      return ctx.result as unknown;
    }

    @put(
      `/odata/${setName}/{id}/$value`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `${setName} media updated (representation)`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
            '204': { description: `${setName} media updated.` },
          },
        },
        operationVisibility,
      ),
    )
    async replaceMediaValue(
      @idParam id: unknown,
      @requestBody({
        required: true,
        content: mediaRequestContent ?? {
          'application/octet-stream': buildStreamEntry(),
          'text/plain': buildStreamEntry(),
          '*/*': buildStreamEntry(),
        },
      })
      body: Buffer | Readable,
    ) {
      if (!hasStream) {
        throw new HttpErrors.NotFound('Media stream is not configured for this entity set.');
      }
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');
      const contentType = this.ensureMediaContentType();
      const entityId = this.coerceParentId(id);
      const op: CrudOperation = 'UPDATE';
      const scope: CrudScope = 'entity';
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        id: entityId,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op, scope);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        const baseFilter: Filter<CrudEntity> = { fields: this.buildMediaProjectionFields() };
        this.ensureEtagField(baseFilter);
        const entity = await this.repository.findById(entityId as any, baseFilter, options);
        let plain = this.toPlainEntity(entity) ?? {};
        const ifMatch = this.parseIfMatchHeader();
        const requireEtag = (this.etagEnabled() || Boolean(mediaEtagField)) && this.cfg?.strict;
        const currentEtag = this.readMediaEtag(plain);
        if (requireEtag && !ifMatch) {
          const error = new HttpErrors.PreconditionRequired(
            'If-Match header is required when ETags are enabled.',
          );
          (error as any).code = 'PreconditionRequired';
          throw error;
        }
        if (
          ifMatch &&
          !ifMatch.any &&
          currentEtag &&
          !matchesEtag(currentEtag, ifMatch.values ?? [])
        ) {
          this.throwPreconditionFailed();
        }

        const handler = await this.requireMediaHandler();
        const stream = this.coerceBodyToStream(body);
        const contentLengthHeader = this.request.headers['content-length'];
        const contentLengthValue =
          typeof contentLengthHeader === 'string' && contentLengthHeader.trim()
            ? Number(contentLengthHeader)
            : undefined;
        const httpContentLength = Number.isFinite(contentLengthValue)
          ? Number(contentLengthValue)
          : undefined;

        const writeResult = await handler.write({
          id: entityId,
          entitySet: def,
          entity: plain,
          repository: this.repository as unknown as DefaultCrudRepository<CrudEntity, unknown>,
          options,
          stream,
          contentType,
          contentLength: httpContentLength,
        });

        const overrides = {
          contentType,
          contentLength: httpContentLength,
        };
        const resolvedMetadata = this.resolveMediaMetadata(writeResult, overrides);
        const metadataUpdates = await this.applyMediaMetadataUpdates(
          entityId,
          writeResult,
          overrides,
          resolvedMetadata,
        );
        if (metadataUpdates) {
          plain = this.mergeMediaMetadata(plain, metadataUpdates);
        }

        this.ensureODataHeaders();
        this.setMediaEtagHeader(plain);
        const reportedLength = resolvedMetadata.length;
        const telemetryContentType = resolvedMetadata.contentType ?? contentType;
        this.logMediaTelemetry('media.write', {
          entityId,
          bytes: reportedLength,
          contentType: telemetryContentType,
        });

        const preference = preferences.returnPreference;
        if (preference === 'representation') {
          this.ensureAcceptsJson();
          const reloaded = await this.repository.findById(entityId as any, undefined, options);
          const responsePlain = this.toPlainEntity(reloaded) ?? plain;
          const entityEtag = this.computeEtagFromPlain(responsePlain);
          const decorated = this.decoratePlainEntity(responsePlain, entityEtag);
          this.applyPreference(preference);
          this.response.status(200);
          this.setEtagHeaderFromPlain(responsePlain);
          this.setMediaEtagHeader(responsePlain);
          const result = {
            '@odata.context': entityContext,
            ...decorated,
          } as AnyObject;
          ctx.result = result;
          return result;
        }

        this.response.status(204);
        this.applyPreference(preference);
        return undefined;
      };

      const result = await execDefault();
      ctx.result = result;
      if (!this.response.headersSent) {
        await this.runAfter(op, scope, ctx);
      }
      return ctx.result as AnyObject | undefined;
    }

    @del(
      `/odata/${setName}/{id}/$value`,
      withODataSpecMetadata(
        {
          responses: {
            '204': { description: `${setName} media deleted.` },
          },
        },
        operationVisibility,
      ),
    )
    async deleteMediaValue(@idParam id: unknown) {
      if (!hasStream) {
        throw new HttpErrors.NotFound('Media stream is not configured for this entity set.');
      }
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');
      const entityId = this.coerceParentId(id);
      const op: CrudOperation = 'DELETE';
      const scope: CrudScope = 'entity';
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        id: entityId,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op, scope);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        const baseFilter: Filter<CrudEntity> = { fields: this.buildMediaProjectionFields() };
        this.ensureEtagField(baseFilter);
        const entity = await this.repository.findById(entityId as any, baseFilter, options);
        const plain = this.toPlainEntity(entity) ?? {};
        const ifMatch = this.parseIfMatchHeader();
        const requireEtag = (this.etagEnabled() || Boolean(mediaEtagField)) && this.cfg?.strict;
        const currentEtag = this.readMediaEtag(plain);
        if (requireEtag && !ifMatch) {
          const error = new HttpErrors.PreconditionRequired(
            'If-Match header is required when ETags are enabled.',
          );
          (error as any).code = 'PreconditionRequired';
          throw error;
        }
        if (
          ifMatch &&
          !ifMatch.any &&
          currentEtag &&
          !matchesEtag(currentEtag, ifMatch.values ?? [])
        ) {
          this.throwPreconditionFailed();
        }

        const handler = await this.requireMediaHandler();
        if (typeof handler.delete !== 'function') {
          throw new HttpErrors.NotImplemented('Media handler does not support delete.');
        }
        await handler.delete({
          id: entityId,
          entitySet: def,
          entity: plain,
          repository: this.repository as unknown as DefaultCrudRepository<CrudEntity, unknown>,
          options,
        });
        await this.clearMediaMetadata(entityId);
        this.ensureODataHeaders();
        this.response.status(204).end();
        this.logMediaTelemetry('media.delete', { entityId });
        return undefined;
      };

      const result = await execDefault();
      ctx.result = result;
      if (!this.response.headersSent) {
        await this.runAfter(op, scope, ctx);
      }
      return ctx.result as unknown;
    }

    @get(
      `/odata/${setName}/{id}/{property}/$value`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `Raw property value for ${setName}`,
              content: {
                'text/plain': { schema: { type: 'string' } },
                'application/octet-stream': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
            '204': { description: 'Property is null.' },
            '304': { description: 'Not Modified' },
          },
        },
        operationVisibility,
      ),
    )
    async getPropertyValue(@idParam id: unknown, @param.path.string('property') property: string) {
      const propertyName = property;
      if (!propertyName) {
        throw new HttpErrors.BadRequest('Property name is required.');
      }
      if (modelRelations && Object.prototype.hasOwnProperty.call(modelRelations, propertyName)) {
        throw new HttpErrors.NotFound('Property does not expose a scalar $value.');
      }
      const definition = (modelDefinition?.properties ?? {})[propertyName] as
        | PropertyDefinition
        | undefined;
      if (!definition) {
        throw new HttpErrors.NotFound('Property not found.');
      }
      const primitiveKind = classifyPrimitiveProperty(definition);
      if (!primitiveKind) {
        throw new HttpErrors.NotFound('Property does not expose a scalar $value.');
      }

      const baseFilter: Filter<CrudEntity> = {
        fields: { [propertyName]: true },
      };
      this.ensureEtagField(baseFilter);

      const ifNoneMatch = this.parseIfNoneMatchHeader();
      const entityId = this.coerceParentId(id);
      const op: CrudOperation = 'READ';
      const scope: CrudScope = 'entity';
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        id: entityId,
        filter: baseFilter as any,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op, scope);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        const entity = await this.repository.findById(entityId as any, baseFilter, options);
        const plain = this.toPlainEntity(entity) ?? {};
        const etag = this.computeEtagFromPlain(plain);

        if (ifNoneMatch && !ifNoneMatch.any && etag && matchesEtag(etag, ifNoneMatch.values)) {
          this.ensureODataHeaders();
          this.setEtagHeaderFromPlain(plain);
          this.response.status(304).end();
          return undefined;
        }

        const rawValue = (plain as AnyObject)[propertyName];
        this.ensureODataHeaders();
        this.setEtagHeaderFromPlain(plain);

        if (rawValue === null || rawValue === undefined) {
          this.response.status(204).end();
          return undefined;
        }

        const serialized = this.serializePrimitiveValue(rawValue, primitiveKind);
        this.response.type(serialized.contentType);
        this.response.send(serialized.body);
        ctx.result = rawValue;
        return rawValue;
      };

      const result = await execDefault();
      ctx.result = result;
      if (!this.response.headersSent) {
        await this.runAfter(op, scope, ctx);
      }
      return ctx.result as unknown;
    }

    @post(
      `/odata/${setName}`,
      withODataSpecMetadata(
        {
          responses: {
            '201': {
              description: `Create ${setName} entity`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
            '204': {
              description: `Create ${setName} entity (minimal response)`,
            },
          },
        },
        operationVisibility,
      ),
    )
    async create(
      @requestBody({
        content: createRequestContent,
      })
      payload: CrudEntity | Buffer | Readable,
    ) {
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');
      this.ensureAcceptsJson();
      const bodyIsBinary = hasStream && !this.isJsonBodyRequest();
      const mediaContentType = bodyIsBinary ? this.ensureMediaContentType() : undefined;
      const mediaStream = bodyIsBinary ? this.coerceBodyToStream(payload) : undefined;
      if (!bodyIsBinary) {
        this.ensureJsonContentType();
      }
      const slugHeader = bodyIsBinary ? this.getSlugHeader() : undefined;
      const contentLengthHeader =
        bodyIsBinary && typeof this.request.headers['content-length'] === 'string'
          ? this.request.headers['content-length']
          : undefined;
      const contentLengthValue =
        bodyIsBinary && contentLengthHeader && contentLengthHeader.trim()
          ? Number(contentLengthHeader)
          : undefined;
      const mediaContentLength =
        bodyIsBinary && Number.isFinite(contentLengthValue)
          ? Number(contentLengthValue)
          : undefined;
      const initialPayload =
        bodyIsBinary || !payload || typeof payload !== 'object'
          ? (this.buildMediaSlugPayload(slugHeader) ?? {})
          : ((payload as AnyObject) ?? {});

      const op: CrudOperation = 'CREATE';
      const scope: CrudScope | undefined = undefined;
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        payload: initialPayload as AnyObject,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        const preference = preferences.returnPreference;
        const deepInsertEnabled = deepInsertEnabledForSet && !bodyIsBinary;
        const payloadSource = bodyIsBinary
          ? (ctx.payload ?? {})
          : (ctx.payload ?? (payload as AnyObject));
        const payloadForCreate = this.coercePayloadToObject(payloadSource as AnyObject);
        const visited = new Set<AnyObject>();
        const normalized = deepInsertEnabled
          ? this.normalizeDeepInsertPayload(payloadForCreate, modelCtor as typeof Entity)
          : { root: payloadForCreate, children: undefined };
        ctx.payload = normalized.root;

        const created = await this.repository.create(normalized.root as any, options);
        let entityForResponse: AnyObject | undefined = this.toPlainEntity(created);
        const createdEntityId = this.extractEntityId(created);
        const entityLocationUrl = this.buildEntityLocationUrl(createdEntityId, entityForResponse);
        if (entityLocationUrl) {
          this.setEntityLocationHeaders(entityLocationUrl);
        }

        if (deepInsertEnabled && normalized.children && Object.keys(normalized.children).length) {
          const parentId = this.extractEntityId(created);
          if (parentId == null) {
            throw new HttpErrors.InternalServerError(
              'Unable to determine entity id for deep insert.',
            );
          }
          const repoWithRelations = this.repository as AnyObject;
          for (const [relationName, relationValue] of Object.entries(normalized.children)) {
            if (relationValue == null) continue;
            const relationMeta = modelRelations?.[relationName] as AnyObject | undefined;
            if (!relationMeta) continue;
            const factory = repoWithRelations[relationName];
            if (typeof factory !== 'function') {
              throw new HttpErrors.BadRequest(
                `Repository for ${setName} does not expose a relation factory for ${relationName}.`,
              );
            }
            const relationRepo = factory(parentId, options);
            if (!relationRepo || typeof relationRepo.create !== 'function') {
              throw new HttpErrors.BadRequest(
                `Relation ${relationName} does not support create operations required for deep insert.`,
              );
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

        if (bodyIsBinary && mediaStream) {
          if (createdEntityId == null) {
            throw new HttpErrors.InternalServerError(
              'Unable to determine entity id for media upload.',
            );
          }
          const handler = await this.requireMediaHandler();
          const effectiveContentType = mediaContentType ?? 'application/octet-stream';
          const writeResult = await handler.write({
            id: createdEntityId,
            entitySet: def,
            entity: entityForResponse ?? {},
            repository: this.repository as unknown as DefaultCrudRepository<CrudEntity, unknown>,
            options,
            stream: mediaStream,
            contentType: effectiveContentType,
            contentLength: mediaContentLength,
            slug: slugHeader,
          });
          const createOverrides = {
            contentType: effectiveContentType,
            contentLength: mediaContentLength,
          };
          const resolvedMetadata = this.resolveMediaMetadata(writeResult, createOverrides);
          const updates = await this.applyMediaMetadataUpdates(
            createdEntityId,
            writeResult,
            createOverrides,
            resolvedMetadata,
          );
          if (updates) {
            entityForResponse = this.mergeMediaMetadata(entityForResponse, updates);
          }
          const telemetryContentType = resolvedMetadata.contentType ?? effectiveContentType;
          this.logMediaTelemetry('media.write', {
            entityId: createdEntityId,
            bytes: resolvedMetadata.length,
            contentType: telemetryContentType,
          });
        }

        if (this.etagEnabled()) {
          const hasEtag = this.computeEtagFromPlain(entityForResponse);
          if (!hasEtag) {
            const reloaded = await this.reloadEntityForResponse(
              entityForResponse ?? created,
              options,
            );
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

        this.response.status(201);
        this.applyPreference(preference);
        const result = {
          '@odata.context': entityContext,
          ...decorated,
        } as AnyObject;
        ctx.result = result;
        return result;
      };

      const helpers = this.helpersForEntity(entityContext, op);
      const onCtx = this.buildOnContext(ctx, helpers);
      const res = await this.runOn(op, scope, onCtx, execDefault);
      ctx.result = res;
      if (!this.response.headersSent) {
        await this.runAfter(op, scope, ctx);
      }
      return ctx.result as AnyObject | undefined;
    }

    @patch(
      `/odata/${setName}/{id}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `Update ${setName} entity`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
          },
        },
        operationVisibility,
      ),
    )
    async update(
      @idParam id: unknown,
      @requestBody({
        content: {
          'application/json': {
            schema: updateSchema,
          },
        },
      })
      payload: Partial<CrudEntity>,
    ) {
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');
      this.ensureAcceptsJson();
      this.ensureJsonContentType();

      const deepUpdateEnabled = deepUpdateEnabledForSet;
      let relationPayloads: Record<string, unknown> | undefined;
      let rootPayload: AnyObject | undefined;
      if (deepUpdateEnabled && payload && typeof payload === 'object') {
        const prepared = this.coercePayloadToObject(payload);
        const normalized = this.normalizeDeepInsertPayload(prepared, modelCtor as typeof Entity);
        relationPayloads = normalized.children;
        rootPayload = { ...normalized.root };
      } else if (payload && typeof payload === 'object') {
        rootPayload = { ...(payload as AnyObject) };
      }

      const entityId = this.coerceParentId(id);
      const op: CrudOperation = 'UPDATE';
      const scope: CrudScope | undefined = undefined;
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        id: entityId,
        payload: rootPayload as AnyObject,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        const preference = preferences.returnPreference;
        const ifMatch = this.parseIfMatchHeader();
        const workingPayload = ctx.payload ?? rootPayload ?? {};
        const parentIdValue = entityId;

        if (this.etagEnabled() && this.cfg?.strict && !ifMatch) {
          const error = new HttpErrors.PreconditionRequired(
            'If-Match header is required when ETags are enabled.',
          );
          (error as any).code = 'PreconditionRequired';
          throw error;
        }
        if (ifMatch && !ifMatch.any) {
          const { values, invalidComposite } = decodeIfMatchValues(
            ifMatch.values ?? [],
            etagProperties,
            etagPropertyDefs,
          );
          if (invalidComposite || !values.length) this.throwPreconditionFailed();
          const where = this.buildConditionalWhere(parentIdValue, values, false);
          const { count } = await this.repository.updateAll(
            workingPayload as AnyObject,
            where,
            options,
          );
          if (!count) this.throwPreconditionFailed();
        } else {
          if (Object.keys(workingPayload).length) {
            await this.repository.updateById(
              parentIdValue as any,
              workingPayload as AnyObject,
              options,
            );
          }
        }

        let updated = await this.repository.findById(parentIdValue as any, undefined, options);
        if (deepUpdateEnabled && relationPayloads && Object.keys(relationPayloads).length) {
          await this.applyDeepUpdateRelations(
            parentIdValue,
            relationPayloads,
            this.repository as AnyObject,
            modelCtor as typeof Entity,
            options,
            0,
          );
          updated = await this.repository.findById(parentIdValue as any, undefined, options);
        }

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

      const helpers = this.helpersForEntity(entityContext, op);
      const onCtx = this.buildOnContext(ctx, helpers);
      const res = await this.runOn(op, scope, onCtx, execDefault);
      ctx.result = res;
      if (!this.response.headersSent) {
        await this.runAfter(op, scope, ctx);
      }
      return ctx.result as AnyObject | undefined;
    }

    @del(
      `/odata/${setName}/{id}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `Delete ${setName} entity`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
            '204': {
              description: `Delete ${setName} entity (minimal response)`,
            },
          },
        },
        operationVisibility,
      ),
    )
    async delete(@idParam id: unknown): Promise<AnyObject | void> {
      const preferences = this.parsePreferenceHeader();
      if (preferences.respondAsync) this.throwPreferenceNotSupported('respond-async');

      const entityId = this.coerceParentId(id);
      const op: CrudOperation = 'DELETE';
      const scope: CrudScope | undefined = undefined;
      const ctx = this.buildHookContext({
        operation: op,
        scope,
        id: entityId,
        options: this.repositoryOptions(),
      });
      await this.enforceTenantLimit(op);
      await this.runBefore(op, scope, ctx);

      const execDefault = async () => {
        const options = this.repositoryOptions();
        const ifMatch = this.parseIfMatchHeader();
        const preference = preferences.returnPreference;
        if (preference === 'representation') {
          this.ensureAcceptsJson();
        }
        let entityForResponse: AnyObject | undefined;

        if (this.etagEnabled() && this.cfg?.strict && !ifMatch) {
          const error = new HttpErrors.PreconditionRequired(
            'If-Match header is required when ETags are enabled.',
          );
          (error as any).code = 'PreconditionRequired';
          throw error;
        }
        if (ifMatch && !ifMatch.any) {
          const { values, invalidComposite } = decodeIfMatchValues(
            ifMatch.values ?? [],
            etagProperties,
            etagPropertyDefs,
          );
          if (invalidComposite || !values.length) this.throwPreconditionFailed();
          const where = this.buildConditionalWhere(entityId, values, false);
          if (preference === 'representation') {
            entityForResponse = await this.findEntityForDeleteRepresentation(
              entityId,
              where,
              options,
            );
          }
          const { count } = await this.repository.deleteAll(where, options);
          if (!count) this.throwPreconditionFailed();
        } else {
          if (preference === 'representation') {
            entityForResponse = await this.findEntityForDeleteRepresentation(
              entityId,
              undefined,
              options,
            );
          }
          await this.repository.deleteById(entityId as any, options);
        }
        this.ensureODataHeaders();
        if (preference === 'representation') {
          if (!entityForResponse) {
            throw new HttpErrors.InternalServerError(
              'Unable to load deleted entity for representation response.',
            );
          }
          const etag = this.computeEtagFromPlain(entityForResponse);
          const decorated = this.decoratePlainEntity(entityForResponse, etag);
          this.setEtagHeaderFromPlain(entityForResponse);
          this.applyPreference(preference);
          this.response.status(200);
          const result = {
            '@odata.context': entityContext,
            ...decorated,
          } as AnyObject;
          ctx.result = result;
          return result;
        }
        if (preference === 'minimal') {
          this.applyPreference(preference);
        }
        this.response.status(204);
        return undefined;
      };

      const helpers = this.helpersForEntity(entityContext, op);
      const onCtx = this.buildOnContext(ctx, helpers);
      const res = await this.runOn(op, scope, onCtx, execDefault);
      ctx.result = res;
      if (!this.response.headersSent) {
        await this.runAfter(op, scope, ctx);
      }
      return ctx.result as AnyObject | undefined;
    }

    atomicityState(): AtomicityRequestState | undefined {
      return (this.request as any)[ODATA_ATOMICITY_STATE] as AtomicityRequestState | undefined;
    }

    repositoryOptions(): Options | undefined {
      const state = this.atomicityState();
      const transaction = state?.getTransaction(setName);
      return transaction ? { transaction } : undefined;
    }

    parsePreferenceHeader(): {
      returnPreference?: 'minimal' | 'representation';
      respondAsync: boolean;
    } {
      const header =
        this.request.get('Prefer') ?? (this.request.headers?.['prefer'] as string | undefined);
      const result: { returnPreference?: 'minimal' | 'representation'; respondAsync: boolean } = {
        respondAsync: false,
      };
      if (!header) return result;

      const tokens = String(header)
        .split(',')
        .map((token) => token.trim())
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
        const mergedFields = this.mergeFieldSelections(target.fields, source.fields);
        if (mergedFields) {
          target.fields = mergedFields as Filter<CrudEntity>['fields'];
        }
      }

      if (source.include?.length) {
        const existing = target.include ?? [];
        target.include = mergeIncludes(existing, source.include);
      }

      ensureIncludeProjection(
        target as Filter<AnyObject>,
        target.include as InclusionFilter[] | undefined,
        modelRelations,
      );
      this.ensureEtagField(target);
    }

    mergeFieldSelections(
      targetFields: Filter<CrudEntity>['fields'],
      sourceFields: Filter<CrudEntity>['fields'],
    ): Filter<CrudEntity>['fields'] | undefined {
      const normalizedTarget = this.normalizeFieldSelection(targetFields);
      const normalizedSource = this.normalizeFieldSelection(sourceFields);
      if (!normalizedSource) return normalizedTarget;
      return {
        ...(normalizedTarget ?? {}),
        ...normalizedSource,
      };
    }

    normalizeFieldSelection(
      input: Filter<CrudEntity>['fields'],
    ): Record<string, boolean> | undefined {
      if (!input) return undefined;
      if (Array.isArray(input)) {
        const out: Record<string, boolean> = {};
        for (const field of input) {
          if (typeof field === 'string' && field) {
            out[field] = true;
          }
        }
        return Object.keys(out).length ? out : undefined;
      }
      if (typeof input === 'string') {
        return input ? { [input]: true } : undefined;
      }
      if (typeof input === 'object') {
        const out: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(input)) {
          if (!key) continue;
          if (value === undefined || value === null) continue;
          out[key] = Boolean(value);
        }
        return Object.keys(out).length ? out : undefined;
      }
      return undefined;
    }
  }
  const controllerMethodSet = collectControllerMethodNames(ODataCrudController);
  const derivedMethodAliases = deriveDefaultMethodAliases(
    controllerMethodSet,
    def.securityMetadata,
  );
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
  const deleteAliasSources = new Set(['delete', 'deleteById', 'destroyById']);
  const hasExplicitDeleteMetadata = Object.keys(methodMetadata).some((name) =>
    deleteAliasSources.has(name),
  );

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

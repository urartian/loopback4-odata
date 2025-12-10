import { BindingScope, inject, injectable } from '@loopback/core';
import {
  AnyObject,
  Entity,
  ModelDefinition,
  PropertyDefinition,
  RelationDefinitionMap,
} from '@loopback/repository';
import { EntitySetDef, EntitySetRegistry } from '../registry/entityset-registry';
import { ODATA_BINDINGS } from '../keys';
import {
  getODataActions,
  getODataFunctions,
  OperationMeta,
} from '../decorators/action.function.decorators';
import {
  ODataConfig,
  ODataCapabilitiesConfig,
  ODataCapabilityDefaults,
  ODataNavigationRestriction,
  ODataEntityPermission,
  ODataInsertRestrictionsConfig,
  ODataUpdateRestrictionsConfig,
  ODataDeleteRestrictionsConfig,
  ODataSearchRestrictionsConfig,
  ODataSearchExpression,
} from '../types';
import { getODataSearchableProps } from '../decorators/search.decorators';
import { stableStringify } from '../util/token-signing';

const EDM_NAMESPACE = 'http://docs.oasis-open.org/odata/ns/edm';
const EDMX_NAMESPACE = 'http://docs.oasis-open.org/odata/ns/edmx';
const LOOPBACK_BATCH_NAMESPACE = 'LoopBack.V1.BatchCapabilities';
const LOOPBACK_BATCH_TERM = `${LOOPBACK_BATCH_NAMESPACE}.ChangeSetsSupported`;
const VOCABULARY_REFERENCES = [
  {
    uri: 'http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/vocabularies/Org.OData.Core.V1.xml',
    namespace: 'Org.OData.Core.V1',
    alias: 'Core',
  },
  {
    uri: 'http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/vocabularies/Org.OData.Capabilities.V1.xml',
    namespace: 'Org.OData.Capabilities.V1',
    alias: 'Capabilities',
  },
];

interface ComplexTypeResult {
  name: string;
  xml: string;
  json: Record<string, unknown>;
  ctor: Function;
}

interface EnumTypeResult {
  name: string;
  xml: string;
  json: Record<string, unknown>;
}

interface SchemaBuildContext {
  namespace: string;
  complexTypes: Map<Function, ComplexTypeResult>;
  enumTypes: Map<string, EnumTypeResult>;
  visitingComplex: Set<Function>;
  usedTypeNames: Set<string>;
}

const PRIMITIVE_TYPE_MAP = new Map<unknown, string>([
  [String, 'Edm.String'],
  ['string', 'Edm.String'],
  [Number, 'Edm.Double'],
  ['number', 'Edm.Double'],
  [Boolean, 'Edm.Boolean'],
  ['boolean', 'Edm.Boolean'],
  [Date, 'Edm.DateTimeOffset'],
  ['date', 'Edm.DateTimeOffset'],
  ['Date', 'Edm.DateTimeOffset'],
  [BigInt, 'Edm.Int64'],
  ['bigint', 'Edm.Int64'],
  [Buffer, 'Edm.Binary'],
  ['buffer', 'Edm.Binary'],
]);

interface ResolvedEdmType {
  type: string;
  facets?: Record<string, unknown>;
}

type EffectiveCapabilities = ODataCapabilitiesConfig & {
  navigationRestrictionDefaults?: ODataNavigationRestriction;
};

const DEFAULT_FILTER_FUNCTIONS = [
  'contains',
  'startswith',
  'endswith',
  'indexof',
  'substring',
  'length',
  'round',
  'floor',
  'ceiling',
  'year',
];

const SEARCH_EXPRESSION_ENUM_MAP: Record<string, string> = {
  none: 'Org.OData.Capabilities.V1.SearchExpressions/none',
  and: 'Org.OData.Capabilities.V1.SearchExpressions/And',
  or: 'Org.OData.Capabilities.V1.SearchExpressions/Or',
  not: 'Org.OData.Capabilities.V1.SearchExpressions/Not',
  phrase: 'Org.OData.Capabilities.V1.SearchExpressions/Phrase',
  grouping: 'Org.OData.Capabilities.V1.SearchExpressions/Grouping',
  propertyexpressions: 'Org.OData.Capabilities.V1.SearchExpressions/PropertyExpressions',
  searchterms: 'Org.OData.Capabilities.V1.SearchExpressions/SearchTerms',
};

function mergeInsertRestrictions(
  defaults?: ODataInsertRestrictionsConfig,
  overrides?: ODataInsertRestrictionsConfig,
): ODataInsertRestrictionsConfig | undefined {
  if (!defaults && !overrides) return undefined;
  return {
    insertable: overrides?.insertable ?? defaults?.insertable,
    description: overrides?.description ?? defaults?.description,
    longDescription: overrides?.longDescription ?? defaults?.longDescription,
    requiredProperties: overrides?.requiredProperties ?? defaults?.requiredProperties,
    requiredNavigationProperties:
      overrides?.requiredNavigationProperties ?? defaults?.requiredNavigationProperties,
    nonInsertableProperties:
      overrides?.nonInsertableProperties ?? defaults?.nonInsertableProperties,
    nonInsertableNavigationProperties:
      overrides?.nonInsertableNavigationProperties ?? defaults?.nonInsertableNavigationProperties,
  };
}

function mergeUpdateRestrictions(
  defaults?: ODataUpdateRestrictionsConfig,
  overrides?: ODataUpdateRestrictionsConfig,
): ODataUpdateRestrictionsConfig | undefined {
  if (!defaults && !overrides) return undefined;
  return {
    updatable: overrides?.updatable ?? defaults?.updatable,
    description: overrides?.description ?? defaults?.description,
    longDescription: overrides?.longDescription ?? defaults?.longDescription,
    requiredProperties: overrides?.requiredProperties ?? defaults?.requiredProperties,
    nonUpdatableProperties: overrides?.nonUpdatableProperties ?? defaults?.nonUpdatableProperties,
    nonUpdatableNavigationProperties:
      overrides?.nonUpdatableNavigationProperties ?? defaults?.nonUpdatableNavigationProperties,
  };
}

function mergeDeleteRestrictions(
  defaults?: ODataDeleteRestrictionsConfig,
  overrides?: ODataDeleteRestrictionsConfig,
): ODataDeleteRestrictionsConfig | undefined {
  if (!defaults && !overrides) return undefined;
  return {
    deletable: overrides?.deletable ?? defaults?.deletable,
    description: overrides?.description ?? defaults?.description,
    longDescription: overrides?.longDescription ?? defaults?.longDescription,
    requiresFilter: overrides?.requiresFilter ?? defaults?.requiresFilter,
    nonDeletableNavigationProperties:
      overrides?.nonDeletableNavigationProperties ?? defaults?.nonDeletableNavigationProperties,
  };
}

function mergeSearchRestrictions(
  defaults?: ODataSearchRestrictionsConfig,
  overrides?: ODataSearchRestrictionsConfig,
): ODataSearchRestrictionsConfig | undefined {
  if (!defaults && !overrides) return undefined;
  const unsupported = overrides?.unsupportedExpressions ?? defaults?.unsupportedExpressions;
  return {
    searchable: overrides?.searchable ?? defaults?.searchable,
    unsupportedExpressions: unsupported,
  };
}

function normalizeSearchExpression(expression: ODataSearchExpression): string | undefined {
  if (expression.startsWith('Org.OData.Capabilities.V1.SearchExpressions/')) {
    return expression;
  }
  const key = expression.toLowerCase();
  return SEARCH_EXPRESSION_ENUM_MAP[key];
}

function mergeCapabilities(
  defaults: ODataCapabilityDefaults | undefined,
  overrides: ODataCapabilitiesConfig | undefined,
): EffectiveCapabilities {
  const navigationRestrictions = {
    ...(defaults?.navigationRestrictions ?? {}),
    ...(overrides?.navigationRestrictions ?? {}),
  };

  return {
    filterFunctions: overrides?.filterFunctions ?? defaults?.filterFunctions,
    countable: overrides?.countable ?? defaults?.countable,
    navigationRestrictions: Object.keys(navigationRestrictions).length
      ? navigationRestrictions
      : undefined,
    navigationRestrictionDefaults: defaults?.navigationRestrictionDefaults,
    permissions: overrides?.permissions ?? defaults?.permissions,
    hasStream: overrides?.hasStream ?? defaults?.hasStream,
    aggregation: overrides?.aggregation ?? defaults?.aggregation,
    aggregationMethods: overrides?.aggregationMethods ?? defaults?.aggregationMethods,
    applySupported: overrides?.applySupported ?? defaults?.applySupported ?? true,
    insertRestrictions: mergeInsertRestrictions(
      defaults?.insertRestrictions,
      overrides?.insertRestrictions,
    ),
    updateRestrictions: mergeUpdateRestrictions(
      defaults?.updateRestrictions,
      overrides?.updateRestrictions,
    ),
    deleteRestrictions: mergeDeleteRestrictions(
      defaults?.deleteRestrictions,
      overrides?.deleteRestrictions,
    ),
    searchRestrictions: mergeSearchRestrictions(
      defaults?.searchRestrictions,
      overrides?.searchRestrictions,
    ),
  };
}

const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function registerEnumType(
  context: SchemaBuildContext,
  ownerName: string,
  propertyName: string,
  schema: Record<string, unknown> | undefined,
): string | undefined {
  const enumValues = Array.isArray(schema?.enum) ? schema?.enum : [];
  if (!enumValues.length) return undefined;
  const nonNullValues = enumValues.filter((v) => v !== undefined && v !== null);
  if (!nonNullValues.length) return undefined;

  const isNumeric = nonNullValues.every(
    (v) => typeof v === 'number' && Number.isFinite(v as number),
  );
  const isString = nonNullValues.every((v) => typeof v === 'string');
  if (!isNumeric && !isString) return undefined;

  let providedNames = Array.isArray(
    (schema as Record<string, unknown>)?.['x-odata.enumMemberNames'],
  )
    ? ((schema as Record<string, unknown>)['x-odata.enumMemberNames'] as unknown[])
    : undefined;
  if (providedNames && providedNames.length !== nonNullValues.length) {
    providedNames = undefined;
  }

  const baseName = `${ownerName}${capitalize(propertyName)}Enum`;
  const enumName = reserveTypeName(context, baseName);

  const memberNames: string[] = [];
  const seenNames = new Set<string>();
  for (let index = 0; index < nonNullValues.length; index++) {
    const value = nonNullValues[index];
    let rawName: string;
    if (providedNames) {
      rawName = String(providedNames[index] ?? '');
      if (!SIMPLE_IDENTIFIER.test(rawName)) {
        rawName = sanitizeEnumMemberName(rawName);
      }
    } else if (isString) {
      rawName = String(value);
      if (!SIMPLE_IDENTIFIER.test(rawName)) {
        return undefined;
      }
    } else {
      rawName = sanitizeEnumMemberName(value ?? index);
    }

    if (!SIMPLE_IDENTIFIER.test(rawName)) {
      return undefined;
    }

    let candidate = rawName;
    let counter = 1;
    while (seenNames.has(candidate)) {
      candidate = `${rawName}_${++counter}`;
    }
    seenNames.add(candidate);
    memberNames.push(candidate);
  }

  if (!memberNames.length || memberNames.length !== nonNullValues.length) return undefined;

  let numericValues: number[];
  if (isNumeric) {
    numericValues = (nonNullValues as number[]).map((value) => Math.trunc(value));
  } else {
    const providedNumeric = Array.isArray(
      (schema as Record<string, unknown>)?.['x-odata.enumNumericValues'],
    )
      ? ((schema as Record<string, unknown>)['x-odata.enumNumericValues'] as unknown[])
      : undefined;
    if (providedNumeric && providedNumeric.length === nonNullValues.length) {
      const parsed = providedNumeric.map((val) => Number(val));
      if (parsed.every((num) => Number.isFinite(num) && Number.isInteger(num))) {
        numericValues = parsed.map((num) => Math.trunc(num));
      } else {
        return undefined;
      }
    } else {
      numericValues = nonNullValues.map((_, index) => index);
    }
  }

  const maxAbs = numericValues.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const underlyingType = maxAbs > 2147483647 ? 'Edm.Int64' : 'Edm.Int32';
  const hasNonZero = numericValues.some((v) => v !== 0);
  const isFlags = numericValues.every((v) => v === 0 || (v & (v - 1)) === 0) && hasNonZero;

  const membersXml: string[] = [];
  const membersJson: Array<Record<string, unknown>> = [];

  numericValues.forEach((value, index) => {
    const name = memberNames[index] ?? `Value_${index}`;
    membersXml.push(`    <Member Name="${xmlEscape(name)}" Value="${xmlEscape(String(value))}" />`);
    membersJson.push({ Name: name, Value: value });
  });

  const attributes: string[] = [`Name="${xmlEscape(enumName)}"`];
  if (underlyingType !== 'Edm.Int32') {
    attributes.push(`UnderlyingType="${underlyingType}"`);
  }
  if (isFlags || Boolean(schema?.['x-odata.enumIsFlags'])) {
    attributes.push('IsFlags="true"');
  }

  const xml = [`    <EnumType ${attributes.join(' ')}>`, ...membersXml, '    </EnumType>'].join(
    '\n',
  );

  const enumJson: Record<string, unknown> = {
    $Kind: 'EnumType',
  };
  if (underlyingType !== 'Edm.Int32') {
    enumJson.$UnderlyingType = underlyingType;
  }
  if (isFlags || Boolean(schema?.['x-odata.enumIsFlags'])) {
    enumJson.$IsFlags = true;
  }
  enumJson.Members = membersJson;

  context.enumTypes.set(enumName, { name: enumName, xml, json: enumJson });
  return `${context.namespace}.${enumName}`;
}

function ensureComplexType(
  ctor: Function,
  context: SchemaBuildContext,
): ComplexTypeResult | undefined {
  const existing = context.complexTypes.get(ctor);
  if (existing) return existing;
  if (context.visitingComplex.has(ctor)) return undefined;

  const definition = (ctor as typeof Entity).definition as ModelDefinition | undefined;
  if (!definition) return undefined;

  context.visitingComplex.add(ctor);
  const preferredName = definition.name ?? (ctor as { name?: string }).name ?? 'ComplexType';
  const name = reserveTypeName(context, preferredName);
  const result = buildComplexType(name, definition, ctor, context);
  context.complexTypes.set(ctor, result);
  context.visitingComplex.delete(ctor);
  return result;
}

function buildComplexType(
  name: string,
  definition: ModelDefinition,
  ctor: Function,
  context: SchemaBuildContext,
): ComplexTypeResult {
  const propertyLines: string[] = [];
  const json: Record<string, unknown> = { $Kind: 'ComplexType' };
  const properties = definition.properties ?? {};

  for (const [propertyName, propertyMeta] of Object.entries(properties)) {
    const propertyDef = propertyMeta as PropertyDefinition;
    const resolved = resolveEdmType(propertyDef, context, name, propertyName);
    if (!resolved) continue;

    const isRequired = Boolean(propertyDef.required) || Boolean(propertyDef.id);
    const nullable = isRequired ? 'false' : 'true';
    const attrs: string[] = [
      `Name="${xmlEscape(propertyName)}"`,
      `Type="${xmlEscape(resolved.type)}"`,
      `Nullable="${nullable}"`,
    ];
    const propertySchema: Record<string, unknown> = { $Type: resolved.type };
    if (isRequired) {
      propertySchema.Nullable = false;
    }
    if (resolved.facets) {
      for (const [facetName, facetValue] of Object.entries(resolved.facets)) {
        attrs.push(`${facetName}="${xmlEscape(String(facetValue))}"`);
        propertySchema[facetName] = facetValue;
      }
    }
    propertyLines.push(`      <Property ${attrs.join(' ')} />`);
    json[propertyName] = propertySchema;
  }

  const xml = [
    `    <ComplexType Name="${xmlEscape(name)}">`,
    ...propertyLines,
    '    </ComplexType>',
  ].join('\n');

  return { name, xml, json, ctor };
}
function normalizeJsonSchema(def: PropertyDefinition): Record<string, unknown> | undefined {
  const schema = def.jsonSchema as Record<string, unknown> | undefined;
  if (schema) return schema;
  if (typeof def.type === 'object' && def.type) {
    const maybeSchema = def.type as Record<string, unknown>;
    if ('type' in maybeSchema) return maybeSchema;
  }
  return undefined;
}

function resolvePrimitiveType(
  type: unknown,
  schema: Record<string, unknown> | undefined,
): ResolvedEdmType | undefined {
  const schemaAny = schema as Record<string, unknown> | undefined;
  const schemaType =
    typeof schemaAny?.type === 'string' ? String(schemaAny.type).toLowerCase() : undefined;
  const format =
    typeof schemaAny?.format === 'string' ? String(schemaAny.format).toLowerCase() : undefined;
  const dataType =
    typeof schemaAny?.dataType === 'string' ? String(schemaAny.dataType).toLowerCase() : undefined;

  const fromMap =
    PRIMITIVE_TYPE_MAP.get(type) ??
    PRIMITIVE_TYPE_MAP.get(typeof type === 'function' ? type.name : (type as string));
  if (
    fromMap === 'Edm.Double' &&
    (schemaType === 'integer' || format === 'int32' || format === 'int64' || dataType === 'integer')
  ) {
    // fall through to schema-based detection for integers
  } else if (fromMap && fromMap !== 'Edm.String') {
    return { type: fromMap };
  }

  if (schemaType === 'boolean' || type === Boolean || type === 'boolean') {
    return { type: 'Edm.Boolean' };
  }

  if (schemaType === 'integer' || format === 'int32' || dataType === 'integer') {
    return { type: 'Edm.Int32' };
  }

  if (format === 'int16') {
    return { type: 'Edm.Int16' };
  }

  if (format === 'int64') {
    return { type: 'Edm.Int64' };
  }

  if (format === 'sbyte') {
    return { type: 'Edm.SByte' };
  }

  if (format === 'byte' || schemaType === 'binary') {
    return { type: 'Edm.Byte' };
  }

  if (
    format === 'decimal' ||
    dataType === 'decimal' ||
    schemaAny?.precision != null ||
    schemaAny?.scale != null
  ) {
    return { type: 'Edm.Decimal' };
  }

  if (schemaType === 'number' && format === 'single') {
    return { type: 'Edm.Single' };
  }

  if (schemaType === 'number' || type === Number || type === 'number') {
    return { type: 'Edm.Double' };
  }

  if (format === 'date') {
    return { type: 'Edm.Date' };
  }

  if (format === 'time' || format === 'time-of-day' || dataType === 'timeofday') {
    return { type: 'Edm.TimeOfDay' };
  }

  if (format === 'duration') {
    return { type: 'Edm.Duration' };
  }

  if (format === 'uuid' || format === 'guid') {
    return { type: 'Edm.Guid' };
  }

  if (format === 'binary' || type === Buffer || type === 'buffer') {
    return { type: 'Edm.Binary' };
  }

  if (format === 'date-time' || type === Date || type === 'date') {
    return { type: 'Edm.DateTimeOffset' };
  }

  if (schemaType === 'object' || type === Object || type === 'object') {
    return undefined;
  }

  return { type: 'Edm.String' };
}

function resolveEdmType(
  def: PropertyDefinition,
  context: SchemaBuildContext,
  ownerName: string,
  propertyName: string,
): ResolvedEdmType | undefined {
  const schema = normalizeJsonSchema(def);
  const schemaAny = schema as Record<string, unknown> | undefined;
  const type = def.type;
  const effectiveType = unwrapPropertyType(type);
  const defaultValue = (def as { default?: unknown }).default ?? schemaAny?.default;

  if (Array.isArray(type) || type === 'array' || schemaAny?.type === 'array') {
    const itemsSchema = schemaAny?.items as Record<string, unknown> | undefined;
    const explicitItemType = Array.isArray(type)
      ? type[0]
      : (def as unknown as { itemType?: unknown }).itemType;
    const effectiveItemType = unwrapPropertyType(
      explicitItemType ?? (itemsSchema?.type as unknown),
    );
    const nestedDef: PropertyDefinition = {
      ...(itemsSchema as Record<string, unknown> | undefined),
      type: effectiveItemType ?? explicitItemType ?? (itemsSchema?.type as unknown),
    } as PropertyDefinition;
    const item = resolveEdmType(nestedDef, context, ownerName, propertyName);
    const itemType = item?.type ?? 'Edm.String';
    return { type: `Collection(${itemType})` };
  }

  if (schemaAny && Array.isArray(schemaAny.enum) && schemaAny.enum.length) {
    const fqEnum = registerEnumType(context, ownerName, propertyName, schemaAny);
    if (fqEnum) {
      const facets = defaultValue !== undefined ? { DefaultValue: defaultValue } : undefined;
      return { type: fqEnum, facets };
    }
  }

  if (typeof effectiveType === 'function') {
    const ctor = effectiveType as Function;
    const proto = (ctor as any)?.prototype;
    if (!(proto && proto instanceof Entity)) {
      if ((ctor as any)?.definition) {
        const complex = ensureComplexType(ctor, context);
        if (complex) {
          return { type: `${context.namespace}.${complex.name}` };
        }
      }
    }
  }

  const resolved = resolvePrimitiveType(effectiveType, schema);
  if (!resolved) return undefined;

  const facets: Record<string, unknown> = {};
  const numeric = (value: unknown) => (typeof value === 'number' ? value : undefined);
  const bool = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
  const maxLength = numeric(schemaAny?.maxLength) ?? numeric(schemaAny?.['maxlength']);
  if (typeof maxLength === 'number' && Number.isInteger(maxLength) && maxLength > 0) {
    facets.MaxLength = maxLength;
  }
  const precision = numeric(schemaAny?.precision);
  if (typeof precision === 'number' && precision >= 0) {
    facets.Precision = precision;
  }
  const scale = numeric(schemaAny?.scale);
  if (typeof scale === 'number' && scale >= 0) {
    facets.Scale = scale;
  }
  const unicode = bool(schemaAny?.unicode);
  if (typeof unicode === 'boolean') {
    facets.Unicode = unicode;
  }
  if (defaultValue !== undefined) {
    facets.DefaultValue = defaultValue;
  }

  return {
    type: resolved.type,
    facets: Object.keys(facets).length ? facets : undefined,
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface NavigationBinding {
  path: string;
  target: string;
}

interface EntityTypeResult {
  name: string;
  xml: string;
  navigationBindings: NavigationBinding[];
  json: Record<string, unknown>;
  relations: string[];
}

function buildEntityType(
  def: EntitySetDef,
  namespace: string,
  setLookup: Map<typeof Entity, EntitySetDef>,
  context: SchemaBuildContext,
  hasStream: boolean,
): EntityTypeResult | undefined {
  const modelDefinition = (def.modelCtor as typeof Entity).definition as
    | ModelDefinition
    | undefined;
  if (!modelDefinition) return undefined;

  const entityName = modelDefinition.name ?? def.modelCtor.name;
  const { properties } = modelDefinition;
  const propertyLines: string[] = [];
  const keyProps = modelDefinition.idProperties();
  const json: Record<string, unknown> = { $Kind: 'EntityType' };
  if (keyProps.length) {
    json.$Key = keyProps;
  }
  const baseCtor = resolveBaseEntityCtor(def.modelCtor as typeof Entity);
  let baseTypeQualified: string | undefined;
  if (baseCtor && setLookup.has(baseCtor)) {
    const baseDefinition = (baseCtor as typeof Entity).definition as ModelDefinition | undefined;
    const baseName = baseDefinition?.name ?? baseCtor.name;
    if (baseName) {
      baseTypeQualified = `${namespace}.${xmlEscape(baseName)}`;
      json.$BaseType = `${namespace}.${baseName}`;
    }
  }
  const annotationLines: string[] = [];
  const navigationLines: string[] = [];
  const navigationBindings: NavigationBinding[] = [];
  const relationNames: string[] = [];

  for (const [propertyName, propertyMeta] of Object.entries(properties)) {
    const propertyDef = propertyMeta as PropertyDefinition;
    const resolved = resolveEdmType(propertyDef, context, entityName, propertyName);
    if (!resolved) continue;

    const isRequired = Boolean(propertyDef.required) || Boolean(propertyDef.id);
    const nullable = isRequired ? 'false' : 'true';
    const propertySchema: Record<string, unknown> = {
      $Type: resolved.type,
    };
    if (isRequired) {
      propertySchema.Nullable = false;
    }
    const attrs: string[] = [
      `Name="${xmlEscape(propertyName)}"`,
      `Type="${xmlEscape(resolved.type)}"`,
      `Nullable="${nullable}"`,
    ];
    if (resolved.facets) {
      for (const [facetName, facetValue] of Object.entries(resolved.facets)) {
        attrs.push(`${facetName}="${xmlEscape(String(facetValue))}"`);
        propertySchema[facetName] = facetValue;
      }
    }
    if (def.etagProperties?.includes(propertyName)) {
      attrs.push('ConcurrencyMode="Fixed"');
      json[`${propertyName}@ConcurrencyMode`] = 'Fixed';
    }
    propertyLines.push(`      <Property ${attrs.join(' ')} />`);
    json[propertyName] = propertySchema;
  }

  if (hasStream) {
    annotationLines.push('      <Annotation Term="Org.OData.Core.V1.HasStream" Bool="true"/>');
    annotationLines.push(
      '      <Annotation Term="Org.OData.Capabilities.V1.Streaming" Bool="true"/>',
    );
    json['@Org.OData.Core.V1.HasStream'] = true;
    json['@Org.OData.Capabilities.V1.Streaming'] = true;
    if (def.mediaContentTypeField) {
      annotationLines.push(
        `      <Annotation Term="Org.OData.Core.V1.MediaType"><Path>${xmlEscape(def.mediaContentTypeField)}</Path></Annotation>`,
      );
      json['@Org.OData.Core.V1.MediaType'] = { $Path: def.mediaContentTypeField };
    }
  }

  const relations = (modelDefinition.relations ?? {}) as RelationDefinitionMap;
  for (const [relationName, relationDef] of Object.entries(relations)) {
    const resolver = relationDef?.target;
    if (typeof resolver !== 'function') continue;
    const targetModel = resolver() as typeof Entity | undefined;
    if (!targetModel) continue;

    const targetSet = setLookup.get(targetModel);
    if (!targetSet) continue;

    const targetDefinition = (targetModel as typeof Entity).definition as
      | ModelDefinition
      | undefined;
    const targetEntityName = targetDefinition?.name ?? targetModel.name;
    if (!targetEntityName) continue;

    relationNames.push(relationName);

    const qualifiedType = relationDef.targetsMany
      ? `Collection(${namespace}.${xmlEscape(targetEntityName)})`
      : `${namespace}.${xmlEscape(targetEntityName)}`;

    const partnerInfo = resolvePartnerRelation(targetDefinition, def.modelCtor as typeof Entity);
    const partnerName = partnerInfo.name;
    const constraints = collectReferentialConstraints(
      relationDef as RelationDefinitionMap[string],
      modelDefinition,
      targetDefinition,
    );

    const navAttrs: string[] = [`Name="${xmlEscape(relationName)}"`, `Type="${qualifiedType}"`];
    if (partnerName) {
      navAttrs.push(`Partner="${xmlEscape(partnerName)}"`);
    }

    if (constraints.length) {
      navigationLines.push(`      <NavigationProperty ${navAttrs.join(' ')}>`);
      for (const constraint of constraints) {
        navigationLines.push(
          `        <ReferentialConstraint Property="${xmlEscape(constraint.property)}" ReferencedProperty="${xmlEscape(constraint.referencedProperty)}" />`,
        );
      }
      navigationLines.push('      </NavigationProperty>');
    } else {
      navigationLines.push(`      <NavigationProperty ${navAttrs.join(' ')} />`);
    }

    navigationBindings.push({ path: relationName, target: targetSet.name });
    const navJson: Record<string, unknown> = {
      $Kind: 'NavigationProperty',
      $Type: qualifiedType,
    };
    if (partnerName) navJson.$Partner = partnerName;
    if (constraints.length) {
      navJson.$ReferentialConstraint = constraints.map((item) => ({
        Property: item.property,
        ReferencedProperty: item.referencedProperty,
      }));
    }
    json[relationName] = navJson;
  }

  if (!propertyLines.length && !navigationLines.length) return undefined;

  const keySection = keyProps.length
    ? [
        '      <Key>',
        ...keyProps.map((name) => `        <PropertyRef Name="${xmlEscape(name)}"/>`),
        '      </Key>',
      ].join('\n')
    : '';

  const entityTypeAttrs = [`Name="${xmlEscape(entityName)}"`];
  if (baseTypeQualified) {
    entityTypeAttrs.push(`BaseType="${baseTypeQualified}"`);
  }

  const xml = [
    `    <EntityType ${entityTypeAttrs.join(' ')}>`,
    keySection,
    ...propertyLines,
    ...annotationLines,
    ...navigationLines,
    '    </EntityType>',
  ]
    .filter(Boolean)
    .join('\n');

  return { name: entityName, xml, navigationBindings, json, relations: relationNames };
}

function resolveBaseEntityCtor(ctor: typeof Entity): typeof Entity | undefined {
  let current = Object.getPrototypeOf(ctor);
  while (current && current !== Entity && typeof current === 'function') {
    if (current.prototype instanceof Entity) return current;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

@injectable({ scope: BindingScope.SINGLETON })
export class CsdlGenerator {
  private readonly cache = new Map<
    'xml' | 'json',
    { version: number; config: string; body: string }
  >();

  constructor(
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
    private readonly registry: EntitySetRegistry,
    @inject(ODATA_BINDINGS.CONFIG, { optional: true })
    private readonly cfg: ODataConfig = {},
  ) {}

  contentType(format: 'xml' | 'json' = 'xml'): string {
    return format === 'xml' ? 'application/xml' : 'application/json';
  }

  generate(format: 'xml' | 'json' = 'xml'): string {
    const registryVersion = this.registry.getVersion();
    const cached = this.cache.get(format);
    const namespace = this.normalizeNamespace(this.cfg?.namespace);
    const namespaceAlias = this.cfg?.namespaceAlias?.trim();
    const containerName = this.normalizeContainerName(this.cfg?.entityContainerName);
    const configSignature = this.buildConfigSignature(namespace, namespaceAlias, containerName);
    if (cached?.version === registryVersion && cached.config === configSignature) {
      return cached.body;
    }

    const entitySets = this.registry.list();
    const entityTypesXml: string[] = [];
    const complexTypesXml: string[] = [];
    const enumTypesXml: string[] = [];
    const containerSetsXml: string[] = [];
    const containerAnnotationsXml: string[] = [];
    const supplementalSchemasXml: string[] = [];
    const actionXml: string[] = [];
    const functionXml: string[] = [];
    const operationImportsXml: string[] = [];

    const jsonComplexTypes: Record<string, unknown> = {};
    const jsonEnumTypes: Record<string, unknown> = {};
    const jsonEntityTypes: Record<string, unknown> = {};
    const jsonEntitySets: Record<string, unknown> = {};
    const jsonContainerAnnotations: Record<string, unknown> = {};
    const jsonSupplementalSchemas: Record<string, unknown> = {};
    const jsonActions: Record<string, unknown> = {};
    const jsonFunctions: Record<string, unknown> = {};
    const jsonImports: Record<string, unknown> = {};
    const referenceXml = buildVocabularyReferencesXml();
    const referenceJson = buildVocabularyReferencesJson();

    const defaultCapabilities = this.cfg?.capabilities;

    const context: SchemaBuildContext = {
      namespace,
      complexTypes: new Map(),
      enumTypes: new Map(),
      visitingComplex: new Set(),
      usedTypeNames: new Set(),
    };

    const setLookup = new Map<typeof Entity, EntitySetDef>();
    for (const set of entitySets) {
      setLookup.set(set.modelCtor, set);
    }

    for (const set of entitySets) {
      const definition = (set.modelCtor as typeof Entity).definition as ModelDefinition | undefined;
      const entityName = definition?.name ?? set.modelCtor.name;
      if (entityName) context.usedTypeNames.add(entityName);
    }

    for (const set of entitySets) {
      const capabilities = mergeCapabilities(defaultCapabilities, set.capabilities);
      const hasStream = Boolean(set.hasStream ?? capabilities.hasStream);
      const entityType = buildEntityType(set, namespace, setLookup, context, hasStream);
      if (!entityType) continue;

      entityTypesXml.push(entityType.xml);
      jsonEntityTypes[entityType.name] = entityType.json;

      const navigationBindings = entityType.navigationBindings.map(
        (binding) =>
          `        <NavigationPropertyBinding Path="${xmlEscape(binding.path)}" Target="${xmlEscape(binding.target)}" />`,
      );

      const concurrencyAnnotation =
        (set.etagProperties?.length ?? 0) > 0
          ? [
              '        <Annotation Term="Org.OData.Core.V1.OptimisticConcurrency">',
              '          <Collection>',
              ...set.etagProperties!.map(
                (prop) => `            <PropertyPath>${xmlEscape(prop)}</PropertyPath>`,
              ),
              '          </Collection>',
              '        </Annotation>',
            ]
          : [];

      const entitySetLines = [
        `      <EntitySet Name="${xmlEscape(set.name)}" EntityType="${namespace}.${xmlEscape(entityType.name)}">`,
        ...navigationBindings,
        ...concurrencyAnnotation,
      ];

      const capabilityAnnotationsXml: string[] = [];
      const capabilityAnnotationsJson: Record<string, unknown> = {};
      const changeSetsSupported = set.supportsTransactions === true;
      capabilityAnnotationsXml.push(
        `        <Annotation Term="${LOOPBACK_BATCH_TERM}" Bool="${changeSetsSupported ? 'true' : 'false'}"/>`,
      );
      capabilityAnnotationsJson[`@${LOOPBACK_BATCH_TERM}`] = changeSetsSupported;
      const searchRestrictions = mergeSearchRestrictions(
        this.deriveSearchRestrictions(set),
        capabilities.searchRestrictions,
      );
      const insertRestrictions = capabilities.insertRestrictions;
      const updateRestrictions = capabilities.updateRestrictions;
      const deleteRestrictions = capabilities.deleteRestrictions;

      const deepInsertEnabled =
        set.deepInsert ?? this.cfg?.enableDeepInsert ?? insertRestrictions?.insertable;

      if (insertRestrictions) {
        const {
          insertable,
          description,
          longDescription,
          requiredProperties,
          requiredNavigationProperties,
          nonInsertableProperties,
          nonInsertableNavigationProperties,
        } = insertRestrictions;
        const recordXml: string[] = [
          '        <Annotation Term="Org.OData.Capabilities.V1.InsertRestrictions">',
          '          <Record>',
        ];
        const recordJson: Record<string, unknown> = {};
        let hasContent = false;

        if (insertable !== undefined) {
          recordXml.push(
            `            <PropertyValue Property="Insertable" Bool="${insertable ? 'true' : 'false'}"/>`,
          );
          recordJson.Insertable = Boolean(insertable);
          hasContent = true;
        }
        if (description) {
          recordXml.push(
            `            <PropertyValue Property="Description" String="${xmlEscape(description)}"/>`,
          );
          recordJson.Description = description;
          hasContent = true;
        }
        if (longDescription) {
          recordXml.push(
            `            <PropertyValue Property="LongDescription" String="${xmlEscape(longDescription)}"/>`,
          );
          recordJson.LongDescription = longDescription;
          hasContent = true;
        }
        if (Array.isArray(requiredProperties) && requiredProperties.length) {
          recordXml.push('            <PropertyValue Property="RequiredProperties">');
          recordXml.push('              <Collection>');
          const propertyJson: Array<Record<string, unknown>> = [];
          for (const prop of requiredProperties) {
            recordXml.push(`                <PropertyPath>${xmlEscape(prop)}</PropertyPath>`);
            propertyJson.push({ $PropertyPath: prop });
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.RequiredProperties = propertyJson;
          hasContent = true;
        }
        if (Array.isArray(requiredNavigationProperties) && requiredNavigationProperties.length) {
          recordXml.push('            <PropertyValue Property="RequiredNavigationProperties">');
          recordXml.push('              <Collection>');
          const navJson: Array<Record<string, unknown>> = [];
          for (const prop of requiredNavigationProperties) {
            recordXml.push(
              `                <NavigationPropertyPath>${xmlEscape(prop)}</NavigationPropertyPath>`,
            );
            navJson.push({ $NavigationPropertyPath: prop });
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.RequiredNavigationProperties = navJson;
          hasContent = true;
        }
        if (Array.isArray(nonInsertableProperties) && nonInsertableProperties.length) {
          recordXml.push('            <PropertyValue Property="NonInsertableProperties">');
          recordXml.push('              <Collection>');
          const nonInsertJson: Array<Record<string, unknown>> = [];
          for (const prop of nonInsertableProperties) {
            recordXml.push(`                <PropertyPath>${xmlEscape(prop)}</PropertyPath>`);
            nonInsertJson.push({ $PropertyPath: prop });
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.NonInsertableProperties = nonInsertJson;
          hasContent = true;
        }
        if (
          Array.isArray(nonInsertableNavigationProperties) &&
          nonInsertableNavigationProperties.length
        ) {
          recordXml.push(
            '            <PropertyValue Property="NonInsertableNavigationProperties">',
          );
          recordXml.push('              <Collection>');
          const navJson: Array<Record<string, unknown>> = [];
          for (const prop of nonInsertableNavigationProperties) {
            recordXml.push(
              `                <NavigationPropertyPath>${xmlEscape(prop)}</NavigationPropertyPath>`,
            );
            navJson.push({ $NavigationPropertyPath: prop });
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.NonInsertableNavigationProperties = navJson;
          hasContent = true;
        }

        if (hasContent) {
          recordXml.push('          </Record>');
          recordXml.push('        </Annotation>');
          capabilityAnnotationsXml.push(...recordXml);
          capabilityAnnotationsJson['@Org.OData.Capabilities.V1.InsertRestrictions'] = recordJson;
        }
      }

      if (deepInsertEnabled) {
        capabilityAnnotationsXml.push(
          '        <Annotation Term="Org.OData.Capabilities.V1.DeepInsertSupport">',
          '          <Record>',
          '            <PropertyValue Property="Supported" Bool="true"/>',
          '          </Record>',
          '        </Annotation>',
        );
        capabilityAnnotationsJson['@Org.OData.Capabilities.V1.DeepInsertSupport'] = {
          Supported: true,
        };
      }

      if (updateRestrictions) {
        const {
          updatable,
          description,
          longDescription,
          requiredProperties,
          nonUpdatableProperties,
          nonUpdatableNavigationProperties,
        } = updateRestrictions;
        const recordXml: string[] = [
          '        <Annotation Term="Org.OData.Capabilities.V1.UpdateRestrictions">',
          '          <Record>',
        ];
        const recordJson: Record<string, unknown> = {};
        let hasContent = false;

        if (updatable !== undefined) {
          recordXml.push(
            `            <PropertyValue Property="Updatable" Bool="${updatable ? 'true' : 'false'}"/>`,
          );
          recordJson.Updatable = Boolean(updatable);
          hasContent = true;
        }
        if (description) {
          recordXml.push(
            `            <PropertyValue Property="Description" String="${xmlEscape(description)}"/>`,
          );
          recordJson.Description = description;
          hasContent = true;
        }
        if (longDescription) {
          recordXml.push(
            `            <PropertyValue Property="LongDescription" String="${xmlEscape(longDescription)}"/>`,
          );
          recordJson.LongDescription = longDescription;
          hasContent = true;
        }
        if (Array.isArray(requiredProperties) && requiredProperties.length) {
          recordXml.push('            <PropertyValue Property="RequiredProperties">');
          recordXml.push('              <Collection>');
          const propertyJson: Array<Record<string, unknown>> = [];
          for (const prop of requiredProperties) {
            recordXml.push(`                <PropertyPath>${xmlEscape(prop)}</PropertyPath>`);
            propertyJson.push({ $PropertyPath: prop });
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.RequiredProperties = propertyJson;
          hasContent = true;
        }
        if (Array.isArray(nonUpdatableProperties) && nonUpdatableProperties.length) {
          recordXml.push('            <PropertyValue Property="NonUpdatableProperties">');
          recordXml.push('              <Collection>');
          const nonUpdateJson: Array<Record<string, unknown>> = [];
          for (const prop of nonUpdatableProperties) {
            recordXml.push(`                <PropertyPath>${xmlEscape(prop)}</PropertyPath>`);
            nonUpdateJson.push({ $PropertyPath: prop });
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.NonUpdatableProperties = nonUpdateJson;
          hasContent = true;
        }
        if (
          Array.isArray(nonUpdatableNavigationProperties) &&
          nonUpdatableNavigationProperties.length
        ) {
          recordXml.push('            <PropertyValue Property="NonUpdatableNavigationProperties">');
          recordXml.push('              <Collection>');
          const navJson: Array<Record<string, unknown>> = [];
          for (const prop of nonUpdatableNavigationProperties) {
            recordXml.push(
              `                <NavigationPropertyPath>${xmlEscape(prop)}</NavigationPropertyPath>`,
            );
            navJson.push({ $NavigationPropertyPath: prop });
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.NonUpdatableNavigationProperties = navJson;
          hasContent = true;
        }

        if (hasContent) {
          recordXml.push('          </Record>');
          recordXml.push('        </Annotation>');
          capabilityAnnotationsXml.push(...recordXml);
          capabilityAnnotationsJson['@Org.OData.Capabilities.V1.UpdateRestrictions'] = recordJson;
        }
      }

      if (deleteRestrictions) {
        const {
          deletable,
          description,
          longDescription,
          requiresFilter,
          nonDeletableNavigationProperties,
        } = deleteRestrictions;
        const recordXml: string[] = [
          '        <Annotation Term="Org.OData.Capabilities.V1.DeleteRestrictions">',
          '          <Record>',
        ];
        const recordJson: Record<string, unknown> = {};
        let hasContent = false;

        if (deletable !== undefined) {
          recordXml.push(
            `            <PropertyValue Property="Deletable" Bool="${deletable ? 'true' : 'false'}"/>`,
          );
          recordJson.Deletable = Boolean(deletable);
          hasContent = true;
        }
        if (requiresFilter !== undefined) {
          recordXml.push(
            `            <PropertyValue Property="RequiresFilter" Bool="${requiresFilter ? 'true' : 'false'}"/>`,
          );
          recordJson.RequiresFilter = Boolean(requiresFilter);
          hasContent = true;
        }
        if (description) {
          recordXml.push(
            `            <PropertyValue Property="Description" String="${xmlEscape(description)}"/>`,
          );
          recordJson.Description = description;
          hasContent = true;
        }
        if (longDescription) {
          recordXml.push(
            `            <PropertyValue Property="LongDescription" String="${xmlEscape(longDescription)}"/>`,
          );
          recordJson.LongDescription = longDescription;
          hasContent = true;
        }
        if (
          Array.isArray(nonDeletableNavigationProperties) &&
          nonDeletableNavigationProperties.length
        ) {
          recordXml.push('            <PropertyValue Property="NonDeletableNavigationProperties">');
          recordXml.push('              <Collection>');
          const navJson: Array<Record<string, unknown>> = [];
          for (const prop of nonDeletableNavigationProperties) {
            recordXml.push(
              `                <NavigationPropertyPath>${xmlEscape(prop)}</NavigationPropertyPath>`,
            );
            navJson.push({ $NavigationPropertyPath: prop });
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.NonDeletableNavigationProperties = navJson;
          hasContent = true;
        }

        if (hasContent) {
          recordXml.push('          </Record>');
          recordXml.push('        </Annotation>');
          capabilityAnnotationsXml.push(...recordXml);
          capabilityAnnotationsJson['@Org.OData.Capabilities.V1.DeleteRestrictions'] = recordJson;
        }
      }

      if (searchRestrictions) {
        const { searchable, unsupportedExpressions } = searchRestrictions;
        const recordXml: string[] = [
          '        <Annotation Term="Org.OData.Capabilities.V1.SearchRestrictions">',
          '          <Record>',
        ];
        const recordJson: Record<string, unknown> = {};
        let hasContent = false;

        if (searchable !== undefined) {
          recordXml.push(
            `            <PropertyValue Property="Searchable" Bool="${searchable ? 'true' : 'false'}"/>`,
          );
          recordJson.Searchable = Boolean(searchable);
          hasContent = true;
        }
        const normalizedUnsupported = Array.isArray(unsupportedExpressions)
          ? unsupportedExpressions
              .map((expr) => normalizeSearchExpression(expr))
              .filter((value): value is string => Boolean(value))
          : undefined;
        if (normalizedUnsupported?.length) {
          recordXml.push('            <PropertyValue Property="UnsupportedExpressions">');
          recordXml.push('              <Collection>');
          for (const expr of normalizedUnsupported) {
            recordXml.push(`                <EnumMember>${xmlEscape(expr)}</EnumMember>`);
          }
          recordXml.push('              </Collection>');
          recordXml.push('            </PropertyValue>');
          recordJson.UnsupportedExpressions = normalizedUnsupported;
          hasContent = true;
        }

        if (hasContent) {
          recordXml.push('          </Record>');
          recordXml.push('        </Annotation>');
          capabilityAnnotationsXml.push(...recordXml);
          capabilityAnnotationsJson['@Org.OData.Capabilities.V1.SearchRestrictions'] = recordJson;
        }
      }

      if (capabilities.countable === false) {
        capabilityAnnotationsXml.push(
          '        <Annotation Term="Org.OData.Capabilities.V1.CountRestrictions">',
          '          <Record>',
          '            <PropertyValue Property="Countable" Bool="false"/>',
          '          </Record>',
          '        </Annotation>',
        );
        capabilityAnnotationsJson['@Org.OData.Capabilities.V1.CountRestrictions'] = {
          Countable: false,
        };
      }

      const filterFunctions = capabilities.filterFunctions ?? DEFAULT_FILTER_FUNCTIONS;
      if (filterFunctions && filterFunctions.length) {
        capabilityAnnotationsXml.push(
          '        <Annotation Term="Org.OData.Capabilities.V1.FilterFunctions">',
          '          <Collection>',
          ...filterFunctions.map((fn) => `            <String>${xmlEscape(fn)}</String>`),
          '          </Collection>',
          '        </Annotation>',
        );
        capabilityAnnotationsJson['@Org.OData.Capabilities.V1.FilterFunctions'] = filterFunctions;
      }

      if (capabilities.aggregation) {
        const methodsForJson = capabilities.aggregationMethods?.length
          ? capabilities.aggregationMethods
          : ['Sum', 'Average', 'Min', 'Max', 'Count', 'CountDistinct'];
        const methodsForXml = methodsForJson.map((m) => xmlEscape(m));
        capabilityAnnotationsXml.push(
          '        <Annotation Term="Org.OData.Capabilities.V1.Aggregate">',
          '          <Record>',
          '            <PropertyValue Property="SupportedAggregationMethods">',
          '              <Collection>',
          ...methodsForXml.map((m) => `                <String>${m}</String>`),
          '              </Collection>',
          '            </PropertyValue>',
          '          </Record>',
          '        </Annotation>',
        );
        capabilityAnnotationsJson['@Org.OData.Capabilities.V1.Aggregate'] = {
          SupportedAggregationMethods: methodsForJson,
        };
      }

      if (capabilities.applySupported) {
        const transformations = [
          'filter',
          'groupby',
          'aggregate',
          'orderby',
          'top',
          'skip',
          'concat',
        ];
        capabilityAnnotationsXml.push(
          '        <Annotation Term="Org.OData.Capabilities.V1.ApplySupported">',
          '          <Record>',
          '            <PropertyValue Property="ApplySupported" Bool="true"/>',
          '            <PropertyValue Property="SupportedTransformations">',
          '              <Collection>',
          ...transformations.map((item) => `                <String>${xmlEscape(item)}</String>`),
          '              </Collection>',
          '            </PropertyValue>',
          '          </Record>',
          '        </Annotation>',
        );
        capabilityAnnotationsJson['@Org.OData.Capabilities.V1.ApplySupported'] = {
          ApplySupported: true,
          SupportedTransformations: transformations,
        };
      }

      const navigationRestrictions: Record<string, ODataNavigationRestriction> = {
        ...(capabilities.navigationRestrictions ?? {}),
      };
      const relationSet = new Set(entityType.relations);
      if (capabilities.navigationRestrictionDefaults) {
        for (const relationName of relationSet) {
          if (navigationRestrictions[relationName]) continue;
          navigationRestrictions[relationName] = capabilities.navigationRestrictionDefaults;
        }
      }
      const restrictedEntries = Object.entries(navigationRestrictions).filter(
        ([name, config]) => relationSet.has(name) && config?.navigable !== undefined,
      );

      if (restrictedEntries.length) {
        const restrictedXml: string[] = [];
        const restrictedJson: Array<Record<string, unknown>> = [];
        for (const [name, config] of restrictedEntries) {
          const navigable = config?.navigable;
          if (navigable === undefined) continue;
          const enumMember =
            navigable === false
              ? 'Org.OData.Capabilities.V1.NavigationType/None'
              : 'Org.OData.Capabilities.V1.NavigationType/Recursive';
          restrictedXml.push(
            '                <Record>',
            `                  <PropertyValue Property="NavigationProperty" NavigationPropertyPath="${xmlEscape(name)}"/>`,
            `                  <PropertyValue Property="Navigability" EnumMember="${enumMember}"/>`,
            '                </Record>',
          );
          restrictedJson.push({
            NavigationProperty: name,
            Navigability: enumMember,
          });
        }

        if (restrictedXml.length) {
          capabilityAnnotationsXml.push(
            '        <Annotation Term="Org.OData.Capabilities.V1.NavigationRestrictions">',
            '          <Record>',
            '            <PropertyValue Property="RestrictedProperties">',
            '              <Collection>',
            ...restrictedXml,
            '              </Collection>',
            '            </PropertyValue>',
            '          </Record>',
            '        </Annotation>',
          );
          capabilityAnnotationsJson['@Org.OData.Capabilities.V1.NavigationRestrictions'] = {
            RestrictedProperties: restrictedJson,
          };
        }
      }

      if (capabilities.permissions?.length) {
        const permissionItemsXml: string[] = [];
        const permissionItemsJson: Array<Record<string, unknown>> = [];

        for (const permission of capabilities.permissions) {
          const scopes = permission.scopes ?? [];
          if (!scopes.length) continue;
          const scopeXml: string[] = [];
          const scopeJson: Array<Record<string, unknown>> = [];
          for (const scopeEntry of scopes) {
            if (typeof scopeEntry === 'string') {
              scopeXml.push(
                '                <Record Type="Org.OData.Core.V1.PermissionScope">',
                `                  <PropertyValue Property="Scope" String="${xmlEscape(scopeEntry)}"/>`,
                '                </Record>',
              );
              scopeJson.push({ Scope: scopeEntry });
            } else if (scopeEntry && typeof scopeEntry === 'object') {
              const jsonScope: Record<string, unknown> = { Scope: scopeEntry.scope };
              const xmlLines = [
                '                <Record Type="Org.OData.Core.V1.PermissionScope">',
                `                  <PropertyValue Property="Scope" String="${xmlEscape(scopeEntry.scope)}"/>`,
              ];
              if (scopeEntry.description) {
                xmlLines.push(
                  `                  <PropertyValue Property="Description" String="${xmlEscape(scopeEntry.description)}"/>`,
                );
                jsonScope.Description = scopeEntry.description;
              }
              xmlLines.push('                </Record>');
              scopeXml.push(...xmlLines);
              scopeJson.push(jsonScope);
            }
          }
          if (!scopeXml.length) continue;

          const permissionXml: string[] = [
            '          <Record Type="Org.OData.Core.V1.PermissionType">',
          ];
          const permissionJson: Record<string, unknown> = {};
          if (permission.scheme) {
            permissionXml.push(
              `            <PropertyValue Property="SchemeName" String="${xmlEscape(permission.scheme)}"/>`,
            );
            permissionJson.SchemeName = permission.scheme;
          }
          permissionXml.push(
            '            <PropertyValue Property="Scopes">',
            '              <Collection>',
            ...scopeXml,
            '              </Collection>',
            '            </PropertyValue>',
            '          </Record>',
          );
          permissionJson.Scopes = scopeJson;
          permissionItemsXml.push(...permissionXml);
          permissionItemsJson.push(permissionJson);
        }

        if (permissionItemsXml.length) {
          capabilityAnnotationsXml.push(
            '        <Annotation Term="Org.OData.Core.V1.Permissions">',
            '          <Collection>',
            ...permissionItemsXml,
            '          </Collection>',
            '        </Annotation>',
          );
          capabilityAnnotationsJson['@Org.OData.Core.V1.Permissions'] = permissionItemsJson;
        }
      }

      if (capabilityAnnotationsXml.length) {
        entitySetLines.push(...capabilityAnnotationsXml);
      }

      entitySetLines.push('      </EntitySet>');

      containerSetsXml.push(entitySetLines.join('\n'));

      const entitySetJson: Record<string, unknown> = {
        $Collection: true,
        $Type: `${namespace}.${entityType.name}`,
      };
      if (entityType.navigationBindings.length) {
        const bindings: Record<string, string> = {};
        for (const binding of entityType.navigationBindings) {
          bindings[binding.path] = binding.target;
        }
        entitySetJson.$NavigationPropertyBinding = bindings;
      }
      if (set.etagProperties?.length) {
        entitySetJson['@Org.OData.Core.V1.OptimisticConcurrency'] = set.etagProperties.map(
          (prop) => ({
            $PropertyPath: prop,
          }),
        );
      }
      Object.assign(entitySetJson, capabilityAnnotationsJson);
      jsonEntitySets[set.name] = entitySetJson;

      const entityName = (set.modelCtor as typeof Entity).definition?.name ?? set.modelCtor.name;
      const actions = set.actions ?? [];
      for (const action of actions) {
        const result = this.buildOperationSchema('Action', action, namespace, entityName);
        actionXml.push(result.xml);
        if (result.importXml) operationImportsXml.push(result.importXml);
        jsonActions[action.name] = result.json;
        if (result.jsonImport) jsonImports[result.jsonImport.name] = result.jsonImport.schema;
      }

      const functions = set.functions ?? [];
      for (const fn of functions) {
        const result = this.buildOperationSchema('Function', fn, namespace, entityName);
        functionXml.push(result.xml);
        if (result.importXml) operationImportsXml.push(result.importXml);
        jsonFunctions[fn.name] = result.json;
        if (result.jsonImport) jsonImports[result.jsonImport.name] = result.jsonImport.schema;
      }
    }

    const complexList = Array.from(context.complexTypes.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const complex of complexList) {
      complexTypesXml.push(complex.xml);
      jsonComplexTypes[complex.name] = complex.json;
    }

    const enumList = Array.from(context.enumTypes.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const enumType of enumList) {
      enumTypesXml.push(enumType.xml);
      jsonEnumTypes[enumType.name] = enumType.json;
    }

    const changeSetsSupported =
      entitySets.length > 0 && entitySets.every((set) => set.supportsTransactions === true);
    containerAnnotationsXml.push(
      '        <Annotation Term="Org.OData.Capabilities.V1.BatchSupported">',
      '          <Record>',
      '            <PropertyValue Property="Supported" Bool="true"/>',
      `            <PropertyValue Property="ChangeSetsSupported" Bool="${changeSetsSupported ? 'true' : 'false'}"/>`,
      '          </Record>',
      '        </Annotation>',
    );
    jsonContainerAnnotations['@Org.OData.Capabilities.V1.BatchSupported'] = {
      Supported: true,
      ChangeSetsSupported: changeSetsSupported,
    };

    supplementalSchemasXml.push(
      `    <Schema Namespace="${LOOPBACK_BATCH_NAMESPACE}" xmlns="${EDM_NAMESPACE}">`,
      '      <Term Name="ChangeSetsSupported" Type="Edm.Boolean" AppliesTo="EntitySet" />',
      '    </Schema>',
    );
    jsonSupplementalSchemas[LOOPBACK_BATCH_NAMESPACE] = {
      $Kind: 'Schema',
      ChangeSetsSupported: {
        $Kind: 'Term',
        $Type: 'Edm.Boolean',
        AppliesTo: ['EntitySet'],
      },
    };

    if (format === 'json') {
      const body = this.buildJsonDocument(
        namespace,
        namespaceAlias,
        containerName,
        referenceJson,
        jsonEntityTypes,
        jsonEntitySets,
        jsonContainerAnnotations,
        jsonSupplementalSchemas,
        jsonActions,
        jsonFunctions,
        jsonImports,
        jsonComplexTypes,
        jsonEnumTypes,
      );
      this.cache.set(format, { version: registryVersion, config: configSignature, body });
      return body;
    }

    const schemaOpenTag = namespaceAlias
      ? `    <Schema Namespace="${namespace}" Alias="${xmlEscape(namespaceAlias)}" xmlns="${EDM_NAMESPACE}">`
      : `    <Schema Namespace="${namespace}" xmlns="${EDM_NAMESPACE}">`;

    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<edmx:Edmx Version="4.0" xmlns:edmx="${EDMX_NAMESPACE}">`,
      ...referenceXml,
      '  <edmx:DataServices>',
      schemaOpenTag,
      ...complexTypesXml,
      ...enumTypesXml,
      ...entityTypesXml,
      ...actionXml,
      ...functionXml,
      `      <EntityContainer Name="${containerName}">`,
      ...containerSetsXml,
      ...containerAnnotationsXml,
      ...operationImportsXml,
      '      </EntityContainer>',
      '    </Schema>',
      ...supplementalSchemasXml,
      '  </edmx:DataServices>',
      '</edmx:Edmx>',
    ].join('\n');
    this.cache.set(format, { version: registryVersion, config: configSignature, body });
    return body;
  }

  private normalizeNamespace(ns?: string): string {
    const trimmed = ns?.trim();
    if (!trimmed) return 'Default';
    return trimmed;
  }

  private deriveSearchRestrictions(set: EntitySetDef): ODataSearchRestrictionsConfig | undefined {
    const mode = this.cfg?.searchMode ?? 'annotated';
    if (mode === 'disabled') {
      return { searchable: false };
    }
    const fields = this.resolveSearchableFields(set);
    if (fields.length) {
      return { searchable: true };
    }
    if (mode === 'all') {
      const stringProps = this.modelStringProperties(set.modelCtor as typeof Entity);
      return { searchable: stringProps.length > 0 };
    }
    return { searchable: false };
  }

  private resolveSearchableFields(set: EntitySetDef): string[] {
    const mode = this.cfg?.searchMode ?? 'annotated';
    if (mode === 'disabled') return [];
    const configured = this.cfg?.searchFields?.[set.name];
    if (configured?.length) {
      return configured
        .map((field) => field?.trim())
        .filter((field): field is string => Boolean(field));
    }
    if (mode === 'config-only') return [];
    const annotated = getODataSearchableProps(set.modelCtor) ?? [];
    if (annotated.length) {
      return annotated.filter((field): field is string => Boolean(field));
    }
    if (mode === 'all') {
      return this.modelStringProperties(set.modelCtor as typeof Entity);
    }
    return [];
  }

  private modelStringProperties(modelCtor: typeof Entity): string[] {
    const definition = (modelCtor as typeof Entity).definition as ModelDefinition | undefined;
    if (!definition?.properties) return [];
    const result: string[] = [];
    for (const [name, property] of Object.entries(definition.properties)) {
      if (this.isStringProperty(property as PropertyDefinition)) {
        result.push(name);
      }
    }
    return result;
  }

  private isStringProperty(definition: PropertyDefinition): boolean {
    const type = definition.type;
    if (type === String || type === 'string') return true;
    if (Array.isArray(type)) return false;
    if (typeof type === 'function') {
      const typeName = type.name?.toLowerCase();
      if (typeName === 'string') return true;
    }
    const schema = definition.jsonSchema as Record<string, unknown> | undefined;
    const schemaType =
      typeof schema?.type === 'string' ? String(schema.type).toLowerCase() : undefined;
    if (schemaType === 'string') return true;
    return false;
  }

  private normalizeContainerName(name?: string): string {
    const trimmed = name?.trim();
    if (!trimmed) return 'DefaultContainer';
    return trimmed;
  }

  private buildJsonDocument(
    namespace: string,
    alias: string | undefined,
    containerName: string,
    references: Record<string, unknown>,
    entityTypes: Record<string, unknown>,
    entitySets: Record<string, unknown>,
    containerAnnotations: Record<string, unknown>,
    supplementalSchemas: Record<string, unknown>,
    actions: Record<string, unknown>,
    functions: Record<string, unknown>,
    imports: Record<string, unknown>,
    complexTypes: Record<string, unknown>,
    enumTypes: Record<string, unknown>,
  ): string {
    const schema: Record<string, unknown> = {
      $Kind: 'Schema',
      EntityContainer: `${namespace}.${containerName}`,
      ...complexTypes,
      ...enumTypes,
      ...entityTypes,
    };
    if (alias) {
      schema.$Alias = alias;
    }

    if (Object.keys(actions).length) {
      Object.assign(schema, actions);
    }
    if (Object.keys(functions).length) {
      Object.assign(schema, functions);
    }

    const container: Record<string, unknown> = {
      $Kind: 'EntityContainer',
      ...entitySets,
    };
    if (Object.keys(containerAnnotations).length) {
      Object.assign(container, containerAnnotations);
    }
    if (Object.keys(imports).length) {
      Object.assign(container, imports);
    }
    schema[containerName] = container;

    const doc: Record<string, unknown> = {
      $Version: '4.0',
      [namespace]: schema,
      ...supplementalSchemas,
    };
    if (Object.keys(references).length) {
      doc.$Reference = references;
    }
    return JSON.stringify(doc, null, 2);
  }

  private buildConfigSignature(
    namespace: string,
    namespaceAlias: string | undefined,
    containerName: string,
  ): string {
    return stableStringify({
      namespace,
      namespaceAlias,
      containerName,
      capabilities: this.cfg?.capabilities,
      enableDeepInsert: this.cfg?.enableDeepInsert,
      searchMode: this.cfg?.searchMode,
      searchFields: this.cfg?.searchFields,
    });
  }

  private buildOperationSchema(
    kind: 'Action' | 'Function',
    op: OperationMeta,
    namespace: string,
    entityName: string | undefined,
  ) {
    const isBound = op.binding !== 'unbound';
    const lines: string[] = [];
    const qualifiedEntityXml = entityName ? `${namespace}.${xmlEscape(entityName)}` : undefined;
    const qualifiedEntityJson = entityName ? `${namespace}.${entityName}` : undefined;

    if (isBound && qualifiedEntityXml) {
      const bindingType =
        op.binding === 'collection' ? `Collection(${qualifiedEntityXml})` : qualifiedEntityXml;
      lines.push(`  <Parameter Name="bindingParameter" Type="${bindingType}" />`);
    }

    for (const param of op.parameters ?? []) {
      const type = param.type ?? 'Edm.String';
      lines.push(`  <Parameter Name="${xmlEscape(param.name)}" Type="${xmlEscape(type)}" />`);
    }

    const name = xmlEscape(op.name);
    let returnTypeLine = '';
    if (op.returnType) {
      returnTypeLine = `  <ReturnType Type="${xmlEscape(op.returnType)}" />`;
    } else if (kind === 'Function') {
      returnTypeLine = '  <ReturnType Type="Edm.String" />';
    }

    const schemaLines = [
      `    <${kind} Name="${name}"${isBound ? ' IsBound="true"' : ''}>`,
      ...lines,
      returnTypeLine,
      `    </${kind}>`,
    ].filter(Boolean);

    let importLine: string | undefined;
    let jsonImport: { name: string; schema: Record<string, unknown> } | undefined;
    if (!isBound) {
      const importTag = kind === 'Action' ? 'ActionImport' : 'FunctionImport';
      importLine = `      <${importTag} Name="${name}" ${kind}="${namespace}.${name}" />`;
      jsonImport = {
        name: op.name,
        schema: {
          [kind === 'Action' ? '$Action' : '$Function']: `${namespace}.${op.name}`,
        },
      };
    }

    const jsonOp: Record<string, unknown> = {
      $Kind: kind,
    };
    if (isBound) {
      jsonOp.$IsBound = true;
    }
    const parameters: Record<string, unknown>[] = [];
    if (isBound && qualifiedEntityJson) {
      const bindingType =
        op.binding === 'collection'
          ? `Collection(${qualifiedEntityJson})`
          : `${qualifiedEntityJson}`;
      parameters.push({
        $Name: 'bindingParameter',
        $Type: bindingType,
      });
    }
    for (const param of op.parameters ?? []) {
      parameters.push({
        $Name: param.name,
        $Type: param.type ?? 'Edm.String',
      });
    }
    if (parameters.length) {
      jsonOp.$Parameter = parameters;
    }
    const returnType = op.returnType ?? (kind === 'Function' ? 'Edm.String' : undefined);
    if (returnType) {
      jsonOp.$ReturnType = {
        $Type: returnType,
      };
    }

    return {
      xml: schemaLines.join('\n'),
      importXml: importLine,
      json: jsonOp,
      jsonImport,
    };
  }
}
function capitalize(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

function sanitizeEnumMemberName(value: unknown): string {
  const str = String(value ?? '');
  const sanitized = str
    .replace(/[^A-Za-z0-9]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  const candidate = sanitized || 'Value';
  return candidate[0].match(/[A-Za-z]/) ? candidate : `Value_${candidate}`;
}

function reserveTypeName(context: SchemaBuildContext, preferred: string): string {
  let base = preferred && preferred.trim().length ? preferred : 'Type';
  base = base.replace(/[^A-Za-z0-9]/g, '');
  if (!base.length) base = 'Type';
  let name = base;
  let counter = 1;
  while (context.usedTypeNames.has(name)) {
    name = `${base}${++counter}`;
  }
  context.usedTypeNames.add(name);
  return name;
}

function unwrapPropertyType(type: unknown): unknown {
  if (typeof type === 'function') {
    const candidate = type as Function;
    if (candidate.prototype !== undefined && candidate !== Function.prototype) {
      return candidate;
    }
    try {
      const resolved = candidate();
      if (typeof resolved === 'function') return resolved;
      return resolved;
    } catch {
      return undefined;
    }
  }
  return type;
}

function normalizeKeyArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : undefined))
      .filter((item): item is string => Boolean(item));
  }
  return typeof value === 'string' ? [value] : [];
}

function resolvePartnerRelation(
  targetDefinition: ModelDefinition | undefined,
  sourceCtor: typeof Entity,
): { name?: string; relation?: RelationDefinitionMap[string] } {
  if (!targetDefinition?.relations) return {};
  const relations = targetDefinition.relations as RelationDefinitionMap;
  for (const [name, rel] of Object.entries(relations)) {
    const resolver = rel?.target;
    if (typeof resolver !== 'function') continue;
    let candidate: typeof Entity | undefined;
    try {
      candidate = resolver() as typeof Entity | undefined;
    } catch {
      candidate = undefined;
    }
    if (candidate === sourceCtor) {
      return { name, relation: rel };
    }
  }
  return {};
}

function collectReferentialConstraints(
  relation: RelationDefinitionMap[string],
  sourceDefinition: ModelDefinition | undefined,
  targetDefinition: ModelDefinition | undefined,
): Array<{ property: string; referencedProperty: string }> {
  if ((relation as AnyObject)?.targetsMany) return [];
  if (!sourceDefinition?.properties) return [];
  const dependentKeys = normalizeKeyArray((relation as AnyObject)?.keyFrom);
  if (!dependentKeys.length) return [];

  const sourceProperties = sourceDefinition.properties ?? {};
  const seen = new Set<string>();
  const filtered = dependentKeys.filter((prop) => {
    if (seen.has(prop)) return false;
    if (!Object.prototype.hasOwnProperty.call(sourceProperties, prop)) return false;
    seen.add(prop);
    return true;
  });
  if (!filtered.length) return [];

  const targetProps = targetDefinition?.properties ?? {};
  const targetKeys = targetDefinition?.idProperties?.() ?? ['id'];
  const keyToValues = normalizeKeyArray((relation as AnyObject)?.keyTo);
  const fallbackKey = targetKeys[0] ?? 'id';
  const resolveTargetKey = (index: number): string => {
    const candidate = keyToValues[index] ?? keyToValues[0];
    if (candidate && Object.prototype.hasOwnProperty.call(targetProps, candidate)) {
      return candidate;
    }
    const idCandidate = targetKeys[index] ?? fallbackKey;
    if (idCandidate && Object.prototype.hasOwnProperty.call(targetProps, idCandidate)) {
      return idCandidate;
    }
    return candidate ?? fallbackKey;
  };

  return filtered.map((property, index) => ({
    property,
    referencedProperty: resolveTargetKey(index),
  }));
}

function buildVocabularyReferencesXml(): string[] {
  const blocks: string[] = [];
  for (const reference of VOCABULARY_REFERENCES) {
    const includeAttrs = [`Namespace="${xmlEscape(reference.namespace)}"`];
    if (reference.alias) {
      includeAttrs.push(`Alias="${xmlEscape(reference.alias)}"`);
    }
    blocks.push(
      `  <edmx:Reference Uri="${xmlEscape(reference.uri)}">`,
      `    <edmx:Include ${includeAttrs.join(' ')} />`,
      '  </edmx:Reference>',
    );
  }
  return blocks;
}

function buildVocabularyReferencesJson(): Record<string, unknown> {
  const references: Record<string, unknown> = {};
  for (const reference of VOCABULARY_REFERENCES) {
    const includeEntry: Record<string, string> = { $Namespace: reference.namespace };
    if (reference.alias) {
      includeEntry.$Alias = reference.alias;
    }
    references[reference.uri] = {
      $Include: [includeEntry],
    };
  }
  return references;
}

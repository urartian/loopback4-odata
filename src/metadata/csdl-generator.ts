import { BindingScope, inject, injectable } from '@loopback/core';
import { Entity, ModelDefinition, PropertyDefinition, RelationDefinitionMap } from '@loopback/repository';
import { EntitySetDef, EntitySetRegistry } from '../registry/entityset-registry';
import { ODATA_BINDINGS } from '../keys';
import { getODataActions, getODataFunctions, OperationMeta } from '../decorators/action.function.decorators';
import { ODataConfig, ODataCapabilitiesConfig, ODataCapabilityDefaults, ODataNavigationRestriction, ODataEntityPermission } from '../types';

const EDM_NAMESPACE = 'http://docs.oasis-open.org/odata/ns/edm';
const EDMX_NAMESPACE = 'http://docs.oasis-open.org/odata/ns/edmx';

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
        navigationRestrictions: Object.keys(navigationRestrictions).length ? navigationRestrictions : undefined,
        navigationRestrictionDefaults: defaults?.navigationRestrictionDefaults,
        permissions: overrides?.permissions ?? defaults?.permissions,
        hasStream: overrides?.hasStream ?? defaults?.hasStream,
    };
}

function registerEnumType(
    context: SchemaBuildContext,
    ownerName: string,
    propertyName: string,
    values: unknown[],
): string | undefined {
    if (!values.length) return undefined;
    const nonNullValues = values.filter(v => v !== undefined && v !== null);
    if (!nonNullValues.length) return undefined;

    const isNumeric = nonNullValues.every(v => typeof v === 'number' && Number.isFinite(v as number));
    const isString = nonNullValues.every(v => typeof v === 'string');
    if (!isNumeric && !isString) return undefined;

    const baseName = `${ownerName}${capitalize(propertyName)}Enum`;
    const enumName = reserveTypeName(context, baseName);
    const underlyingType = isNumeric
        ? nonNullValues.some(v => Math.abs(v as number) > 2147483647)
            ? 'Edm.Int64'
            : 'Edm.Int32'
        : 'Edm.String';

    const numericValues = isNumeric ? (nonNullValues as number[]) : [];
    const hasNonZero = numericValues.some(v => v !== 0);
    const isFlags = isNumeric && numericValues.every(v => v === 0 || (v & (v - 1)) === 0) && hasNonZero;

    const seenNames = new Set<string>();
    const membersXml: string[] = [];
    const membersJson: Array<Record<string, unknown>> = [];

    nonNullValues.forEach((value, index) => {
        const nameCandidate = sanitizeEnumMemberName(value ?? index);
        let memberName = nameCandidate;
        let counter = 1;
        while (seenNames.has(memberName)) {
            memberName = `${nameCandidate}_${++counter}`;
        }
        seenNames.add(memberName);
        const valueAttr = isNumeric ? String(value) : xmlEscape(String(value));
        membersXml.push(
            `    <Member Name="${xmlEscape(memberName)}"${isNumeric ? ` Value="${valueAttr}"` : ` Value="${valueAttr}"`} />`,
        );
        const memberJson: Record<string, unknown> = { Name: memberName };
        if (isNumeric || isString) {
            memberJson.Value = value;
        }
        membersJson.push(memberJson);
    });

    const attributes: string[] = [`Name="${xmlEscape(enumName)}"`];
    if (underlyingType !== 'Edm.Int32') {
        attributes.push(`UnderlyingType="${underlyingType}"`);
    }
    if (isFlags) {
        attributes.push('IsFlags="true"');
    }

    const xml = [
        `    <EnumType ${attributes.join(' ')}>`,
        ...membersXml,
        '    </EnumType>',
    ].join('\n');

    const enumJson: Record<string, unknown> = {
        $Kind: 'EnumType',
    };
    if (underlyingType !== 'Edm.Int32') {
        enumJson.$UnderlyingType = underlyingType;
    }
    if (isFlags) {
        enumJson.$IsFlags = true;
    }
    enumJson.Members = membersJson;

    context.enumTypes.set(enumName, { name: enumName, xml, json: enumJson });
    return `${context.namespace}.${enumName}`;
}

function ensureComplexType(ctor: Function, context: SchemaBuildContext): ComplexTypeResult | undefined {
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
    const json: Record<string, unknown> = {$Kind: 'ComplexType'};
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
        const propertySchema: Record<string, unknown> = {$Type: resolved.type};
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
    const schemaType = typeof schemaAny?.type === 'string' ? String(schemaAny.type).toLowerCase() : undefined;
    const format = typeof schemaAny?.format === 'string' ? String(schemaAny.format).toLowerCase() : undefined;
    const dataType = typeof schemaAny?.dataType === 'string' ? String(schemaAny.dataType).toLowerCase() : undefined;

    const fromMap = PRIMITIVE_TYPE_MAP.get(type) ?? PRIMITIVE_TYPE_MAP.get(
        typeof type === 'function' ? type.name : type as string,
    );
    if (fromMap === 'Edm.Double' && (schemaType === 'integer' || format === 'int32' || format === 'int64' || dataType === 'integer')) {
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

    if (format === 'decimal' || dataType === 'decimal' || schemaAny?.precision != null || schemaAny?.scale != null) {
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

    if (Array.isArray(type) || type === 'array' || (schemaAny?.type === 'array')) {
        const itemsSchema = schemaAny?.items as Record<string, unknown> | undefined;
        const explicitItemType = Array.isArray(type) ? type[0] : (def as unknown as { itemType?: unknown }).itemType;
        const effectiveItemType = unwrapPropertyType(explicitItemType ?? (itemsSchema?.type as unknown));
        const nestedDef: PropertyDefinition = {
            ...(itemsSchema as Record<string, unknown> | undefined),
            type: effectiveItemType ?? explicitItemType ?? (itemsSchema?.type as unknown),
        } as PropertyDefinition;
        const item = resolveEdmType(
            nestedDef,
            context,
            ownerName,
            propertyName,
        );
        const itemType = item?.type ?? 'Edm.String';
        return { type: `Collection(${itemType})` };
    }

    if (schemaAny && Array.isArray(schemaAny.enum) && schemaAny.enum.length) {
        const fqEnum = registerEnumType(context, ownerName, propertyName, schemaAny.enum);
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
    const modelDefinition = (def.modelCtor as typeof Entity).definition as ModelDefinition | undefined;
    if (!modelDefinition) return undefined;

    const entityName = modelDefinition.name ?? def.modelCtor.name;
    const { properties } = modelDefinition;
    const propertyLines: string[] = [];
    const keyProps = modelDefinition.idProperties();
    const json: Record<string, unknown> = { $Kind: 'EntityType' };
    if (keyProps.length) {
        json.$Key = keyProps;
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
        json['@Org.OData.Core.V1.HasStream'] = true;
    }

    const relations = (modelDefinition.relations ?? {}) as RelationDefinitionMap;
    for (const [relationName, relationDef] of Object.entries(relations)) {
        const resolver = relationDef?.target;
        if (typeof resolver !== 'function') continue;
        const targetModel = resolver() as typeof Entity | undefined;
        if (!targetModel) continue;

        const targetSet = setLookup.get(targetModel);
        if (!targetSet) continue;

        const targetDefinition = (targetModel as typeof Entity).definition as ModelDefinition | undefined;
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
            partnerInfo.relation,
            targetDefinition,
        );

        const navAttrs: string[] = [
            `Name="${xmlEscape(relationName)}"`,
            `Type="${qualifiedType}"`,
        ];
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
            navJson.$ReferentialConstraint = constraints.map(item => ({
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
            ...keyProps.map(name => `        <PropertyRef Name="${xmlEscape(name)}"/>`),
            '      </Key>',
        ].join('\n')
        : '';

    const xml = [
        `    <EntityType Name="${xmlEscape(entityName)}">`,
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

@injectable({ scope: BindingScope.SINGLETON })
export class CsdlGenerator {
    constructor(
        @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
        private readonly registry: EntitySetRegistry,
        @inject(ODATA_BINDINGS.CONFIG, { optional: true })
        private readonly cfg: ODataConfig = {},
    ) { }

    contentType(format: 'xml' | 'json' = 'xml'): string {
        return format === 'xml' ? 'application/xml' : 'application/json';
    }

    generate(format: 'xml' | 'json' = 'xml'): string {
        const entitySets = this.registry.list();
        const entityTypesXml: string[] = [];
        const complexTypesXml: string[] = [];
        const enumTypesXml: string[] = [];
        const containerSetsXml: string[] = [];
        const actionXml: string[] = [];
        const functionXml: string[] = [];
        const operationImportsXml: string[] = [];

        const jsonComplexTypes: Record<string, unknown> = {};
        const jsonEnumTypes: Record<string, unknown> = {};
        const jsonEntityTypes: Record<string, unknown> = {};
        const jsonEntitySets: Record<string, unknown> = {};
        const jsonActions: Record<string, unknown> = {};
        const jsonFunctions: Record<string, unknown> = {};
        const jsonImports: Record<string, unknown> = {};

        const namespace = this.normalizeNamespace(this.cfg?.namespace);
        const namespaceAlias = this.cfg?.namespaceAlias?.trim();
        const containerName = this.normalizeContainerName(this.cfg?.entityContainerName);
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

            const navigationBindings = entityType.navigationBindings.map(binding =>
                `        <NavigationPropertyBinding Path="${xmlEscape(binding.path)}" Target="${xmlEscape(binding.target)}" />`,
            );

            const concurrencyAnnotation = (set.etagProperties?.length ?? 0) > 0
                ? [
                    '        <Annotation Term="Org.OData.Core.V1.OptimisticConcurrency">',
                    '          <Collection>',
                    ...set.etagProperties!.map(prop => `            <PropertyPath>${xmlEscape(prop)}</PropertyPath>`),
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
                    ...filterFunctions.map(fn => `            <String>${xmlEscape(fn)}</String>`),
                    '          </Collection>',
                    '        </Annotation>',
                );
                capabilityAnnotationsJson['@Org.OData.Capabilities.V1.FilterFunctions'] = filterFunctions;
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
            const restrictedEntries = Object.entries(navigationRestrictions)
                .filter(([name, config]) => relationSet.has(name) && config != null && config.navigable !== undefined);

            if (restrictedEntries.length) {
                const restrictedXml: string[] = [];
                const restrictedJson: Array<Record<string, unknown>> = [];
                for (const [name, config] of restrictedEntries) {
                    const navigable = config?.navigable;
                    if (navigable === undefined) continue;
                    const enumMember = navigable === false
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
                            scopeJson.push({Scope: scopeEntry});
                        } else if (scopeEntry && typeof scopeEntry === 'object') {
                            const jsonScope: Record<string, unknown> = {Scope: scopeEntry.scope};
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

                    const permissionXml: string[] = ['          <Record Type="Org.OData.Core.V1.PermissionType">'];
                    const permissionJson: Record<string, unknown> = {};
                    if (permission.scheme) {
                        permissionXml.push(`            <PropertyValue Property="SchemeName" String="${xmlEscape(permission.scheme)}"/>`);
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
                entitySetJson['@Org.OData.Core.V1.OptimisticConcurrency'] = set.etagProperties.map(prop => ({
                    $PropertyPath: prop,
                }));
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

        const complexList = Array.from(context.complexTypes.values()).sort((a, b) => a.name.localeCompare(b.name));
        for (const complex of complexList) {
            complexTypesXml.push(complex.xml);
            jsonComplexTypes[complex.name] = complex.json;
        }

        const enumList = Array.from(context.enumTypes.values()).sort((a, b) => a.name.localeCompare(b.name));
        for (const enumType of enumList) {
            enumTypesXml.push(enumType.xml);
            jsonEnumTypes[enumType.name] = enumType.json;
        }

        if (format === 'json') {
            return this.buildJsonDocument(
                namespace,
                namespaceAlias,
                containerName,
                jsonEntityTypes,
                jsonEntitySets,
                jsonActions,
                jsonFunctions,
                jsonImports,
                jsonComplexTypes,
                jsonEnumTypes,
            );
        }

        const schemaOpenTag = namespaceAlias
            ? `    <Schema Namespace="${namespace}" Alias="${xmlEscape(namespaceAlias)}" xmlns="${EDM_NAMESPACE}">`
            : `    <Schema Namespace="${namespace}" xmlns="${EDM_NAMESPACE}">`;

        return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<edmx:Edmx Version="4.0" xmlns:edmx="${EDMX_NAMESPACE}">`,
            '  <edmx:DataServices>',
            schemaOpenTag,
            ...complexTypesXml,
            ...enumTypesXml,
            ...entityTypesXml,
            ...actionXml,
            ...functionXml,
            `      <EntityContainer Name="${containerName}">`,
            ...containerSetsXml,
            ...operationImportsXml,
            '      </EntityContainer>',
            '    </Schema>',
            '  </edmx:DataServices>',
            '</edmx:Edmx>',
        ].join('\n');
    }

    private normalizeNamespace(ns?: string): string {
        const trimmed = ns?.trim();
        if (!trimmed) return 'Default';
        return trimmed;
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
        entityTypes: Record<string, unknown>,
        entitySets: Record<string, unknown>,
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
        if (Object.keys(imports).length) {
            Object.assign(container, imports);
        }
        schema[containerName] = container;

        const doc = {
            $Version: '4.0',
            [namespace]: schema,
        };
        return JSON.stringify(doc, null, 2);
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
            const bindingType = op.binding === 'collection'
                ? `Collection(${qualifiedEntityXml})`
                : qualifiedEntityXml;
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
            const bindingType = op.binding === 'collection'
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
    inverse: RelationDefinitionMap[string] | undefined,
    targetDefinition: ModelDefinition | undefined,
): Array<{ property: string; referencedProperty: string }> {
    const constraints: Array<{ property: string; referencedProperty: string }> = [];
    const addConstraint = (property?: string | string[]) => {
        if (!property) return;
        const list = Array.isArray(property) ? property : [property];
        for (const prop of list) {
            if (!prop) continue;
            if (constraints.some(c => c.property === prop)) continue;
            constraints.push({ property: prop, referencedProperty: '' });
        }
    };

    addConstraint((relation as any)?.keyFrom);
    addConstraint((relation as any)?.keyTo);
    if (inverse) {
        addConstraint((inverse as any)?.keyFrom);
        addConstraint((inverse as any)?.keyTo);
    }

    if (!constraints.length) return constraints;

    const targetKeys = targetDefinition?.idProperties?.() ?? ['id'];
    const referenced = targetKeys[0] ?? 'id';
    return constraints.map(item => ({ property: item.property, referencedProperty: referenced }));
}

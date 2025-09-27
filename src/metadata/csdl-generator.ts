import { BindingScope, inject, injectable } from '@loopback/core';
import { Entity, ModelDefinition, PropertyDefinition, RelationDefinitionMap } from '@loopback/repository';
import { EntitySetDef, EntitySetRegistry } from '../registry/entityset-registry';
import { ODATA_BINDINGS } from '../keys';
import { getODataActions, getODataFunctions, OperationMeta } from '../decorators/action.function.decorators';

const EDM_NAMESPACE = 'http://docs.oasis-open.org/odata/ns/edm';
const EDMX_NAMESPACE = 'http://docs.oasis-open.org/odata/ns/edmx';

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
]);

function resolveEdmType(def: PropertyDefinition): string | undefined {
    const { type } = def;
    if (type == null) return undefined;

    if (Array.isArray(type)) {
        // Arrays are not supported in Phase 2.2.
        return undefined;
    }

    if (typeof type === 'function' && 'modelName' in type) {
        // Relations / complex types not yet supported.
        return undefined;
    }

    if (PRIMITIVE_TYPE_MAP.has(type)) {
        return PRIMITIVE_TYPE_MAP.get(type);
    }

    const typeName = typeof type === 'function' ? type.name : String(type);
    if (PRIMITIVE_TYPE_MAP.has(typeName)) {
        return PRIMITIVE_TYPE_MAP.get(typeName);
    }

    return undefined;
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
}

function buildEntityType(
    def: EntitySetDef,
    namespace: string,
    setLookup: Map<typeof Entity, EntitySetDef>,
): EntityTypeResult | undefined {
    const modelDefinition = (def.modelCtor as typeof Entity).definition as ModelDefinition | undefined;
    if (!modelDefinition) return undefined;

    const entityName = modelDefinition.name ?? def.modelCtor.name;
    const { properties } = modelDefinition;
    const propertyLines: string[] = [];
    const keyProps = modelDefinition.idProperties();
    const navigationLines: string[] = [];
    const navigationBindings: NavigationBinding[] = [];

    for (const [propertyName, propertyMeta] of Object.entries(properties)) {
        const propertyDef = propertyMeta as PropertyDefinition;
        const edmType = resolveEdmType(propertyDef);
        if (!edmType) continue;

        const isRequired = Boolean(propertyDef.required) || Boolean(propertyDef.id);
        const nullable = isRequired ? 'false' : 'true';
        const concurrency = def.etagProperty && def.etagProperty === propertyName ? ' ConcurrencyMode="Fixed"' : '';
        propertyLines.push(
            `      <Property Name="${xmlEscape(propertyName)}" Type="${edmType}" Nullable="${nullable}"${concurrency}/>`,
        );
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

        const qualifiedType = relationDef.targetsMany
            ? `Collection(${namespace}.${xmlEscape(targetEntityName)})`
            : `${namespace}.${xmlEscape(targetEntityName)}`;

        navigationLines.push(
            `      <NavigationProperty Name="${xmlEscape(relationName)}" Type="${qualifiedType}" />`,
        );
        navigationBindings.push({ path: relationName, target: targetSet.name });
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
        ...navigationLines,
        '    </EntityType>',
    ]
        .filter(Boolean)
        .join('\n');

    return { name: entityName, xml, navigationBindings };
}

@injectable({ scope: BindingScope.SINGLETON })
export class CsdlGenerator {
    constructor(
        @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
        private readonly registry: EntitySetRegistry,
    ) { }

    contentType(format: 'xml' | 'json' = 'xml'): string {
        return format === 'xml' ? 'application/xml' : 'application/json';
    }

    generate(): string {
        const entitySets = this.registry.list();
        const entityTypes: string[] = [];
        const containerSets: string[] = [];
        const actionSchemas: string[] = [];
        const functionSchemas: string[] = [];
        const operationImports: string[] = [];
        const namespace = 'Default';
        const containerName = 'DefaultContainer';

        const setLookup = new Map<typeof Entity, EntitySetDef>();
        for (const set of entitySets) {
            setLookup.set(set.modelCtor, set);
        }

        for (const set of entitySets) {
            const entityType = buildEntityType(set, namespace, setLookup);
            if (!entityType) continue;

            entityTypes.push(entityType.xml);
            const navigationBindings = entityType.navigationBindings.map(binding =>
                `        <NavigationPropertyBinding Path="${xmlEscape(binding.path)}" Target="${xmlEscape(binding.target)}" />`,
            );

            const concurrencyAnnotation = set.etagProperty
                ? [
                    '        <Annotation Term="Org.OData.Core.V1.OptimisticConcurrency">',
                    '          <Collection>',
                    `            <PropertyPath>${xmlEscape(set.etagProperty)}</PropertyPath>`,
                    '          </Collection>',
                    '        </Annotation>',
                ]
                : [];

            const entitySetLines = [
                `      <EntitySet Name="${xmlEscape(set.name)}" EntityType="${namespace}.${xmlEscape(entityType.name)}">`,
                ...navigationBindings,
                ...concurrencyAnnotation,
                '      </EntitySet>',
            ];

            const hasChildren = navigationBindings.length || concurrencyAnnotation.length;
            containerSets.push(
                hasChildren ? entitySetLines.join('\n') : entitySetLines[0].replace(/>$/, '/>'),
            );

            const entityName = (set.modelCtor as typeof Entity).definition?.name ?? set.modelCtor.name;
            const actions = set.actions ?? [];
            for (const action of actions) {
                const { schema, importLine } = this.buildOperationSchema('Action', action, namespace, entityName, set.name);
                actionSchemas.push(schema);
                if (importLine) operationImports.push(importLine);
            }

            const functions = set.functions ?? [];
            for (const fn of functions) {
                const { schema, importLine } = this.buildOperationSchema('Function', fn, namespace, entityName, set.name);
                functionSchemas.push(schema);
                if (importLine) operationImports.push(importLine);
            }
        }

        return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<edmx:Edmx Version="4.0" xmlns:edmx="${EDMX_NAMESPACE}">`,
            '  <edmx:DataServices>',
            `    <Schema Namespace="${namespace}" xmlns="${EDM_NAMESPACE}">`,
            ...entityTypes,
            ...actionSchemas,
            ...functionSchemas,
            `      <EntityContainer Name="${containerName}">`,
            ...containerSets,
            ...operationImports,
            '      </EntityContainer>',
            '    </Schema>',
            '  </edmx:DataServices>',
            '</edmx:Edmx>',
        ].join('\n');
    }

    private buildOperationSchema(
        kind: 'Action' | 'Function',
        op: OperationMeta,
        namespace: string,
        entityName: string | undefined,
        setName: string,
    ) {
        const isBound = op.binding !== 'unbound';
        const lines: string[] = [];
        const qualifiedEntity = entityName ? `${namespace}.${xmlEscape(entityName)}` : undefined;

        if (isBound && qualifiedEntity) {
            const bindingType = op.binding === 'collection'
                ? `Collection(${qualifiedEntity})`
                : qualifiedEntity;
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
        if (!isBound) {
            const importTag = kind === 'Action' ? 'ActionImport' : 'FunctionImport';
            importLine = `      <${importTag} Name="${name}" ${kind}="${namespace}.${name}" />`;
        }

        return { schema: schemaLines.join('\n'), importLine };
    }
}

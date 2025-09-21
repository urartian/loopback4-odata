import { BindingScope, inject, injectable } from '@loopback/core';
import { Entity, ModelDefinition, PropertyDefinition } from '@loopback/repository';
import { EntitySetDef, EntitySetRegistry } from '../registry/entityset-registry';
import { ODATA_BINDINGS } from '../keys';

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

function buildEntityType(def: EntitySetDef): { name: string; xml: string } | undefined {
    const modelDefinition = (def.modelCtor as typeof Entity).definition as ModelDefinition | undefined;
    if (!modelDefinition) return undefined;

    const entityName = modelDefinition.name ?? def.modelCtor.name;
    const { properties } = modelDefinition;
    const propertyLines: string[] = [];
    const keyProps = modelDefinition.idProperties();

    for (const [propertyName, propertyMeta] of Object.entries(properties)) {
        const propertyDef = propertyMeta as PropertyDefinition;
        const edmType = resolveEdmType(propertyDef);
        if (!edmType) continue;

        const isRequired = Boolean(propertyDef.required) || Boolean(propertyDef.id);
        const nullable = isRequired ? 'false' : 'true';
        propertyLines.push(
            `      <Property Name="${xmlEscape(propertyName)}" Type="${edmType}" Nullable="${nullable}"/>`,
        );
    }

    if (!propertyLines.length) return undefined;

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
        '    </EntityType>',
    ]
        .filter(Boolean)
        .join('\n');

    return { name: entityName, xml };
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
        const namespace = 'Default';
        const containerName = 'DefaultContainer';

        for (const set of entitySets) {
            const entityType = buildEntityType(set);
            if (!entityType) continue;

            entityTypes.push(entityType.xml);
            containerSets.push(
                `      <EntitySet Name="${xmlEscape(set.name)}" EntityType="${namespace}.${xmlEscape(entityType.name)}"/>`,
            );
        }

        return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<edmx:Edmx Version="4.0" xmlns:edmx="${EDMX_NAMESPACE}">`,
            '  <edmx:DataServices>',
            `    <Schema Namespace="${namespace}" xmlns="${EDM_NAMESPACE}">`,
            ...entityTypes,
            `      <EntityContainer Name="${containerName}">`,
            ...containerSets,
            '      </EntityContainer>',
            '    </Schema>',
            '  </edmx:DataServices>',
            '</edmx:Edmx>',
        ].join('\n');
    }
}

import {
  AnyObject,
  Entity,
  Model,
  ModelDefinition,
  PropertyDefinition,
  buildModelDefinition,
} from '@loopback/repository';
import { ensureModelDefinitionWithRelations } from './model-definition';

export type PrimitivePropertyKind = 'string' | 'number' | 'boolean' | 'date' | 'buffer';

export interface StructuredPropertyNode {
  primitiveProps: Map<string, PrimitivePropertyKind>;
  structuredProps: Map<string, StructuredPropertyNode>;
}

interface StructuredBuildContext {
  modelCtors: Set<Function>;
  schemaObjects: Set<object>;
}

interface ResolvedJsonSchema {
  schema: AnyObject;
  definitions?: Record<string, AnyObject>;
}

export interface StructuredPropertyResolution {
  rootProperty: string;
  jsonPath: string[];
  primitiveKind: PrimitivePropertyKind;
}

const structuredMetadataCache = new WeakMap<Function, Map<string, StructuredPropertyNode>>();

export function classifyPrimitiveProperty(
  definition: PropertyDefinition | undefined,
): PrimitivePropertyKind | undefined {
  if (!definition) return undefined;
  const jsonSchema = (definition as AnyObject)?.jsonSchema ?? {};
  const schemaType =
    typeof jsonSchema.type === 'string' ? jsonSchema.type.toLowerCase() : undefined;
  const schemaFormat =
    typeof jsonSchema.format === 'string' ? jsonSchema.format.toLowerCase() : undefined;
  const rawType = (definition as AnyObject)?.type;
  const normalizedType =
    typeof rawType === 'function'
      ? rawType.name.toLowerCase()
      : typeof rawType === 'string'
        ? rawType.toLowerCase()
        : undefined;

  const candidates = [
    normalizedType,
    schemaType,
    schemaFormat === 'binary' || schemaFormat === 'base64' || schemaFormat === 'byte'
      ? 'buffer'
      : undefined,
  ].filter(Boolean) as string[];

  const candidate = candidates[0];
  if (candidate === 'string') return 'string';
  if (
    candidate === 'number' ||
    candidate === 'float' ||
    candidate === 'double' ||
    candidate === 'decimal' ||
    candidate === 'integer'
  ) {
    return 'number';
  }
  if (candidate === 'boolean') return 'boolean';
  if (
    candidate === 'date' ||
    candidate === 'datetime' ||
    candidate === 'datetimeoffset' ||
    schemaFormat === 'date-time' ||
    schemaFormat === 'date'
  ) {
    return 'date';
  }
  if (candidate === 'buffer' || candidate === 'binary') return 'buffer';

  if (rawType === String) return 'string';
  if (rawType === Number) return 'number';
  if (rawType === Boolean) return 'boolean';
  if (rawType === Date) return 'date';
  if (typeof Buffer !== 'undefined' && rawType === Buffer) return 'buffer';

  return undefined;
}

export function getStructuredPropertyMetadata(
  modelCtor: typeof Entity | typeof Model,
): Map<string, StructuredPropertyNode> {
  if (!modelCtor) return new Map<string, StructuredPropertyNode>();
  const cached = structuredMetadataCache.get(modelCtor);
  if (cached) return cached;
  const metadata = buildStructuredPropertyMetadata(modelCtor);
  structuredMetadataCache.set(modelCtor, metadata);
  return metadata;
}

export function resolveStructuredPropertyPath(
  modelCtor: typeof Entity,
  propertyPath: string,
): StructuredPropertyResolution | undefined {
  const segments = propertyPath.split('/').filter(Boolean);
  return resolveStructuredPropertySegments(modelCtor, segments);
}

export function resolveStructuredPropertySegments(
  modelCtor: typeof Entity,
  segments: string[],
): StructuredPropertyResolution | undefined {
  if (!modelCtor || !segments.length) return undefined;
  const [root, ...rest] = segments;
  if (!root) return undefined;
  const definition = getModelPropertyDefinition(modelCtor, root);
  if (!definition) return undefined;
  const primitiveKind = classifyPrimitiveProperty(definition);
  if (!rest.length) {
    if (!primitiveKind) return undefined;
    return { rootProperty: root, jsonPath: [], primitiveKind };
  }
  if (primitiveKind) return undefined;
  const metadata = getStructuredPropertyMetadata(modelCtor).get(root);
  if (!metadata) return undefined;
  const childResolution = resolveStructuredNodePath(metadata, rest);
  if (!childResolution) return undefined;
  return {
    rootProperty: root,
    jsonPath: rest,
    primitiveKind: childResolution,
  };
}

function resolveStructuredNodePath(
  node: StructuredPropertyNode,
  segments: string[],
): PrimitivePropertyKind | undefined {
  if (!segments.length) return undefined;
  const [current, ...rest] = segments;
  if (!current) return undefined;
  if (!rest.length) {
    return node.primitiveProps.get(current);
  }
  const child = node.structuredProps.get(current);
  if (!child) return undefined;
  return resolveStructuredNodePath(child, rest);
}

function buildStructuredPropertyMetadata(
  modelCtor: typeof Entity | typeof Model,
): Map<string, StructuredPropertyNode> {
  const metadata = new Map<string, StructuredPropertyNode>();
  const definition =
    ensureModelDefinitionWithRelations(modelCtor as typeof Entity) ?? getModelDefinition(modelCtor);
  if (!definition) return metadata;
  const ctx = createStructuredBuildContext();
  for (const [name, propDef] of Object.entries(definition.properties ?? {})) {
    const node = buildStructuredPropertyNode(propDef as PropertyDefinition | undefined, ctx);
    if (node) {
      metadata.set(name, node);
    }
  }
  return metadata;
}

function getModelDefinition(modelCtor: typeof Entity | typeof Model): ModelDefinition | undefined {
  if (!modelCtor) return undefined;
  let definition = (modelCtor as AnyObject).definition as ModelDefinition | undefined;
  if (definition) return definition;
  try {
    buildModelDefinition(modelCtor as typeof Entity & { definition?: ModelDefinition });
  } catch {
    // ignore and fall through
  }
  definition = (modelCtor as AnyObject).definition as ModelDefinition | undefined;
  return definition;
}

function getModelPropertyDefinition(
  modelCtor: typeof Entity | typeof Model,
  propertyName: string,
): PropertyDefinition | undefined {
  const definition = getModelDefinition(modelCtor);
  return definition?.properties?.[propertyName] as PropertyDefinition | undefined;
}

function buildStructuredPropertyNode(
  propDef: PropertyDefinition | undefined,
  ctx: StructuredBuildContext,
): StructuredPropertyNode | undefined {
  if (!propDef) return undefined;
  if (classifyPrimitiveProperty(propDef)) return undefined;
  if (isArrayPropertyDefinition(propDef)) return undefined;
  const structuredCtor = resolveStructuredPropertyCtor(propDef);
  if (structuredCtor) {
    return buildStructuredNodeFromModelCtor(structuredCtor, ctx);
  }
  const schema = (propDef as AnyObject)?.jsonSchema;
  if (schema && typeof schema === 'object') {
    return buildStructuredNodeFromJsonSchema(schema as AnyObject, ctx);
  }
  return undefined;
}

function resolveStructuredPropertyCtor(
  propDef: PropertyDefinition | undefined,
): typeof Model | undefined {
  if (!propDef) return undefined;
  const rawType = (propDef as AnyObject)?.type;
  return resolveStructuredCtor(rawType);
}

function resolveStructuredCtor(candidate: unknown): typeof Model | undefined {
  if (!candidate) return undefined;
  if (isStructuredModelCtor(candidate)) {
    return candidate as typeof Model;
  }
  if (typeof candidate === 'function') {
    try {
      const resolved = (candidate as () => unknown)();
      if (isStructuredModelCtor(resolved)) {
        return resolved as typeof Model;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isStructuredModelCtor(value: unknown): value is typeof Model {
  return typeof value === 'function' && value.prototype instanceof Model;
}

function isArrayPropertyDefinition(definition: PropertyDefinition | undefined): boolean {
  if (!definition) return false;
  const rawType = (definition as AnyObject)?.type;
  if (rawType === Array) return true;
  if (typeof rawType === 'string' && rawType.toLowerCase() === 'array') {
    return true;
  }
  const schemaType = (definition as AnyObject)?.jsonSchema?.type;
  return typeof schemaType === 'string' && schemaType.toLowerCase() === 'array';
}

function buildStructuredNodeFromModelCtor(
  ctor: typeof Model,
  ctx: StructuredBuildContext,
): StructuredPropertyNode | undefined {
  if (!ctor || ctx.modelCtors.has(ctor)) return undefined;
  ctx.modelCtors.add(ctor);
  try {
    const definition =
      ensureModelDefinitionWithRelations(ctor as unknown as typeof Entity) ??
      getModelDefinition(ctor);
    return buildStructuredNodeFromDefinition(definition, ctx);
  } finally {
    ctx.modelCtors.delete(ctor);
  }
}

function buildStructuredNodeFromDefinition(
  definition: ModelDefinition | undefined,
  ctx: StructuredBuildContext,
): StructuredPropertyNode | undefined {
  if (!definition) return undefined;
  const node: StructuredPropertyNode = {
    primitiveProps: new Map<string, PrimitivePropertyKind>(),
    structuredProps: new Map<string, StructuredPropertyNode>(),
  };
  for (const [name, propDef] of Object.entries(definition.properties ?? {})) {
    const primitiveKind = classifyPrimitiveProperty(propDef as PropertyDefinition | undefined);
    if (primitiveKind) {
      node.primitiveProps.set(name, primitiveKind);
      continue;
    }
    const childNode = buildStructuredPropertyNode(propDef as PropertyDefinition | undefined, ctx);
    if (childNode) {
      node.structuredProps.set(name, childNode);
    }
  }
  if (!node.primitiveProps.size && !node.structuredProps.size) return undefined;
  return node;
}

function buildStructuredNodeFromJsonSchema(
  schemaInput: AnyObject,
  ctx: StructuredBuildContext,
  inheritedDefinitions?: Record<string, AnyObject>,
): StructuredPropertyNode | undefined {
  const resolved = resolveJsonSchemaWithRefs(schemaInput, inheritedDefinitions);
  if (!resolved) return undefined;
  const schema = resolved.schema;
  if (!schema || typeof schema !== 'object') return undefined;
  const properties = (schema as AnyObject).properties;
  if (!properties || typeof properties !== 'object') return undefined;
  if (ctx.schemaObjects.has(schema)) return undefined;
  ctx.schemaObjects.add(schema);
  const node: StructuredPropertyNode = {
    primitiveProps: new Map<string, PrimitivePropertyKind>(),
    structuredProps: new Map<string, StructuredPropertyNode>(),
  };
  for (const [name, propSchemaRaw] of Object.entries(properties as Record<string, AnyObject>)) {
    if (!propSchemaRaw || typeof propSchemaRaw !== 'object') continue;
    const propResolved = resolveJsonSchemaWithRefs(
      propSchemaRaw as AnyObject,
      resolved.definitions,
    );
    if (!propResolved) continue;
    const pseudoDefinition = { jsonSchema: propResolved.schema } as PropertyDefinition;
    const primitiveKind = classifyPrimitiveProperty(pseudoDefinition);
    if (primitiveKind) {
      node.primitiveProps.set(name, primitiveKind);
      continue;
    }
    if (!schemaRepresentsStructured(propResolved.schema)) continue;
    const childNode = buildStructuredNodeFromJsonSchema(
      propResolved.schema,
      ctx,
      propResolved.definitions,
    );
    if (childNode) {
      node.structuredProps.set(name, childNode);
    }
  }
  ctx.schemaObjects.delete(schema);
  if (!node.primitiveProps.size && !node.structuredProps.size) return undefined;
  return node;
}

function resolveJsonSchemaWithRefs(
  schemaInput: AnyObject,
  inheritedDefinitions?: Record<string, AnyObject>,
): ResolvedJsonSchema | undefined {
  if (!schemaInput || typeof schemaInput !== 'object') return undefined;
  const visited = new Set<string>();
  let current = schemaInput;
  let definitions: Record<string, AnyObject> = { ...(inheritedDefinitions ?? {}) };
  const collectDefinitions = (candidate?: AnyObject) => {
    const local = candidate?.definitions;
    if (local && typeof local === 'object') {
      definitions = { ...definitions, ...(local as Record<string, AnyObject>) };
    }
  };
  collectDefinitions(current);
  while (typeof current.$ref === 'string') {
    const ref = current.$ref as string;
    if (!ref.startsWith('#/definitions/')) return undefined;
    if (visited.has(ref)) return undefined;
    visited.add(ref);
    const key = ref.slice('#/definitions/'.length);
    const target = definitions[key];
    if (!target || typeof target !== 'object') {
      return undefined;
    }
    current = target as AnyObject;
    collectDefinitions(current);
  }
  return { schema: current as AnyObject, definitions };
}

function schemaRepresentsStructured(schema: AnyObject): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const schemaType = typeof schema.type === 'string' ? schema.type.toLowerCase() : undefined;
  if (schemaType === 'object') return true;
  if (schema.properties && typeof schema.properties === 'object') return true;
  return false;
}

function createStructuredBuildContext(): StructuredBuildContext {
  return {
    modelCtors: new Set<Function>(),
    schemaObjects: new Set<object>(),
  };
}

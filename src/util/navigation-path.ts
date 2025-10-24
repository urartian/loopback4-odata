import {AnyObject, Entity, ModelDefinition} from '@loopback/repository';
import {ensureNavigationTargetKey} from './relation-metadata';

type RelationMeta = AnyObject & {
  name?: string;
  type?: string;
  relationType?: string;
  source?: typeof Entity;
  target?: (() => typeof Entity) | typeof Entity;
  keyFrom?: string;
  keyTo?: string;
  through?: AnyObject;
};

export type SupportedRelationType = 'hasMany' | 'hasOne' | 'belongsTo';

export interface NavigationJoinSegment {
  relationName: string;
  relationType: SupportedRelationType;
  sourceModel: typeof Entity;
  targetModel: typeof Entity;
  sourceKey: string;
  targetKey: string;
}

export interface ResolvedNavigationPath {
  originalPath: string;
  joins: NavigationJoinSegment[];
  propertyPath?: string;
  targetModel: typeof Entity;
}

export class NavigationPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavigationPathError';
  }
}

export function resolveNavigationPath(
  modelCtor: typeof Entity,
  path: string,
  options: {maxDepth?: number} = {},
): ResolvedNavigationPath {
  const segments = (path ?? '').split('/').filter(Boolean);
  if (!segments.length) {
    throw new NavigationPathError('Navigation path must contain at least one segment.');
  }

  const joins: NavigationJoinSegment[] = [];
  const maxDepth = options.maxDepth ?? 5;

  let currentModel = modelCtor;
  let propertyStart = segments.length;

  for (let i = 0; i < segments.length; i++) {
    if (i >= maxDepth) {
      throw new NavigationPathError(
        `Navigation path "${path}" exceeds the maximum depth of ${maxDepth}.`,
      );
    }
    const segment = segments[i];
    const relationMeta = getRelationMeta(currentModel, segment);
    if (!relationMeta) {
      propertyStart = i;
      break;
    }
    if (relationMeta.through) {
      throw new NavigationPathError(
        `Navigation path "${path}" references relation "${segment}" using hasManyThrough, which is not supported for $apply pushdown.`,
      );
    }
    const relationType = normalizeRelationType(relationMeta);
    if (!relationType) {
      throw new NavigationPathError(
        `Navigation path "${path}" references relation "${segment}" with unsupported type.`,
      );
    }
    const targetModel = resolveRelationTarget(relationMeta);
    if (!targetModel) {
      throw new NavigationPathError(
        `Navigation path "${path}" cannot resolve target model for relation "${segment}".`,
      );
    }
    const join = buildJoinSegment(currentModel, targetModel, relationMeta, relationType);
    joins.push(join);
    currentModel = targetModel;
  }

  const originalPath = path;

  if (!joins.length) {
    return {
      originalPath,
      joins: [],
      propertyPath: segments.join('/'),
      targetModel: currentModel,
    };
  }

  const propertySegments = segments.slice(propertyStart);
  return {
    originalPath,
    joins,
    propertyPath: propertySegments.length ? propertySegments.join('/') : undefined,
    targetModel: currentModel,
  };
}

function getRelationMeta(modelCtor: typeof Entity, name: string): RelationMeta | undefined {
  const definition = getModelDefinition(modelCtor);
  const relations = (definition?.relations ?? {}) as Record<string, RelationMeta>;
  return relations[name];
}

function getModelDefinition(modelCtor: typeof Entity): ModelDefinition | undefined {
  return (modelCtor as AnyObject).definition as ModelDefinition | undefined;
}

function normalizeRelationType(meta: RelationMeta): SupportedRelationType | undefined {
  const type = (meta.relationType ?? meta.type ?? '').toLowerCase();
  if (type === 'hasmany') return 'hasMany';
  if (type === 'hasone') return 'hasOne';
  if (type === 'belongsto') return 'belongsTo';
  return undefined;
}

function resolveRelationTarget(meta: RelationMeta): typeof Entity | undefined {
  const resolver = meta.target;
  if (!resolver) return undefined;
  return unwrapRelationTarget(meta, resolver, new Set());
}

function unwrapRelationTarget(
  meta: RelationMeta,
  candidate: unknown,
  visited: Set<unknown>,
): typeof Entity | undefined {
  if (!candidate) return undefined;
  if (visited.has(candidate)) return undefined;
  visited.add(candidate);

  if (isEntityConstructor(candidate as AnyObject)) {
    return candidate as typeof Entity;
  }

  if (typeof candidate === 'function') {
    if (isEntityConstructor(candidate as AnyObject)) {
      return candidate as typeof Entity;
    }
    if (candidate.length === 0 && !isPromiseHandler(candidate)) {
      try {
        const result = (candidate as () => unknown)();
        const resolved = unwrapRelationTarget(meta, result, visited);
        if (resolved) return resolved;
      } catch {
        // Ignore errors from invoking resolver candidates and continue probing
      }
    }
  }

  if (typeof candidate === 'string') {
    const resolved = resolveModelByName(meta, candidate, visited);
    if (resolved) return resolved;
  }

  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      const resolved = unwrapRelationTarget(meta, entry, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (candidate instanceof Map) {
    for (const value of candidate.values()) {
      const resolved = unwrapRelationTarget(meta, value, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (candidate instanceof Set) {
    for (const value of candidate.values()) {
      const resolved = unwrapRelationTarget(meta, value, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (typeof candidate === 'object') {
    const record = candidate as AnyObject;
    for (const value of Object.values(record)) {
      if (typeof value === 'function' && (value as AnyObject).length !== 0) continue;
      const resolved = unwrapRelationTarget(meta, value, visited);
      if (resolved) return resolved;
    }
  }

  return undefined;
}

function resolveModelByName(
  meta: RelationMeta,
  name: string,
  visited: Set<unknown>,
): typeof Entity | undefined {
  const source = meta.source as AnyObject | undefined;
  if (!source) return undefined;

  const builders = collectModelBuilders(source);
  for (const builder of builders) {
    const resolved = resolveFromModelBuilder(meta, builder, name, visited);
    if (resolved) return resolved;
  }

  return undefined;
}

function collectModelBuilders(source: AnyObject): AnyObject[] {
  const builders: AnyObject[] = [];
  const enqueue = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (builders.includes(value as AnyObject)) return;
    builders.push(value as AnyObject);
  };

  enqueue(source.modelBuilder);
  const ctor = (source as AnyObject).constructor as AnyObject | undefined;
  if (ctor) enqueue(ctor.modelBuilder);

  const definition = (source.definition ?? {}) as AnyObject;
  enqueue(definition.modelBuilder);
  const settings = definition.settings;
  if (settings instanceof Map) {
    enqueue(settings.get('modelBuilder'));
  } else if (settings && typeof settings === 'object') {
    enqueue((settings as AnyObject).modelBuilder);
  }

  return builders;
}

function resolveFromModelBuilder(
  meta: RelationMeta,
  builder: AnyObject | undefined,
  name: string,
  visited: Set<unknown>,
): typeof Entity | undefined {
  if (!builder) return undefined;

  const containers = ['models', 'definitions', 'classes'] as const;
  for (const key of containers) {
    const container = builder[key as keyof typeof builder] as AnyObject | Map<string, unknown> | undefined;
    if (!container) continue;
    if (container instanceof Map) {
      if (!container.has(name)) continue;
      const resolved = unwrapRelationTarget(meta, container.get(name), visited);
      if (resolved) return resolved;
      continue;
    }
    const value = (container as AnyObject)[name];
    if (value) {
      const resolved = unwrapRelationTarget(meta, value, visited);
      if (resolved) return resolved;
    }
  }

  const methods = ['getModelClass', 'getModelCtor', 'getModel', 'model'] as const;
  for (const method of methods) {
    const fn = builder[method];
    if (typeof fn !== 'function') continue;
    try {
      const value = fn.call(builder, name);
      const resolved = unwrapRelationTarget(meta, value, visited);
      if (resolved) return resolved;
    } catch {
      // Swallow errors and continue probing additional builder sources
    }
  }

  return undefined;
}

function isPromiseHandler(candidate: unknown): candidate is (...args: unknown[]) => unknown {
  if (typeof candidate !== 'function') return false;
  const name = (candidate as AnyObject).name;
  return name === 'then' || name === 'catch' || name === 'finally';
}

function isEntityConstructor(value: AnyObject): value is typeof Entity {
  return typeof value === 'function' && value.prototype instanceof Entity;
}

function buildJoinSegment(
  sourceModel: typeof Entity,
  targetModel: typeof Entity,
  meta: RelationMeta,
  relationType: SupportedRelationType,
): NavigationJoinSegment {
  const sourceDefinition = getModelDefinition(sourceModel);
  const targetDefinition = getModelDefinition(targetModel);
  if (!sourceDefinition || !targetDefinition) {
    throw new NavigationPathError('Missing model definition while resolving navigation path.');
  }
  const sourceId = getPrimaryKey(sourceDefinition);
  const targetId = getPrimaryKey(targetDefinition);

  switch (relationType) {
    case 'hasMany':
    case 'hasOne': {
      const foreignKey = ensureNavigationTargetKey(meta);
      if (!foreignKey) {
        throw new NavigationPathError(
          `Unable to determine foreign key for relation "${meta.name ?? '[unknown]'}".`,
        );
      }
      const sourceKey = meta.keyFrom ?? sourceId;
      return {
        relationName: meta.name ?? '',
        relationType,
        sourceModel,
        targetModel,
        sourceKey,
        targetKey: foreignKey,
      };
    }
    case 'belongsTo': {
      const keyFrom = meta.keyFrom;
      if (!keyFrom) {
        throw new NavigationPathError(
          `belongsTo relation "${meta.name ?? '[unknown]'}" is missing keyFrom metadata.`,
        );
      }
      return {
        relationName: meta.name ?? '',
        relationType,
        sourceModel,
        targetModel,
        sourceKey: keyFrom,
        targetKey: targetId,
      };
    }
    default:
      throw new NavigationPathError(
        `Relation "${meta.name ?? '[unknown]'}" uses unsupported type ${relationType}.`,
      );
  }
}

function getPrimaryKey(definition: ModelDefinition): string {
  const idProps = definition.idProperties?.();
  if (Array.isArray(idProps) && idProps.length) {
    return idProps[0];
  }
  // Fallback to looking for a property flagged as id
  const entries = Object.entries(definition.properties ?? {});
  for (const [name, meta] of entries) {
    if ((meta as AnyObject)?.id === true) return name;
  }
  throw new NavigationPathError(`Model ${definition.name} does not define an id property.`);
}

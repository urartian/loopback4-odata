import { AnyObject, Entity, ModelDefinition, buildModelDefinition } from '@loopback/repository';
import { ensureNavigationTargetKey } from './relation-metadata';
import { isEntityCtor } from './model-helpers';
import { ODataErrorCodes } from '../odata-error-codes';

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
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'NavigationPathError';
    this.code = code;
  }
}

export function resolveNavigationPath(
  modelCtor: typeof Entity,
  path: string,
  options: { maxDepth?: number; allowThrough?: boolean } = {},
): ResolvedNavigationPath {
  const segments = (path ?? '').split('/').filter(Boolean);
  if (!segments.length) {
    throw new NavigationPathError('Navigation path must contain at least one segment.');
  }

  const joins: NavigationJoinSegment[] = [];
  const maxDepth = options.maxDepth ?? 5;
  const allowThrough = options.allowThrough === true;
  let usedThrough = false;

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
      if (!allowThrough) {
        throw new NavigationPathError(
          `Navigation path "${path}" references relation "${segment}" using hasManyThrough, which is not supported for pushdown.`,
          ODataErrorCodes.ThroughRelationUnsupported,
        );
      }
      if (usedThrough) {
        throw new NavigationPathError(
          `Navigation path "${path}" references multiple hasManyThrough segments, which is not supported.`,
          ODataErrorCodes.ThroughRelationUnsupported,
        );
      }
      const targetModel = resolveRelationTarget(relationMeta);
      const through = resolveThroughMeta(relationMeta.through, targetModel);
      if (!through) {
        throw new NavigationPathError(
          `Navigation path "${path}" cannot resolve hasManyThrough metadata for relation "${segment}".`,
          ODataErrorCodes.ThroughRelationUnsupported,
        );
      }
      const sourceDefinition = getModelDefinition(currentModel);
      if (!sourceDefinition) {
        throw new NavigationPathError(
          'Missing model definition while resolving navigation path.',
          ODataErrorCodes.ThroughRelationUnsupported,
        );
      }
      const sourceId = getPrimaryKey(sourceDefinition);
      // source -> through uses hasMany semantics
      joins.push({
        relationName: relationMeta.name ?? segment,
        relationType: 'hasMany',
        sourceModel: currentModel,
        targetModel: through.throughModel,
        sourceKey: sourceId,
        targetKey: through.sourceFk,
      });
      // through -> target uses belongsTo semantics (through has FK to target)
      const targetDefinition = getModelDefinition(through.targetModel);
      if (!targetDefinition) {
        throw new NavigationPathError(
          'Missing model definition while resolving navigation path.',
          ODataErrorCodes.ThroughRelationUnsupported,
        );
      }
      const targetId = getPrimaryKey(targetDefinition);
      joins.push({
        relationName: relationMeta.name ?? segment,
        relationType: 'belongsTo',
        sourceModel: through.throughModel,
        targetModel: through.targetModel,
        sourceKey: through.targetFk,
        targetKey: targetId,
      });
      currentModel = through.targetModel;
      usedThrough = true;
      continue;
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

function resolveThroughMeta(
  through: AnyObject,
  targetModel: typeof Entity | undefined,
):
  | { throughModel: typeof Entity; targetModel: typeof Entity; sourceFk: string; targetFk: string }
  | undefined {
  if (!targetModel) return undefined;
  const modelResolver = through?.model as unknown;
  const keyFrom = through?.keyFrom;
  const keyTo = through?.keyTo;
  if (!keyFrom || !keyTo) return undefined;
  let throughModel: typeof Entity | undefined;
  if (typeof modelResolver === 'function' && isEntityConstructor(modelResolver as AnyObject)) {
    throughModel = modelResolver as typeof Entity;
  } else if (typeof modelResolver === 'function') {
    try {
      const resolved = (modelResolver as () => typeof Entity)();
      if (isEntityConstructor(resolved as AnyObject)) {
        throughModel = resolved as typeof Entity;
      } else if (typeof resolved === 'function') {
        throughModel = resolved as typeof Entity;
      }
    } catch {
      throughModel = undefined;
    }
  }
  if (!throughModel) return undefined;
  return { throughModel, targetModel, sourceFk: String(keyFrom), targetFk: String(keyTo) };
}

function getRelationMeta(modelCtor: typeof Entity, name: string): RelationMeta | undefined {
  const definition = getModelDefinition(modelCtor);
  const relations = (definition?.relations ?? {}) as Record<string, RelationMeta>;
  return relations[name];
}

function getModelDefinition(modelCtor: typeof Entity): ModelDefinition | undefined {
  let definition = (modelCtor as AnyObject).definition as ModelDefinition | undefined;
  if (definition) return definition;

  buildModelDefinition(modelCtor as typeof Entity & { definition?: ModelDefinition | undefined });
  definition = (modelCtor as AnyObject).definition as ModelDefinition | undefined;
  return definition;
}

function normalizeRelationType(meta: RelationMeta): SupportedRelationType | undefined {
  const type = (meta.relationType ?? meta.type ?? '').toLowerCase();
  if (type === 'hasmany') return 'hasMany';
  if (type === 'hasone') return 'hasOne';
  if (type === 'belongsto') return 'belongsTo';
  return undefined;
}

function resolveRelationTarget(meta: RelationMeta): typeof Entity | undefined {
  const targetResolver = meta.target;
  if (!targetResolver) return undefined;

  if (isEntityConstructor(targetResolver as AnyObject)) {
    return targetResolver as typeof Entity;
  }

  if (typeof targetResolver === 'function' && !isEntityConstructor(targetResolver as AnyObject)) {
    try {
      const target = (targetResolver as () => typeof Entity)();
      if (isEntityConstructor(target)) return target;
      // Fallback for circular dependency resolution issues
      if (typeof target === 'function') {
        return target as typeof Entity;
      }
    } catch {
      // ignore and attempt to interpret the resolver as constructor
    }
  }

  return undefined;
}

function isEntityConstructor(value: AnyObject): value is typeof Entity {
  return isEntityCtor(value);
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
  const modelName = definition.name ?? '[anonymous model]';
  const idProps = definition.idProperties?.() ?? [];
  if (Array.isArray(idProps) && idProps.length) {
    return selectSingleKey(modelName, idProps);
  }
  // Fallback to looking for a property flagged as id
  const flagged = Object.entries(definition.properties ?? {})
    .filter(([, meta]) => (meta as AnyObject)?.id === true)
    .map(([name]) => name);
  if (flagged.length) {
    return selectSingleKey(modelName, flagged);
  }
  throw new NavigationPathError(`Model ${modelName} does not define an id property.`);
}

function selectSingleKey(modelName: string, keys: string[]): string {
  if (keys.length === 1) return keys[0];
  if (keys.length > 1) {
    const joined = keys.join(', ');
    throw new NavigationPathError(
      `Model ${modelName} defines a composite primary key (${joined}), which is not supported for navigation path resolution.`,
    );
  }
  throw new NavigationPathError(`Model ${modelName} does not define an id property.`);
}

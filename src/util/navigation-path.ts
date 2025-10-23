import {AnyObject, Entity, ModelDefinition} from '@loopback/repository';
import {ensureNavigationTargetKey} from './relation-metadata';
import {RelationMetaLike, resolveRelationTarget} from './relation-target';

type RelationMeta = RelationMetaLike & {
  type?: string;
  relationType?: string;
  keyFrom?: string;
  keyTo?: string;
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

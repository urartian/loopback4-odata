import { AnyObject, Entity, ModelDefinition, buildModelDefinition } from '@loopback/repository';

type RelationMeta = AnyObject & {
  target?: (() => typeof Entity) | typeof Entity;
};

/**
 * Ensures a LoopBack model definition exists and eagerly builds definitions for related targets.
 */
export function ensureModelDefinitionWithRelations(
  modelCtor: typeof Entity,
  visited: Set<typeof Entity> = new Set(),
): ModelDefinition | undefined {
  if (!modelCtor || visited.has(modelCtor)) {
    return (modelCtor as AnyObject).definition as ModelDefinition | undefined;
  }
  const definition = ensureModelDefinition(modelCtor);
  if (!definition) return undefined;
  visited.add(modelCtor);

  const relations = (definition.relations ?? {}) as Record<string, RelationMeta | undefined>;
  for (const relation of Object.values(relations)) {
    const targetModel = resolveRelationTarget(relation);
    if (!targetModel) continue;
    ensureModelDefinition(targetModel);
    ensureModelDefinitionWithRelations(targetModel, visited);
  }

  return definition;
}

export function ensureModelDefinition(modelCtor: typeof Entity): ModelDefinition | undefined {
  if (!modelCtor) return undefined;
  let definition = (modelCtor as AnyObject).definition as ModelDefinition | undefined;
  if (definition) return definition;
  buildModelDefinition(modelCtor as typeof Entity & { definition?: ModelDefinition | undefined });
  definition = (modelCtor as AnyObject).definition as ModelDefinition | undefined;
  return definition;
}

function resolveRelationTarget(relation: RelationMeta | undefined): typeof Entity | undefined {
  if (!relation?.target) return undefined;
  const target = relation.target;
  if (isEntityConstructor(target)) {
    return target;
  }
  if (typeof target === 'function') {
    try {
      const resolved = (target as () => typeof Entity)();
      if (isEntityConstructor(resolved)) return resolved;
      if (typeof resolved === 'function') {
        return resolved as typeof Entity;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isEntityConstructor(value: AnyObject): value is typeof Entity {
  return typeof value === 'function' && value.prototype instanceof Entity;
}

import { AnyObject, Entity, ModelDefinition } from '@loopback/repository';

interface RelationMetaLike extends AnyObject {
  keyTo?: string;
  source?: typeof Entity;
  target?: (() => typeof Entity) | typeof Entity;
}

/**
 * Ensures a hasOne/hasMany relation metadata object exposes the foreign key (`keyTo`)
 * required for navigation link operations. When `keyTo` is missing it will be derived
 * using the same convention LoopBack applies internally (camelCase(modelName + 'Id')).
 *
 * The metadata object is mutated in place so downstream consumers observe the resolved key.
 *
 * @returns The resolved foreign key name, or `undefined` when it cannot be inferred.
 */
export function ensureNavigationTargetKey(meta: RelationMetaLike | undefined): string | undefined {
  if (!meta) return undefined;
  if (meta.keyTo) return meta.keyTo;

  const sourceModel = meta.source;
  const targetResolver = meta.target;
  if (!sourceModel || typeof targetResolver !== 'function') return undefined;

  let targetModel: typeof Entity | undefined;
  const maybeCtor = targetResolver as unknown as typeof Entity;
  const prototype = (maybeCtor as AnyObject)?.prototype;
  if (prototype && prototype instanceof Entity) {
    targetModel = maybeCtor;
  } else {
    try {
      targetModel = (targetResolver as () => typeof Entity)();
    } catch {
      return undefined;
    }
  }
  if (!targetModel) return undefined;

  const targetDef = (targetModel as { definition?: ModelDefinition }).definition as
    | ModelDefinition
    | undefined;
  const properties = targetDef?.properties ?? {};

  const explicit = meta.keyTo;
  if (explicit && Object.prototype.hasOwnProperty.call(properties, explicit)) {
    return explicit;
  }

  const inferred = inferForeignKeyFromSource(sourceModel);
  if (!inferred) return undefined;
  if (!Object.prototype.hasOwnProperty.call(properties, inferred)) {
    return undefined;
  }

  meta.keyTo = inferred;
  return inferred;
}

function inferForeignKeyFromSource(sourceModel: typeof Entity | undefined): string | undefined {
  const name = sourceModel?.modelName ?? sourceModel?.name;
  if (!name) return undefined;

  const normalized = name.replace(/[^A-Za-z0-9]/g, ' ');
  if (!normalized.trim()) return undefined;

  const tokens = normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token[0].toUpperCase() + token.slice(1));

  if (!tokens.length) return undefined;

  const camel = tokens[0].charAt(0).toLowerCase() + tokens[0].slice(1) + tokens.slice(1).join('');

  return camel.endsWith('Id') ? camel : `${camel}Id`;
}

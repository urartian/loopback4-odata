import { Entity, Model, ModelDefinition } from '@loopback/repository';

type MaybeModelCtor = (typeof Model | typeof Entity) & {
  definition?: ModelDefinition;
  getIdProperties?: () => string[];
  getIdOf?: Function;
};

function hasPrototype(value: unknown): value is MaybeModelCtor {
  return typeof value === 'function' && Boolean((value as MaybeModelCtor).prototype);
}

export function isModelCtor(value: unknown): value is typeof Model {
  if (!hasPrototype(value)) return false;
  const ctor = value as MaybeModelCtor;
  if (ctor.prototype instanceof Model) return true;
  return Boolean(ctor.definition);
}

export function isEntityCtor(value: unknown): value is typeof Entity {
  if (!hasPrototype(value)) return false;
  const ctor = value as MaybeModelCtor;
  if (ctor.prototype instanceof Entity) return true;
  if (typeof ctor.getIdOf === 'function') return true;
  return false;
}

type ModelIdentityOptions = {
  leftDefinition?: ModelDefinition;
  rightDefinition?: ModelDefinition;
};

function normalizeModelIdentity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

function getModelIdentifiers(
  ctor: typeof Model | typeof Entity,
  definition?: ModelDefinition,
): Set<string> {
  const identifiers = new Set<string>();
  const resolvedDefinition = definition ?? (ctor as MaybeModelCtor).definition;
  const definitionName = normalizeModelIdentity(resolvedDefinition?.name);
  if (definitionName) identifiers.add(definitionName);
  const modelName = normalizeModelIdentity(
    (ctor as typeof Entity & { modelName?: string }).modelName,
  );
  if (modelName) identifiers.add(modelName);
  const ctorName = normalizeModelIdentity(ctor.name);
  if (ctorName) identifiers.add(ctorName);
  return identifiers;
}

export function modelsRepresentSameEntity(
  left: typeof Model | typeof Entity | undefined,
  right: typeof Model | typeof Entity | undefined,
  options?: ModelIdentityOptions,
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftIds = getModelIdentifiers(left, options?.leftDefinition);
  if (!leftIds.size) return false;
  const rightIds = getModelIdentifiers(right, options?.rightDefinition);
  if (!rightIds.size) return false;
  for (const id of leftIds) {
    if (rightIds.has(id)) return true;
  }
  return false;
}

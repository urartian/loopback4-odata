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

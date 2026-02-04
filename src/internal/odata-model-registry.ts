import { Model } from '@loopback/repository';

function normalizeRegistryKey(value: string): string {
  return value.trim().toLowerCase();
}

const ODATA_MODEL_CTOR_REGISTRY = new Map<string, typeof Model>();

export function registerODataModelCtor(target: typeof Model) {
  const definitionName = (target as typeof Model & { definition?: { name?: string } }).definition
    ?.name;
  if (typeof definitionName === 'string' && definitionName.trim()) {
    ODATA_MODEL_CTOR_REGISTRY.set(normalizeRegistryKey(definitionName), target);
  }
  const ctorName = target.name;
  if (typeof ctorName === 'string' && ctorName.trim()) {
    ODATA_MODEL_CTOR_REGISTRY.set(normalizeRegistryKey(ctorName), target);
  }
  const modelName = (target as typeof Model & { modelName?: string }).modelName;
  if (typeof modelName === 'string' && modelName.trim()) {
    ODATA_MODEL_CTOR_REGISTRY.set(normalizeRegistryKey(modelName), target);
  }
}

export function resolveODataModelCtor(name: string): typeof Model | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return ODATA_MODEL_CTOR_REGISTRY.get(normalizeRegistryKey(trimmed));
}

import {AnyObject, Entity} from '@loopback/repository';
import {createRequire} from 'module';

const nodeRequire = createRequire(__filename);
const targetByNameCache = new Map<string, typeof Entity>();

type AnyFn = (...args: unknown[]) => unknown;

export interface RelationMetaLike extends AnyObject {
  name?: string;
  source?: typeof Entity;
  target?: unknown;
  targetResolver?: unknown;
  model?: unknown;
  modelTo?: unknown;
  modelCtor?: unknown;
  through?: {model?: unknown} & AnyObject;
}

export function resolveRelationTarget(meta: RelationMetaLike | undefined): typeof Entity | undefined {
  if (!meta) return undefined;

  const directVisited = new Set<unknown>();
  const directCandidates = [
    meta.target,
    meta.targetResolver,
    meta.model,
    meta.modelTo,
    meta.modelCtor,
    meta.through?.model,
  ];

  for (const candidate of directCandidates) {
    const resolved = resolveCandidate(candidate, meta, directVisited);
    if (resolved) return resolved;
  }

  for (const hint of collectNameHints(meta)) {
    const resolved = resolveByModelName(hint, meta, new Set<unknown>());
    if (resolved) return resolved;
  }

  return undefined;
}

function resolveCandidate(
  candidate: unknown,
  meta: RelationMetaLike,
  visited: Set<unknown>,
): typeof Entity | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate === 'string') {
    return resolveByModelName(candidate, meta, new Set<unknown>());
  }
  if (typeof candidate !== 'object' && typeof candidate !== 'function') {
    return undefined;
  }
  if (visited.has(candidate)) return undefined;
  visited.add(candidate);

  if (isEntityConstructor(candidate as AnyObject)) {
    return candidate as typeof Entity;
  }

  if (typeof candidate === 'function') {
    try {
      const result = (candidate as AnyFn)();
      const resolved = resolveCandidate(result, meta, visited);
      if (resolved) return resolved;
    } catch {
      // ignore resolvers that require context
    }

    for (const key of Object.keys(candidate)) {
      const resolved = resolveCandidate((candidate as AnyObject)[key], meta, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      const resolved = resolveCandidate(entry, meta, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  const obj = candidate as AnyObject;
  const nested = [
    obj.model,
    obj.Model,
    obj.modelCtor,
    obj.target,
    obj.entityClass,
    obj.through?.model,
  ];

  for (const value of nested) {
    const resolved = resolveCandidate(value, meta, visited);
    if (resolved) return resolved;
  }

  if (typeof obj.modelName === 'string') {
    const resolved = resolveByModelName(obj.modelName, meta, new Set<unknown>());
    if (resolved) return resolved;
  }

  if (!isPlainObject(obj)) return undefined;

  try {
    for (const value of Object.values(obj)) {
      const resolved = resolveCandidate(value, meta, visited);
      if (resolved) return resolved;
    }
  } catch {
    // ignore objects with throwing accessors
  }

  return undefined;
}

function collectNameHints(meta: RelationMetaLike): string[] {
  const hints = new Set<string>();
  const rawCandidates = [
    meta.target,
    meta.model,
    meta.modelTo,
    meta.modelCtor,
    meta.through?.model,
    (meta as AnyObject).targetModel,
    (meta as AnyObject).targetName,
  ];

  for (const raw of rawCandidates) {
    if (typeof raw === 'string' && raw.trim()) {
      hints.add(raw.trim());
      continue;
    }

    if (raw && typeof raw === 'object') {
      const name = (raw as AnyObject).name;
      if (typeof name === 'string' && name.trim()) {
        hints.add(name.trim());
      }
    }
  }

  return [...hints];
}

function resolveByModelName(
  name: string,
  meta: RelationMetaLike,
  visited: Set<unknown>,
): typeof Entity | undefined {
  const normalized = normalizeName(name);
  if (!normalized) return undefined;

  const cached = targetByNameCache.get(normalized);
  if (cached) return cached;

  const direct = scanForNamedModel(meta.source, normalized, visited);
  if (direct) {
    targetByNameCache.set(normalized, direct);
    return direct;
  }

  const cache = nodeRequire.cache ?? {};
  for (const moduleId of Object.keys(cache)) {
    const exported = cache[moduleId]?.exports;
    const resolved = scanForNamedModel(exported, normalized, visited);
    if (resolved) {
      targetByNameCache.set(normalized, resolved);
      return resolved;
    }
  }

  return undefined;
}

function scanForNamedModel(
  candidate: unknown,
  normalized: string,
  visited: Set<unknown>,
): typeof Entity | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  if (visited.has(candidate)) return undefined;
  if (typeof candidate !== 'object' && typeof candidate !== 'function') {
    return undefined;
  }

  visited.add(candidate);

  if (isEntityConstructor(candidate as AnyObject)) {
    const ctor = candidate as typeof Entity;
    if (entityNameMatches(ctor, normalized)) {
      return ctor;
    }
  }

  if (typeof candidate === 'function') {
    for (const key of Object.keys(candidate)) {
      const resolved = scanForNamedModel((candidate as AnyObject)[key], normalized, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (Array.isArray(candidate)) {
    for (const entry of candidate) {
      const resolved = scanForNamedModel(entry, normalized, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  const obj = candidate as AnyObject;
  if (typeof obj.modelName === 'string' && normalizeName(obj.modelName) === normalized) {
    if (isEntityConstructor(obj.constructor as AnyObject)) {
      return obj.constructor as typeof Entity;
    }
  }

  if (!isPlainObject(obj)) return undefined;

  try {
    for (const value of Object.values(obj)) {
      const resolved = scanForNamedModel(value, normalized, visited);
      if (resolved) return resolved;
    }
  } catch {
    // ignore throwing accessors
  }

  return undefined;
}

function entityNameMatches(ctor: typeof Entity, normalized: string): boolean {
  const definition = (ctor as AnyObject).definition as {name?: string} | undefined;
  const candidates = [definition?.name, (ctor as AnyObject).modelName, ctor.name];
  return candidates.some(value => normalizeName(value) === normalized);
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isEntityConstructor(value: AnyObject | undefined): value is typeof Entity {
  if (typeof value !== 'function') return false;
  const prototype = value.prototype as AnyObject | undefined;
  return !!prototype && prototype instanceof Entity;
}

function isPlainObject(value: AnyObject | undefined): value is AnyObject {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

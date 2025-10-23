import {AnyObject, Entity} from '@loopback/repository';
import {createRequire} from 'module';

const nodeRequire = createRequire(__filename);
const targetByNameCache = new Map<string, typeof Entity | null>();

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

  const visited = new Set<unknown>();
  const queue: unknown[] = [];

  queue.push(meta.target);
  queue.push(meta.targetResolver);
  queue.push(meta.model);
  queue.push(meta.modelTo);
  queue.push(meta.modelCtor);
  queue.push(meta.through?.model);

  while (queue.length) {
    const candidate = queue.shift();
    const resolved = tryResolveCandidate(candidate, meta, visited);
    if (resolved) return resolved;
  }

  const nameCandidates = collectNameCandidates(meta);
  for (const name of nameCandidates) {
    const resolved = resolveByModelName(name, meta, visited);
    if (resolved) return resolved;
  }

  return undefined;
}

function tryResolveCandidate(
  candidate: unknown,
  meta: RelationMetaLike,
  visited: Set<unknown>,
): typeof Entity | undefined {
  if (!candidate || visited.has(candidate)) return undefined;
  visited.add(candidate);

  if (isEntityConstructor(candidate as AnyObject)) {
    return candidate as typeof Entity;
  }

  if (typeof candidate === 'function') {
    // Handle functions that are actually constructors first
    if (isEntityConstructor((candidate as AnyObject).prototype)) {
      return candidate as typeof Entity;
    }

    try {
      const result = (candidate as AnyFn)();
      const resolved = tryResolveCandidate(result, meta, visited);
      if (resolved) return resolved;
    } catch {
      // Ignore errors from invoking the resolver; fall through to inspect the function
    }

    for (const key of Object.keys(candidate)) {
      const nested = (candidate as AnyObject)[key];
      const resolved = tryResolveCandidate(nested, meta, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (typeof candidate === 'object') {
    const obj = candidate as AnyObject;
    const nestedResolvers = [
      obj.model,
      obj.Model,
      obj.modelCtor,
      obj.target,
      obj.entityClass,
      obj.constructor,
    ];
    for (const nested of nestedResolvers) {
      const resolved = tryResolveCandidate(nested, meta, visited);
      if (resolved) return resolved;
    }

    if (typeof obj.modelName === 'string') {
      const resolved = resolveByModelName(obj.modelName, meta, visited);
      if (resolved) return resolved;
    }

    if (Array.isArray(obj)) {
      for (const value of obj) {
        const resolved = tryResolveCandidate(value, meta, visited);
        if (resolved) return resolved;
      }
      return undefined;
    }

    if (!isPlainObject(obj)) return undefined;

    try {
      for (const value of Object.values(obj)) {
        const resolved = tryResolveCandidate(value, meta, visited);
        if (resolved) return resolved;
      }
    } catch {
      // Ignore objects with throwing property accessors
    }
    return undefined;
  }

  if (typeof candidate === 'string') {
    return resolveByModelName(candidate, meta, visited);
  }

  return undefined;
}

function collectNameCandidates(meta: RelationMetaLike): string[] {
  const names = new Set<string>();
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
      names.add(raw.trim());
    }
    if (typeof raw === 'object' && raw && typeof (raw as AnyObject).name === 'string') {
      names.add(((raw as AnyObject).name as string).trim());
    }
  }

  return [...names];
}

function resolveByModelName(
  name: string,
  meta: RelationMetaLike,
  visited: Set<unknown>,
): typeof Entity | undefined {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return undefined;

  const cached = targetByNameCache.get(normalized);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const maybeResolve = (candidate: unknown): typeof Entity | undefined =>
    scanForModel(candidate, normalized, visited);

  const direct = maybeResolve(meta.source);
  if (direct) {
    targetByNameCache.set(normalized, direct);
    return direct;
  }

  const cache = nodeRequire.cache ?? {};
  for (const moduleId of Object.keys(cache)) {
    const exported = cache[moduleId]?.exports;
    const resolved = maybeResolve(exported);
    if (resolved) {
      targetByNameCache.set(normalized, resolved);
      return resolved;
    }
  }

  targetByNameCache.set(normalized, null);
  return undefined;
}

function scanForModel(
  candidate: unknown,
  normalized: string,
  visited: Set<unknown>,
): typeof Entity | undefined {
  if (!candidate || visited.has(candidate)) return undefined;
  visited.add(candidate);

  if (isEntityConstructor(candidate as AnyObject)) {
    const ctor = candidate as typeof Entity;
    const definition = (ctor as AnyObject).definition as {name?: string} | undefined;
    const namesToCheck = [
      definition?.name,
      (ctor as AnyObject).modelName,
      (ctor as AnyObject).name,
    ];
    for (const value of namesToCheck) {
      if (typeof value === 'string' && value.trim().toLowerCase() === normalized) {
        return ctor;
      }
    }
  }

  if (typeof candidate === 'function') {
    for (const key of Object.keys(candidate)) {
      const resolved = scanForModel((candidate as AnyObject)[key], normalized, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (Array.isArray(candidate)) {
    for (const value of candidate) {
      const resolved = scanForModel(value, normalized, visited);
      if (resolved) return resolved;
    }
    return undefined;
  }

  if (typeof candidate === 'object' && candidate) {
    if (!isPlainObject(candidate as AnyObject)) return undefined;
    try {
      for (const value of Object.values(candidate as AnyObject)) {
        const resolved = scanForModel(value, normalized, visited);
        if (resolved) return resolved;
      }
    } catch {
      // Ignore objects with throwing property accessors
    }
  }

  return undefined;
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

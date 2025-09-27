import {AnyObject, Fields, PropertyDefinition} from '@loopback/repository';

type EncodedToken = {
  t: 'string' | 'number' | 'boolean' | 'date' | 'buffer' | 'bigint' | 'unknown';
  v: string;
};

type CompositeEncodedToken = {
  c: true;
  v: Array<EncodedToken & {n: string}>;
};

const HEADER_SPLIT = /\s*,\s*/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null) return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  if (Buffer.isBuffer(value)) return false;
  return typeof value === 'object';
}

function detectType(value: unknown): EncodedToken {
  if (value == null) {
    return {t: 'unknown', v: ''};
  }
  if (Buffer.isBuffer(value)) {
    return {t: 'buffer', v: value.toString('base64')};
  }
  if (value instanceof Date) {
    return {t: 'date', v: value.toISOString()};
  }
  switch (typeof value) {
    case 'number':
      return {t: 'number', v: value.toString()};
    case 'boolean':
      return {t: 'boolean', v: value ? 'true' : 'false'};
    case 'bigint':
      return {t: 'bigint', v: value.toString()};
    case 'string':
      return {t: 'string', v: value};
    default:
      return {t: 'unknown', v: JSON.stringify(value)};
  }
}

function reviveType(token: EncodedToken): unknown {
  switch (token.t) {
    case 'buffer':
      return Buffer.from(token.v, 'base64');
    case 'date':
      return new Date(token.v);
    case 'number':
      return Number(token.v);
    case 'boolean':
      return token.v === 'true';
    case 'bigint':
      try {
        return BigInt(token.v);
      } catch {
        return token.v;
      }
    case 'string':
      return token.v;
    default:
      try {
        return JSON.parse(token.v);
      } catch {
        return token.v;
      }
  }
}

function coerceToPropertyType(value: unknown, property?: PropertyDefinition): unknown {
  const type = property?.type;
  if (!type) return value;

  const target = typeof type === 'function' ? type.name.toLowerCase() : String(type).toLowerCase();
  switch (target) {
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true';
    case 'date':
      return value instanceof Date ? value : new Date(String(value));
    case 'bigint':
      try {
        return typeof value === 'bigint' ? value : BigInt(String(value));
      } catch {
        return value;
      }
    default:
      return value;
  }
}

export function encodeEtagToken(value: unknown): string | undefined {
  if (value == null) return undefined;

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return undefined;
    const composite: CompositeEncodedToken = {
      c: true,
      v: entries
        .map(([name, raw]) => ({n: name, ...detectType(raw)}))
        .sort((a, b) => a.n.localeCompare(b.n)),
    };
    const payload = Buffer.from(JSON.stringify(composite), 'utf-8').toString('base64');
    return `"${payload}"`;
  }

  const token = detectType(value);
  const payload = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
  return `"${payload}"`;
}

function isCompositeToken(value: unknown): value is CompositeEncodedToken {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as CompositeEncodedToken).c === true &&
      Array.isArray((value as CompositeEncodedToken).v),
  );
}

export function decodeEtagToken(
  headerValue: string,
  property?: PropertyDefinition,
  compositeProperties?: Record<string, PropertyDefinition | undefined>,
): unknown {
  const trimmed = headerValue.trim();
  const withoutWeak = trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
  if (!withoutWeak.startsWith('"') || !withoutWeak.endsWith('"')) {
    return coerceToPropertyType(withoutWeak, property);
  }
  const raw = withoutWeak.slice(1, -1);
  try {
    const json = Buffer.from(raw, 'base64').toString('utf-8');
    const parsed = JSON.parse(json) as EncodedToken | CompositeEncodedToken;
    if (isCompositeToken(parsed)) {
      const defs = compositeProperties ?? {};
      const result: Record<string, unknown> = {};
      for (const entry of parsed.v) {
        const revived = reviveType(entry);
        result[entry.n] = coerceToPropertyType(revived, defs[entry.n]);
      }
      return result;
    }
    const revived = reviveType(parsed);
    return coerceToPropertyType(revived, property);
  } catch {
    return coerceToPropertyType(raw, property);
  }
}

export function parseIfMatch(header: string | undefined) {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (trimmed === '*') {
    return {any: true, values: [] as string[]};
  }
  const values = trimmed
    .split(HEADER_SPLIT)
    .map(token => token.trim())
    .filter(Boolean);
  return {any: false, values};
}

export function parseIfNoneMatch(header: string | undefined) {
  if (!header) return undefined;
  const parsed = parseIfMatch(header);
  if (!parsed) return undefined;
  if (parsed.any) return {any: true, values: [] as string[]};
  return parsed;
}

export function matchesEtag(encoded: string | undefined, expected: string[]): boolean {
  if (!encoded) return false;
  const value = encoded.startsWith('W/') ? encoded.slice(2) : encoded;
  return expected.some(item => {
    const clean = item.startsWith('W/') ? item.slice(2) : item;
    return clean.trim() === value.trim();
  });
}

export function normalizeEtagProperties(etag?: string | string[]): string[] | undefined {
  if (!etag) return undefined;
  const props = Array.isArray(etag) ? etag : [etag];
  const filtered = Array.from(new Set(props.filter(Boolean)));
  if (!filtered.length) return undefined;
  return filtered.sort();
}

export function ensureEtagField(
  fields: Fields<AnyObject> | undefined,
  etagProperties?: string | string[],
) {
  const props = normalizeEtagProperties(etagProperties);
  if (!props?.length || fields == null) return fields;

  if (Array.isArray(fields)) {
    const missing = props.filter(prop => !fields.includes(prop));
    return missing.length ? [...fields, ...missing] : fields;
  }

  if (typeof fields === 'object') {
    const map = fields as Record<string, boolean>;
    let updated = false;
    const next = {...map};
    for (const prop of props) {
      if (!next[prop]) {
        next[prop] = true;
        updated = true;
      }
    }
    return updated ? next : fields;
  }

  if (typeof fields === 'boolean') {
    if (fields) return fields;
    return props.reduce<Record<string, boolean>>((acc, prop) => ({...acc, [prop]: true}), {});
  }

  return fields;
}

export function stripEtagProperty(entity: Record<string, unknown>, etagProperty?: string | string[]) {
  const props = normalizeEtagProperties(etagProperty);
  if (!props?.length) return entity;
  const cloned = {...entity};
  for (const prop of props) {
    delete cloned[prop];
  }
  return cloned;
}

export function readEtagValue(
  entity: Record<string, unknown> | undefined,
  etagProperty?: string | string[],
) {
  if (!entity || !etagProperty) return undefined;
  const props = normalizeEtagProperties(etagProperty);
  if (!props?.length) return undefined;
  if (props.length === 1) {
    return entity[props[0]];
  }
  const result: Record<string, unknown> = {};
  for (const prop of props) {
    result[prop] = entity[prop];
  }
  return result;
}

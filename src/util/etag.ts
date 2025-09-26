import {PropertyDefinition} from '@loopback/repository';

type EncodedToken = {
  t: 'string' | 'number' | 'boolean' | 'date' | 'buffer' | 'bigint' | 'unknown';
  v: string;
};

const HEADER_SPLIT = /\s*,\s*/g;

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
  const token = detectType(value);
  const payload = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
  return `"${payload}"`;
}

export function decodeEtagToken(headerValue: string, property?: PropertyDefinition): unknown {
  const trimmed = headerValue.trim();
  const withoutWeak = trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
  if (!withoutWeak.startsWith('"') || !withoutWeak.endsWith('"')) {
    return coerceToPropertyType(withoutWeak, property);
  }
  const raw = withoutWeak.slice(1, -1);
  try {
    const json = Buffer.from(raw, 'base64').toString('utf-8');
    const parsed = JSON.parse(json) as EncodedToken;
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

export function ensureEtagField(fields: Record<string, boolean> | undefined, etagProperty?: string) {
  if (!etagProperty) return fields;
  const next = {...(fields ?? {})};
  next[etagProperty] = true;
  return next;
}

export function stripEtagProperty(entity: Record<string, unknown>, etagProperty?: string) {
  if (!etagProperty) return entity;
  const cloned = {...entity};
  delete cloned[etagProperty];
  return cloned;
}

export function readEtagValue(entity: Record<string, unknown> | undefined, etagProperty?: string) {
  if (!entity || !etagProperty) return undefined;
  return entity[etagProperty];
}

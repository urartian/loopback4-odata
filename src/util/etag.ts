import { AnyObject, Fields, PropertyDefinition } from '@loopback/repository';
import { safeDecodeURIComponent } from './url-decoding';

const HEADER_SPLIT = /\s*,\s*/g;

type PropertyDefinitionMap = Record<string, PropertyDefinition | undefined>;

type NormalizedProps = string[] | undefined;

export function normalizeEtagProperties(etag?: string | string[]): string[] | undefined {
  if (!etag) return undefined;
  const props = Array.isArray(etag) ? etag : [etag];
  const filtered = Array.from(new Set(props.filter(Boolean)));
  if (!filtered.length) return undefined;
  return filtered.sort();
}

function serializeAtomicValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof Date) return value.toISOString();
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      try {
        return JSON.stringify(value);
      } catch {
        return undefined;
      }
  }
}

function escapeEtagValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeEtagValue(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function weakWrap(content: string): string {
  return `W/"${content}"`;
}

export function encodeEtagToken(
  value: unknown,
  etagProperties?: string | string[],
): string | undefined {
  const props = normalizeEtagProperties(etagProperties);
  if (value === undefined || value === null) return undefined;

  if (!props || props.length <= 1) {
    const atomic = serializeAtomicValue(value);
    if (atomic === undefined) return undefined;
    return weakWrap(escapeEtagValue(atomic));
  }

  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const segments: string[] = [];

  for (const key of props) {
    const atomic = serializeAtomicValue(source[key]);
    if (atomic === undefined) return undefined;
    segments.push(`${encodeURIComponent(key)}=${encodeURIComponent(atomic)}`);
  }

  return weakWrap(segments.join('&'));
}

function coerceToPropertyType(value: unknown, property?: PropertyDefinition): unknown {
  if (!property) return value;
  const target =
    typeof property.type === 'function'
      ? property.type.name.toLowerCase()
      : String(property.type).toLowerCase();
  switch (target) {
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return String(value).toLowerCase() === 'true';
    case 'date':
      if (value instanceof Date) return value;
      return new Date(String(value));
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

function normalizeHeaderValue(headerValue: string): string {
  const trimmed = headerValue.trim();
  const withoutWeak = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
  return withoutWeak.trim();
}

function isComposite(props: NormalizedProps): props is string[] {
  return Boolean(props && props.length > 1);
}

export function decodeEtagToken(
  headerValue: string,
  etagProperties?: string | string[],
  propertyDefs?: PropertyDefinitionMap,
): unknown {
  const props = normalizeEtagProperties(etagProperties);
  const defs = propertyDefs ?? {};
  const normalized = normalizeHeaderValue(headerValue);

  if (!normalized) return undefined;

  if (!props || props.length <= 1) {
    const content =
      normalized.startsWith('"') && normalized.endsWith('"')
        ? unescapeEtagValue(normalized.slice(1, -1))
        : normalized;
    const propertyName = props?.[0];
    return coerceToPropertyType(content, propertyName ? defs[propertyName] : undefined);
  }

  const inner =
    normalized.startsWith('"') && normalized.endsWith('"') ? normalized.slice(1, -1) : normalized;

  if (!inner) return undefined;
  const result: Record<string, unknown> = {};

  for (const segment of inner.split('&')) {
    if (!segment) continue;
    const [rawKey, rawValue = ''] = segment.split('=');
    const key = safeDecodeURIComponent(rawKey);
    if (!key) return undefined;
    if (!props.includes(key)) continue;
    const value = safeDecodeURIComponent(rawValue);
    if (value === undefined) return undefined;
    result[key] = coerceToPropertyType(value, defs[key]);
  }

  if (!Object.keys(result).length) return undefined;
  return result;
}

export function parseIfMatch(header: string | undefined) {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (trimmed === '*') {
    return { any: true, values: [] as string[] };
  }
  const values = trimmed
    .split(HEADER_SPLIT)
    .map((token) => token.trim())
    .filter(Boolean);
  return { any: false, values };
}

export function parseIfNoneMatch(header: string | undefined) {
  if (!header) return undefined;
  const parsed = parseIfMatch(header);
  if (!parsed) return undefined;
  if (parsed.any) return { any: true, values: [] as string[] };
  return parsed;
}

function normaliseTagForComparison(value: string): string {
  const normalised = normalizeHeaderValue(value);
  if (normalised.startsWith('"') && normalised.endsWith('"')) {
    return unescapeEtagValue(normalised.slice(1, -1));
  }
  return normalised;
}

export function matchesEtag(encoded: string | undefined, expected: string[]): boolean {
  if (!encoded) return false;
  const needle = normaliseTagForComparison(encoded);
  return expected.some((item) => normaliseTagForComparison(item) === needle);
}

export function ensureEtagField(
  fields: Fields<AnyObject> | undefined,
  etagProperties?: string | string[],
) {
  const props = normalizeEtagProperties(etagProperties);
  if (!props?.length) return fields;

  if (fields == null) return fields;

  if (Array.isArray(fields)) {
    const missing = props.filter((prop) => !fields.includes(prop));
    return missing.length ? [...fields, ...missing] : fields;
  }

  if (typeof fields === 'object') {
    const map = fields as Record<string, boolean>;
    let updated = false;
    const next = { ...map };
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
    return props.reduce<Record<string, boolean>>((acc, prop) => ({ ...acc, [prop]: true }), {});
  }

  return fields;
}

export function stripEtagProperty(
  entity: Record<string, unknown>,
  etagProperty?: string | string[],
) {
  const props = normalizeEtagProperties(etagProperty);
  if (!props?.length) return entity;
  const cloned = { ...entity };
  for (const prop of props) {
    delete cloned[prop];
  }
  return cloned;
}

export function readEtagValue(
  entity: Record<string, unknown> | undefined,
  etagProperty?: string | string[],
) {
  if (!entity) return undefined;
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

export function decodeIfMatchValues(
  rawValues: string[],
  etagProperties?: string | string[],
  propertyDefs?: PropertyDefinitionMap,
): { values: unknown[]; invalidComposite: boolean } {
  const props = normalizeEtagProperties(etagProperties);
  if (!props?.length || !rawValues.length) {
    return { values: [], invalidComposite: false };
  }

  const composite = props.length > 1;
  const defs = propertyDefs ?? {};
  const decoded: unknown[] = [];
  let invalidComposite = false;

  for (const raw of rawValues) {
    const value = decodeEtagToken(raw, props, defs);
    if (value === undefined) {
      if (composite) invalidComposite = true;
      continue;
    }

    if (composite) {
      const plain = value as Record<string, unknown>;
      const keys = Object.keys(plain);
      if (!keys.length || !props.every((prop) => keys.includes(prop))) {
        invalidComposite = true;
        continue;
      }
    }

    decoded.push(value);
  }

  return { values: decoded, invalidComposite };
}

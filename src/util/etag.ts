import {AnyObject, Fields, PropertyDefinition} from '@loopback/repository';

type EncodedToken = {
  t: 'string' | 'number' | 'boolean' | 'date' | 'buffer' | 'bigint' | 'unknown';
  v: string;
};

type CompositeComponent = EncodedToken & {p: string};

type CompositeToken = {
  t: 'composite';
  v: CompositeComponent[];
};

type SerializedToken = EncodedToken | CompositeToken;

type EtagPart = {name: string; value: unknown};

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

function encodeSerializedToken(token: SerializedToken): string {
  const payload = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
  return `"${payload}"`;
}

function toCompositeToken(parts: EtagPart[]): CompositeToken {
  const normalized = parts
    .filter(part => Boolean(part?.name))
    .map(part => ({name: part.name, value: part.value}));
  normalized.sort((a, b) => a.name.localeCompare(b.name));
  return {
    t: 'composite',
    v: normalized.map(part => ({p: part.name, ...detectType(part.value)})),
  };
}

function decodeSerialized(raw: string): SerializedToken {
  const json = Buffer.from(raw, 'base64').toString('utf-8');
  return JSON.parse(json) as SerializedToken;
}

export function encodeEtagToken(parts: EtagPart[] | undefined): string | undefined {
  if (!parts?.length) return undefined;
  if (parts.length === 1) {
    const [{value}] = parts;
    return encodeSerializedToken(detectType(value));
  }
  return encodeSerializedToken(toCompositeToken(parts));
}

export function decodeEtagToken(
  headerValue: string,
  etagProperties: string[],
  propertyDefinitions?: Map<string, PropertyDefinition>,
): Record<string, unknown> | undefined {
  const trimmed = headerValue.trim();
  const withoutWeak = trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
  const firstProperty = etagProperties[0];
  if (!withoutWeak.startsWith('"') || !withoutWeak.endsWith('"')) {
    if (!firstProperty) return undefined;
    return {
      [firstProperty]: coerceToPropertyType(
        withoutWeak,
        propertyDefinitions?.get(firstProperty),
      ),
    };
  }
  const raw = withoutWeak.slice(1, -1);
  try {
    const parsed = decodeSerialized(raw);
    if ((parsed as CompositeToken).t === 'composite' && Array.isArray((parsed as CompositeToken).v)) {
      const entries: Record<string, unknown> = {};
      for (const component of (parsed as CompositeToken).v) {
        if (!component || typeof component.p !== 'string') continue;
        const revived = reviveType(component);
        entries[component.p] = coerceToPropertyType(
          revived,
          propertyDefinitions?.get(component.p),
        );
      }
      if (Object.keys(entries).length) return entries;
      return undefined;
    }
    if (!firstProperty) return undefined;
    const revived = reviveType(parsed as EncodedToken);
    return {
      [firstProperty]: coerceToPropertyType(
        revived,
        propertyDefinitions?.get(firstProperty),
      ),
    };
  } catch {
    if (!firstProperty) return undefined;
    return {
      [firstProperty]: coerceToPropertyType(
        raw,
        propertyDefinitions?.get(firstProperty),
      ),
    };
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

export function ensureEtagField(
  fields: Fields<AnyObject> | undefined,
  etagProperties: string[] | undefined,
) {
  if (!etagProperties?.length || fields == null) return fields;

  if (Array.isArray(fields)) {
    const missing = etagProperties.filter(property => !fields.includes(property));
    return missing.length ? [...fields, ...missing] : fields;
  }

  if (typeof fields === 'object') {
    const map = fields as Record<string, boolean>;
    let changed = false;
    const result: Record<string, boolean> = {...map};
    for (const property of etagProperties) {
      if (!result[property]) {
        result[property] = true;
        changed = true;
      }
    }
    return changed ? result : fields;
  }

  if (typeof fields === 'boolean') {
    if (fields) return fields;
    const result: Record<string, boolean> = {};
    for (const property of etagProperties) {
      result[property] = true;
    }
    return result;
  }

  return fields;
}

export function stripEtagProperty(
  entity: Record<string, unknown>,
  etagProperties?: string | string[],
) {
  const names = Array.isArray(etagProperties)
    ? etagProperties
    : etagProperties
    ? [etagProperties]
    : [];
  if (!names.length) return entity;
  const cloned = {...entity};
  for (const name of names) {
    delete cloned[name];
  }
  return cloned;
}

export function readEtagValues(
  entity: Record<string, unknown> | undefined,
  etagProperties: string[] | undefined,
): EtagPart[] | undefined {
  if (!entity || !etagProperties?.length) return undefined;
  return etagProperties.map(name => ({name, value: entity[name]}));
}

export interface DeltaTokenPayload {
  entitySet: string;
  lastValue: string;
  keyValues?: Record<string, unknown>;
  buckets?: Array<Record<string, unknown>>;
}

const LEGACY_PREFIX = 'v1:';
const JSON_PREFIX = 'v2:';

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function deserializeValue(value: string): unknown {
  if (value === 'null') return null;
  if (!Number.isNaN(Number(value)) && value.trim() !== '') {
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  return value;
}

function encodeKeyValues(keyValues?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!keyValues) return undefined;
  const entries = Object.entries(keyValues);
  if (!entries.length) return undefined;
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    serialized[key] = serializeValue(value);
  }
  return serialized;
}

function decodeKeyValuesObject(raw?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    result[key] = typeof value === 'string' ? deserializeValue(value) : value;
  }
  return result;
}

export function encodeDeltaToken(payload: DeltaTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `${JSON_PREFIX}${encoded}`;
}

function decodeLegacyToken(token: string): DeltaTokenPayload {
  const raw = Buffer.from(token.slice(LEGACY_PREFIX.length), 'base64').toString('utf8');
  const [entitySet, lastValue, keySegment] = raw.split('|');
  if (!entitySet || !lastValue) {
    throw new Error('Invalid delta token payload.');
  }
  const keyValues = keySegment
    ? keySegment.split('&').reduce<Record<string, unknown>>((acc, pair) => {
        if (!pair) return acc;
        const [keyRaw, valueRaw] = pair.split('=');
        if (!keyRaw) return acc;
        const key = decodeURIComponent(keyRaw);
        const value = valueRaw ? decodeURIComponent(valueRaw) : '';
        acc[key] = deserializeValue(value);
        return acc;
      }, {})
    : undefined;
  return {entitySet, lastValue, keyValues};
}

export function decodeDeltaToken(token: string): DeltaTokenPayload {
  if (!token) {
    throw new Error('Invalid delta token format.');
  }
  if (token.startsWith(JSON_PREFIX)) {
    const raw = Buffer.from(token.slice(JSON_PREFIX.length), 'base64').toString('utf8');
    const parsed = JSON.parse(raw) as DeltaTokenPayload;
    parsed.keyValues = decodeKeyValuesObject(parsed.keyValues);
    return parsed;
  }
  if (token.startsWith(LEGACY_PREFIX)) {
    return decodeLegacyToken(token);
  }
  throw new Error('Unsupported delta token format.');
}

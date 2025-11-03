import {
  DeltaTokenSecurityOptions,
  TokenVerificationError,
  signDeltaToken,
  verifyDeltaToken,
} from './token-signing';

export interface DeltaTokenBucketState {
  key: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface DeltaTokenPayload {
  entitySet: string;
  lastValue: string;
  keyValues?: Record<string, unknown>;
  buckets?: DeltaTokenBucketState[];
  issuedAt?: string;
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

export function encodeDeltaToken(
  payload: DeltaTokenPayload,
  options: DeltaTokenSecurityOptions,
): string {
  const encodedPayload: DeltaTokenPayload = {
    entitySet: payload.entitySet,
    lastValue: payload.lastValue,
    keyValues: encodeKeyValues(payload.keyValues),
    buckets: payload.buckets ? payload.buckets.map(cloneBucketState) : undefined,
    issuedAt: payload.issuedAt ?? new Date().toISOString(),
  };
  return signDeltaToken(encodedPayload, options);
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
  return { entitySet, lastValue, keyValues };
}

function decodeJsonToken(token: string): DeltaTokenPayload {
  const raw = Buffer.from(token.slice(JSON_PREFIX.length), 'base64').toString('utf8');
  const parsed = JSON.parse(raw) as {
    entitySet: string;
    lastValue: string;
    keyValues?: Record<string, unknown>;
    buckets?: unknown;
    issuedAt?: string;
  };
  if (!parsed?.entitySet || !parsed?.lastValue) {
    throw new Error('Invalid delta token payload.');
  }
  return {
    entitySet: parsed.entitySet,
    lastValue: parsed.lastValue,
    keyValues: decodeKeyValuesObject(parsed.keyValues),
    buckets: normalizeBucketStates(parsed.buckets),
    issuedAt: parsed.issuedAt,
  };
}

export function decodeDeltaToken(
  token: string,
  options: DeltaTokenSecurityOptions,
): DeltaTokenPayload {
  if (!token) {
    throw new TokenVerificationError('Invalid delta token format.', 'invalid');
  }
  if (token.startsWith(JSON_PREFIX)) {
    return decodeJsonToken(token);
  }
  if (token.startsWith(LEGACY_PREFIX)) {
    return decodeLegacyToken(token);
  }
  const payload = verifyDeltaToken<DeltaTokenPayload>(
    token,
    options,
    options.allowLegacyUnsigned ? decodeLegacyToken : undefined,
  );
  return {
    entitySet: payload.entitySet,
    lastValue: payload.lastValue,
    keyValues: decodeKeyValuesObject(payload.keyValues),
    buckets: normalizeBucketStates(payload.buckets),
    issuedAt: payload.issuedAt,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord(
  source: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!source) return undefined;
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    clone[key] = value;
  }
  return clone;
}

function cloneBucketState(entry: DeltaTokenBucketState): DeltaTokenBucketState {
  return {
    key: cloneRecord(entry.key) ?? {},
    data: cloneRecord(entry.data),
  };
}

function normalizeBucketStates(raw?: unknown): DeltaTokenBucketState[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const normalized: DeltaTokenBucketState[] = [];
  for (const entry of raw) {
    if (!isPlainRecord(entry)) continue;
    const candidate = entry as {
      key?: Record<string, unknown>;
      data?: Record<string, unknown>;
    };
    const key = isPlainRecord(candidate.key) ? cloneRecord(candidate.key) : undefined;
    const data = isPlainRecord(candidate.data) ? cloneRecord(candidate.data) : undefined;
    if (key) {
      normalized.push(data ? { key, data } : { key });
      continue;
    }
    normalized.push({ key: cloneRecord(candidate as Record<string, unknown>) ?? {} });
  }
  return normalized.length ? normalized : undefined;
}

import {
  DeltaTokenSecurityOptions,
  MAX_TOKEN_ENVELOPE_BYTES,
  TokenVerificationError,
  signDeltaToken,
  verifyDeltaToken,
} from './token-signing';
import { safeDecodeURIComponent } from './url-decoding';

export interface DeltaTokenBucketState {
  key: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface DeltaTokenPayload {
  entitySet: string;
  lastValue: string;
  keyValues?: Record<string, unknown>;
  pageKeys?: Record<string, unknown>[];
  buckets?: DeltaTokenBucketState[];
  issuedAt?: string;
}

const LEGACY_PREFIX = 'v1:';
const JSON_PREFIX = 'v2:';

type EncodedDeltaValue =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'bigint'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: string }
  | { kind: 'json'; value: string };

function encodeValue(value: unknown): EncodedDeltaValue {
  if (value === null || value === undefined) return { kind: 'null' };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { kind: 'string', value: String(value) };
    return { kind: 'number', value: value.toString() };
  }
  if (typeof value === 'bigint') {
    return { kind: 'bigint', value: value.toString() };
  }
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (value instanceof Date) return { kind: 'date', value: value.toISOString() };
  if (typeof value === 'object') {
    return { kind: 'json', value: JSON.stringify(value) };
  }
  return { kind: 'string', value: String(value) };
}

function decodeStoredValue(value: unknown): unknown {
  if (isEncodedDeltaValue(value)) {
    switch (value.kind) {
      case 'null':
        return null;
      case 'string':
        return value.value ?? '';
      case 'number':
        return typeof value.value === 'string' ? Number(value.value) : Number(value.value ?? 0);
      case 'bigint':
        if (typeof value.value === 'string') {
          try {
            return BigInt(value.value);
          } catch {
            return value.value;
          }
        }
        return value.value;
      case 'boolean':
        return Boolean(value.value);
      case 'date':
        if (typeof value.value === 'string') {
          const date = new Date(value.value);
          if (!Number.isNaN(date.getTime())) return date;
          return value.value;
        }
        return value.value;
      case 'json':
        if (typeof value.value === 'string') {
          try {
            return JSON.parse(value.value);
          } catch {
            return value.value;
          }
        }
        return value.value;
      default:
        return (value as { value?: unknown }).value;
    }
  }
  if (typeof value === 'string') {
    return coerceLegacyValue(value);
  }
  return value;
}

function isEncodedDeltaValue(value: unknown): value is EncodedDeltaValue {
  if (!value || typeof value !== 'object') return false;
  const marker = (value as { kind?: unknown }).kind;
  return typeof marker === 'string';
}

function coerceLegacyValue(value: string): unknown {
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
    serialized[key] = encodeValue(value);
  }
  return serialized;
}

function encodeKeyValuesArray(
  list?: Record<string, unknown>[],
): Record<string, unknown>[] | undefined {
  if (!list?.length) return undefined;
  const result = list
    .map((entry) => encodeKeyValues(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  return result.length ? result : undefined;
}

function decodeKeyValuesObject(raw?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    result[key] = decodeStoredValue(value);
  }
  return result;
}

function decodeKeyValuesArray(raw?: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const decoded = raw
    .map((entry) =>
      typeof entry === 'object' && entry
        ? decodeKeyValuesObject(entry as Record<string, unknown>)
        : undefined,
    )
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  return decoded.length ? decoded : undefined;
}

function encodeStructuredValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => encodeStructuredValue(entry));
  }
  if (isPlainRecord(value)) {
    const encoded: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      encoded[key] = encodeStructuredValue(nested);
    }
    return encoded;
  }
  return encodeValue(value);
}

function decodeStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => decodeStructuredValue(entry));
  }
  if (isEncodedDeltaValue(value)) {
    return decodeStoredValue(value);
  }
  if (isPlainRecord(value)) {
    const decoded: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      decoded[key] = decodeStructuredValue(nested);
    }
    return decoded;
  }
  return value;
}

function encodeBucketState(entry: DeltaTokenBucketState): DeltaTokenBucketState {
  return {
    key: (encodeStructuredValue(entry.key) as Record<string, unknown>) ?? {},
    data: isPlainRecord(entry.data)
      ? (encodeStructuredValue(entry.data) as Record<string, unknown>)
      : undefined,
  };
}

function decodeBucketState(entry: DeltaTokenBucketState): DeltaTokenBucketState {
  return {
    key: (decodeStructuredValue(entry.key) as Record<string, unknown>) ?? {},
    data: isPlainRecord(entry.data)
      ? (decodeStructuredValue(entry.data) as Record<string, unknown>)
      : undefined,
  };
}

export function encodeDeltaToken(
  payload: DeltaTokenPayload,
  options: DeltaTokenSecurityOptions,
): string {
  const encodedPayload: DeltaTokenPayload = {
    entitySet: payload.entitySet,
    lastValue: payload.lastValue,
    keyValues: encodeKeyValues(payload.keyValues),
    pageKeys: encodeKeyValuesArray(payload.pageKeys),
    buckets: payload.buckets ? payload.buckets.map((entry) => encodeBucketState(entry)) : undefined,
    issuedAt: payload.issuedAt ?? new Date().toISOString(),
  };
  return signDeltaToken(encodedPayload, options);
}

function decodeLegacyPayload(raw: string): string {
  const decodedBuffer = Buffer.from(raw, 'base64');
  if (decodedBuffer.length > MAX_TOKEN_ENVELOPE_BYTES) {
    throw new TokenVerificationError('Token payload exceeds maximum size.', 'invalid');
  }
  return decodedBuffer.toString('utf8');
}

function decodeLegacyToken(token: string): DeltaTokenPayload {
  const raw = decodeLegacyPayload(token.slice(LEGACY_PREFIX.length));
  const [entitySet, lastValue, keySegment] = raw.split('|');
  if (!entitySet || !lastValue) {
    throw new Error('Invalid delta token payload.');
  }
  const keyValues = keySegment
    ? keySegment.split('&').reduce<Record<string, unknown>>((acc, pair) => {
        if (!pair) return acc;
        const [keyRaw, valueRaw] = pair.split('=');
        if (!keyRaw) return acc;
        const key = safeDecodeURIComponent(keyRaw);
        const value = valueRaw ? safeDecodeURIComponent(valueRaw) : '';
        if (!key || value === undefined) {
          throw new Error('Invalid delta token payload.');
        }
        acc[key] = coerceLegacyValue(value);
        return acc;
      }, {})
    : undefined;
  return { entitySet, lastValue, keyValues };
}

function decodeJsonToken(token: string): DeltaTokenPayload {
  const raw = decodeLegacyPayload(token.slice(JSON_PREFIX.length));
  const parsed = JSON.parse(raw) as {
    entitySet: string;
    lastValue: string;
    keyValues?: Record<string, unknown>;
    pageKeys?: Record<string, unknown>[];
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
    pageKeys: decodeKeyValuesArray(parsed.pageKeys),
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
    if (!options.allowLegacyUnsigned) {
      throw new TokenVerificationError('Legacy delta tokens are not allowed.', 'legacy-denied');
    }
    return decodeJsonToken(token);
  }
  if (token.startsWith(LEGACY_PREFIX)) {
    if (!options.allowLegacyUnsigned) {
      throw new TokenVerificationError('Legacy delta tokens are not allowed.', 'legacy-denied');
    }
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
    pageKeys: decodeKeyValuesArray(payload.pageKeys),
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
      normalized.push(decodeBucketState(data ? { key, data } : { key }));
      continue;
    }
    normalized.push(
      decodeBucketState({ key: cloneRecord(candidate as Record<string, unknown>) ?? {} }),
    );
  }
  return normalized.length ? normalized : undefined;
}

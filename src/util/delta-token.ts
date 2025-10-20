export interface DeltaTokenPayload {
  entitySet: string;
  lastValue: string;
  keyValues?: Record<string, unknown>;
}

const VERSION_PREFIX = 'v1:';

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

function encodeKeyValues(keyValues?: Record<string, unknown>): string | undefined {
  if (!keyValues) return undefined;
  const entries = Object.entries(keyValues);
  if (!entries.length) return undefined;
  const serialized = entries.map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(serializeValue(val))}`);
  return serialized.join('&');
}

function decodeKeyValues(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const result: Record<string, unknown> = {};
  for (const segment of raw.split('&')) {
    if (!segment) continue;
    const [keyRaw, valueRaw] = segment.split('=');
    if (!keyRaw) continue;
    const key = decodeURIComponent(keyRaw);
    const value = valueRaw ? decodeURIComponent(valueRaw) : '';
    result[key] = deserializeValue(value);
  }
  return result;
}

export function encodeDeltaToken(payload: DeltaTokenPayload): string {
  const segments: string[] = [payload.entitySet, payload.lastValue];
  const keySegment = encodeKeyValues(payload.keyValues);
  if (keySegment) segments.push(keySegment);
  const serialized = segments.join('|');
  const encoded = Buffer.from(serialized, 'utf8').toString('base64');
  return `${VERSION_PREFIX}${encoded}`;
}

export function decodeDeltaToken(token: string): DeltaTokenPayload {
  if (!token?.startsWith(VERSION_PREFIX)) {
    throw new Error('Unsupported delta token format.');
  }
  const raw = Buffer.from(token.slice(VERSION_PREFIX.length), 'base64').toString('utf8');
  const [entitySet, lastValue, keySegment] = raw.split('|');
  if (!entitySet || !lastValue) {
    throw new Error('Invalid delta token payload.');
  }
  return {
    entitySet,
    lastValue,
    keyValues: decodeKeyValues(keySegment),
  };
}

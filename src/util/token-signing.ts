import { createHmac, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'crypto';

export interface TokenSecurityOptions {
  secret: string;
  ttlSeconds?: number;
  allowLegacyUnsigned?: boolean;
}

export class TokenVerificationError extends Error {
  constructor(
    message: string,
    public readonly reason: 'invalid' | 'expired' | 'legacy-denied',
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

type TokenEnvelope<T> = {
  v: 'v3';
  type: string;
  iat: number;
  exp?: number;
  nonce: string;
  data: T;
  sig: string;
};

const TOKEN_VERSION: TokenEnvelope<unknown>['v'] = 'v3';
const MAX_TOKEN_ENVELOPE_BYTES = 64 * 1024; // keep envelopes under 64KB to avoid blocking JSON parsing

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, function replacer(this: unknown, key: string, val: unknown) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
    const sorted: Record<string, unknown> = {};
    for (const entryKey of Object.keys(val).sort()) {
      sorted[entryKey] = (val as Record<string, unknown>)[entryKey];
    }
    return sorted;
  });
}

function encodeEnvelope<T>(envelope: TokenEnvelope<T>): string {
  const raw = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  return `${envelope.v}:${raw}`;
}

function decodeEnvelope(token: string): TokenEnvelope<unknown> {
  const separator = token.indexOf(':');
  if (separator < 0) {
    throw new TokenVerificationError('Token is missing version prefix.', 'invalid');
  }
  const prefix = token.slice(0, separator);
  if (prefix !== TOKEN_VERSION) {
    throw new TokenVerificationError('Unsupported token version.', 'invalid');
  }
  const payload = token.slice(separator + 1);
  try {
    const decodedBuffer = Buffer.from(payload, 'base64url');
    if (decodedBuffer.length > MAX_TOKEN_ENVELOPE_BYTES) {
      throw new TokenVerificationError('Token payload exceeds maximum size.', 'invalid');
    }
    const decoded = decodedBuffer.toString('utf8');
    const envelope = JSON.parse(decoded) as TokenEnvelope<unknown>;
    if (envelope?.v !== TOKEN_VERSION || typeof envelope.type !== 'string') {
      throw new Error('Malformed envelope.');
    }
    return envelope;
  } catch (error) {
    if (error instanceof TokenVerificationError) throw error;
    throw new TokenVerificationError('Failed to decode token payload.', 'invalid');
  }
}

function computeSignature<T>(envelope: TokenEnvelope<T>, secret: string): string {
  const { sig, ...unsigned } = envelope;
  const serialized = stableStringify(unsigned);
  return createHmac('sha256', secret).update(serialized).digest('base64url');
}

export function signToken<T>(type: string, data: T, options: TokenSecurityOptions): string {
  if (!options.secret) {
    throw new Error('Missing token secret.');
  }
  const issuedAt = Date.now();
  const ttlMs =
    options.ttlSeconds && Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0
      ? Math.floor(options.ttlSeconds * 1000)
      : undefined;
  const expiresAt = ttlMs ? issuedAt + ttlMs : undefined;
  const envelope: TokenEnvelope<T> = {
    v: TOKEN_VERSION,
    type,
    iat: issuedAt,
    exp: expiresAt,
    nonce: randomBytes(12).toString('base64url'),
    data,
    sig: '',
  };
  envelope.sig = computeSignature(envelope, options.secret);
  return encodeEnvelope(envelope);
}

export function verifyToken<T>(
  token: string,
  type: string,
  options: TokenSecurityOptions,
): { data: T; issuedAt: number; expiresAt?: number } {
  if (!options.secret) {
    throw new TokenVerificationError('Missing token secret.', 'invalid');
  }
  const envelope = decodeEnvelope(token);
  if (envelope.type !== type) {
    throw new TokenVerificationError('Token type mismatch.', 'invalid');
  }
  if (envelope.exp && envelope.exp < Date.now()) {
    throw new TokenVerificationError('Token has expired.', 'expired');
  }
  const expectedSig = computeSignature(envelope, options.secret);
  if (!safeEqual(envelope.sig, expectedSig)) {
    throw new TokenVerificationError('Token signature mismatch.', 'invalid');
  }
  return { data: envelope.data as T, issuedAt: envelope.iat, expiresAt: envelope.exp };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return nodeTimingSafeEqual(bufA, bufB);
}

export interface SkipTokenPayload {
  descriptor: string;
  context: string;
  values: string[];
}

export function signSkipToken(payload: SkipTokenPayload, options: TokenSecurityOptions): string {
  return signToken('skip', payload, options);
}

export function verifySkipToken(
  token: string,
  expectedDescriptor: string,
  expectedContext: string,
  options: TokenSecurityOptions,
): { values: string[] } {
  const { data } = verifyToken<SkipTokenPayload>(token, 'skip', options);
  if (!data || data.descriptor !== expectedDescriptor || data.context !== expectedContext) {
    throw new TokenVerificationError('Skip token descriptor mismatch.', 'invalid');
  }
  if (!Array.isArray(data.values)) {
    throw new TokenVerificationError('Skip token payload is invalid.', 'invalid');
  }
  return { values: [...data.values] };
}

export interface DeltaTokenSecurityOptions extends TokenSecurityOptions {
  allowLegacyUnsigned?: boolean;
}

export function signDeltaToken<T>(payload: T, options: DeltaTokenSecurityOptions): string {
  return signToken('delta', payload, options);
}

export function verifyDeltaToken<T>(
  token: string,
  options: DeltaTokenSecurityOptions,
  legacyDecoder?: (token: string) => T,
): T {
  if (token.startsWith('v1:') || token.startsWith('v2:')) {
    if (!options.allowLegacyUnsigned) {
      throw new TokenVerificationError('Legacy delta tokens are not allowed.', 'legacy-denied');
    }
    if (!legacyDecoder) {
      throw new TokenVerificationError('Legacy delta decoder not provided.', 'invalid');
    }
    return legacyDecoder(token);
  }
  const { data } = verifyToken<T>(token, 'delta', options);
  return data;
}

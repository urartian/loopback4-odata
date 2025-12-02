import 'reflect-metadata';
import { expect } from '@loopback/testlab';
import {
  signSkipToken,
  verifySkipToken,
  signDeltaToken,
  verifyDeltaToken,
  TokenVerificationError,
} from '../../util/token-signing';

describe('Token signing guardrails', () => {
  const ORIGINAL_NOW = Date.now;

  afterEach(() => {
    Date.now = ORIGINAL_NOW;
  });

  it('expires skip tokens after configured TTL', () => {
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const token = signSkipToken(
      { descriptor: 'id:ASC', context: 'GET:/odata/Products?', values: ['1'] },
      { secret: 'skip-secret', ttlSeconds: 1 },
    );

    now += 500;
    const payload = verifySkipToken(token, 'id:ASC', 'GET:/odata/Products?', {
      secret: 'skip-secret',
    });
    expect(payload.values).to.deepEqual(['1']);

    now += 1_200;
    try {
      verifySkipToken(token, 'id:ASC', 'GET:/odata/Products?', {
        secret: 'skip-secret',
      });
      throw new Error('Expected skip token to expire.');
    } catch (error) {
      expect(error).to.be.instanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).to.equal('expired');
    }
  });

  it('expires delta tokens after configured TTL', () => {
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const token = signDeltaToken(
      { entitySet: 'Products', lastValue: '2024-01-01T00:00:00Z' },
      { secret: 'delta-secret', ttlSeconds: 1 },
    );

    now += 400;
    const parsed = verifyDeltaToken(token, { secret: 'delta-secret' });
    expect(parsed).to.containDeep({
      entitySet: 'Products',
      lastValue: '2024-01-01T00:00:00Z',
    });

    now += 1_500;
    try {
      verifyDeltaToken(token, { secret: 'delta-secret' });
      throw new Error('Expected delta token to expire.');
    } catch (error) {
      expect(error).to.be.instanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).to.equal('expired');
    }
  });

  it('rejects legacy delta tokens when allowLegacyUnsigned=false', () => {
    const legacyPayload = Buffer.from('Products|2024-01-01T00:00:00Z|', 'utf8').toString('base64');
    const legacyToken = `v1:${legacyPayload}`;

    try {
      verifyDeltaToken(legacyToken, { secret: 'delta-secret' });
      throw new Error('Expected legacy token rejection.');
    } catch (error) {
      expect(error).to.be.instanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).to.equal('legacy-denied');
    }
  });

  it('accepts legacy delta tokens when allowLegacyUnsigned=true and decoder provided', () => {
    const legacyPayload = Buffer.from('Products|2024-01-01T00:00:00Z|', 'utf8').toString('base64');
    const legacyToken = `v1:${legacyPayload}`;

    const result = verifyDeltaToken(
      legacyToken,
      { secret: 'delta-secret', allowLegacyUnsigned: true },
      () => ({ ok: true }),
    );
    expect(result).to.deepEqual({ ok: true });
  });

  it('rejects oversized token payloads before JSON parsing is attempted', () => {
    const massivePayload = Buffer.alloc(70 * 1024, 'a').toString('base64url');
    const massiveToken = `v3:${massivePayload}`;
    try {
      verifySkipToken(massiveToken, 'id:ASC', 'GET:/odata/Products?', { secret: 'skip-secret' });
      throw new Error('Expected oversized token to be rejected.');
    } catch (error) {
      expect(error).to.be.instanceOf(TokenVerificationError);
      expect((error as TokenVerificationError).reason).to.equal('invalid');
    }
  });
});

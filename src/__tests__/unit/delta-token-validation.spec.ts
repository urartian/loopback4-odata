import { expect } from '@loopback/testlab';
import { TokenVerificationError } from '../../util/token-signing';
import { validateDeltaToken } from '../../util/delta-token-validation';

describe('delta token validation helper', () => {
  it('rejects when delta support is disabled', () => {
    const result = validateDeltaToken({
      deltaEnabled: false,
      entitySet: 'Products',
      decode: () => {
        throw new Error('should not decode');
      },
    });
    expect(result).to.containDeep({ ok: false, code: 'delta-not-supported' });
  });

  it('rejects expired tokens with dedicated code', () => {
    const result = validateDeltaToken({
      deltaEnabled: true,
      entitySet: 'Products',
      decode: () => {
        throw new TokenVerificationError('expired', 'expired');
      },
    });
    expect(result).to.containDeep({ ok: false, code: 'expired' });
  });

  it('rejects tokens targeting another entity set', () => {
    const result = validateDeltaToken({
      deltaEnabled: true,
      entitySet: 'Products',
      decode: () => ({
        entitySet: 'Orders',
        lastValue: 'abc',
      }),
    });
    expect(result).to.containDeep({ ok: false, code: 'entity-mismatch' });
  });

  it('returns payload when token is valid', () => {
    const result = validateDeltaToken({
      deltaEnabled: true,
      entitySet: 'Products',
      decode: () => ({
        entitySet: 'Products',
        lastValue: 'abc',
      }),
    });
    expect(result).to.deepEqual({
      ok: true,
      payload: { entitySet: 'Products', lastValue: 'abc' },
    });
  });
});

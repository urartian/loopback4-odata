import { expect } from '@loopback/testlab';
import { decodeDeltaToken, encodeDeltaToken } from '../../util/delta-token';
import { TokenVerificationError } from '../../util/token-signing';

describe('delta token encode/decode', () => {
  const options = { secret: 'delta-secret' };

  it('preserves numeric-looking string key values', () => {
    const token = encodeDeltaToken(
      {
        entitySet: 'Products',
        lastValue: 'cursor',
        keyValues: { id: '000123', code: 'true', region: '01' },
      },
      options,
    );
    const decoded = decodeDeltaToken(token, options);
    expect(decoded.keyValues).to.deepEqual({ id: '000123', code: 'true', region: '01' });
  });

  it('round-trips numbers and booleans inside page keys', () => {
    const token = encodeDeltaToken(
      {
        entitySet: 'Products',
        lastValue: 'cursor',
        keyValues: { isActive: true, offset: 42 },
        pageKeys: [
          { id: 'A', isActive: false },
          { id: 'B', amount: 0.0123 },
        ],
      },
      options,
    );
    const decoded = decodeDeltaToken(token, options);
    expect(decoded.keyValues?.isActive).to.equal(true);
    expect(decoded.keyValues?.offset).to.equal(42);
    expect(decoded.pageKeys).to.have.length(2);
    expect(decoded.pageKeys?.[0]).to.deepEqual({ id: 'A', isActive: false });
    expect(decoded.pageKeys?.[1]?.amount).to.equal(0.0123);
  });

  it('rejects legacy tokens when allowLegacyUnsigned is false', () => {
    const raw = Buffer.from(
      JSON.stringify({ entitySet: 'Products', lastValue: 'cursor' }),
      'utf8',
    ).toString('base64');
    const token = `v2:${raw}`;
    expect(() => decodeDeltaToken(token, options)).to.throw(TokenVerificationError);
  });

  it('decodes legacy tokens when allowLegacyUnsigned is true', () => {
    const legacyPayload = Buffer.from('Products|cursor|id=1', 'utf8').toString('base64');
    const token = `v1:${legacyPayload}`;
    const decoded = decodeDeltaToken(token, { ...options, allowLegacyUnsigned: true });
    expect(decoded).to.containDeep({
      entitySet: 'Products',
      lastValue: 'cursor',
      keyValues: { id: 1 },
    });
  });
});

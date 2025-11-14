import { expect } from '@loopback/testlab';
import { decodeDeltaToken, encodeDeltaToken } from '../../util/delta-token';

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
});

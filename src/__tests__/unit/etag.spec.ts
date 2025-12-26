import { expect } from '@loopback/testlab';
import { decodeIfMatchValues } from '../../util/etag';

describe('ETag decoding', () => {
  it('treats malformed percent-encoding as invalid, not a crash', () => {
    const { values, invalidComposite } = decodeIfMatchValues(
      ['W/"id=1&version=%ZZ"'],
      ['id', 'version'],
    );
    expect(values).to.deepEqual([]);
    expect(invalidComposite).to.equal(true);
  });

  it('rejects malformed percent-encoding in composite keys', () => {
    const { values, invalidComposite } = decodeIfMatchValues(
      ['W/"%ZZ=1&version=2"'],
      ['id', 'version'],
    );
    expect(values).to.deepEqual([]);
    expect(invalidComposite).to.equal(true);
  });
});

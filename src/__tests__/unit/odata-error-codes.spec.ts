import { strict as assert } from 'assert';
import { ODataErrorCodes } from '../../odata-error-codes';

describe('ODataErrorCodes', () => {
  it('contains no duplicate values', () => {
    const values = Object.values(ODataErrorCodes);
    const unique = new Set(values);
    assert.equal(unique.size, values.length);
  });

  it('uses a predictable code format', () => {
    const values = Object.values(ODataErrorCodes);
    for (const value of values) {
      assert.match(value, /^[A-Za-z0-9._-]+$/);
    }
  });
});

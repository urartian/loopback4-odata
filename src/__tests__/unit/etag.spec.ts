import { expect } from '@loopback/testlab';
import {
  decodeEtagToken,
  decodeIfMatchValues,
  encodeEtagToken,
  ensureEtagField,
  matchesEtag,
  normalizeEtagProperties,
  parseIfMatch,
  parseIfNoneMatch,
  readEtagValue,
  stripEtagProperty,
} from '../../util/etag';

describe('ETag decoding', () => {
  it('normalizes and sorts etag property lists', () => {
    expect(normalizeEtagProperties(['updatedAt', 'version', 'updatedAt'])).to.deepEqual([
      'updatedAt',
      'version',
    ]);
    expect(normalizeEtagProperties('updatedAt')).to.deepEqual(['updatedAt']);
    expect(normalizeEtagProperties(undefined)).to.equal(undefined);
  });

  it('encodes and decodes atomic ETags', () => {
    const encoded = encodeEtagToken(new Date('2024-01-02T03:04:05.000Z'), 'updatedAt');
    expect(encoded).to.equal('W/"2024-01-02T03:04:05.000Z"');

    const decoded = decodeEtagToken(encoded!, 'updatedAt', {
      updatedAt: { type: 'date' } as any,
    });
    expect(decoded).to.be.instanceOf(Date);
    expect((decoded as Date).toISOString()).to.equal('2024-01-02T03:04:05.000Z');
  });

  it('encodes and decodes composite ETags with property coercion', () => {
    const encoded = encodeEtagToken({ id: 7, version: '9' }, ['version', 'id']);
    expect(encoded).to.equal('W/"id=7&version=9"');

    const decoded = decodeEtagToken(encoded!, ['id', 'version'], {
      id: { type: 'number' } as any,
      version: { type: 'bigint' } as any,
    });

    expect(decoded).to.deepEqual({ id: 7, version: BigInt(9) });
  });

  it('returns undefined for invalid composite ETag payloads', () => {
    expect(decodeEtagToken('W/"bad-segment"', ['id', 'version'])).to.equal(undefined);
    expect(
      decodeEtagToken('W/"id=1&version=%ZZ"', ['id', 'version'], {
        id: { type: 'number' } as any,
      }),
    ).to.equal(undefined);
  });

  it('parses If-Match and If-None-Match headers', () => {
    expect(parseIfMatch(undefined)).to.equal(undefined);
    expect(parseIfMatch(' * ')).to.deepEqual({ any: true, values: [] });
    expect(parseIfMatch('W/"1", "2"')).to.deepEqual({
      any: false,
      values: ['W/"1"', '"2"'],
    });
    expect(parseIfNoneMatch('*')).to.deepEqual({ any: true, values: [] });
  });

  it('matches weak and strong ETags by normalized value', () => {
    expect(matchesEtag('W/"abc"', ['"abc"'])).to.equal(true);
    expect(matchesEtag('"abc"', ['W/"abc"'])).to.equal(true);
    expect(matchesEtag(undefined, ['"abc"'])).to.equal(false);
  });

  it('ensures etag fields are retained in array, object, and boolean field specs', () => {
    expect(ensureEtagField(['id'], ['updatedAt', 'version'])).to.deepEqual([
      'id',
      'updatedAt',
      'version',
    ]);
    expect(ensureEtagField({ id: true }, 'updatedAt')).to.deepEqual({
      id: true,
      updatedAt: true,
    });
    expect(ensureEtagField(false as any, ['updatedAt', 'version'])).to.deepEqual({
      updatedAt: true,
      version: true,
    });
    expect(ensureEtagField(true as any, 'updatedAt')).to.equal(true);
  });

  it('reads and strips ETag properties from entities', () => {
    const entity = { id: 1, updatedAt: 'stamp', version: 2 };
    expect(readEtagValue(entity, 'updatedAt')).to.equal('stamp');
    expect(readEtagValue(entity, ['updatedAt', 'version'])).to.deepEqual({
      updatedAt: 'stamp',
      version: 2,
    });
    expect(stripEtagProperty(entity, ['updatedAt', 'version'])).to.deepEqual({ id: 1 });
  });

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

  it('drops incomplete composite If-Match values and marks them invalid', () => {
    const { values, invalidComposite } = decodeIfMatchValues(['W/"id=1"'], ['id', 'version']);
    expect(values).to.deepEqual([]);
    expect(invalidComposite).to.equal(true);
  });

  it('decodes complete composite If-Match values', () => {
    const { values, invalidComposite } = decodeIfMatchValues(
      ['W/"id=1&version=true"'],
      ['id', 'version'],
      {
        id: { type: 'number' } as any,
        version: { type: 'boolean' } as any,
      },
    );
    expect(values).to.deepEqual([{ id: 1, version: true }]);
    expect(invalidComposite).to.equal(false);
  });
});

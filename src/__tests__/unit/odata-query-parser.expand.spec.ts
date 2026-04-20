/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { RelationDefinitionMap } from '@loopback/repository';
import { parseODataQuery } from '../../services/odata-query-parser.service';

class Customer {}
(Customer as any).definition = {
  relations: {
    customer: { name: 'customer', target: () => Customer },
  },
};

class Product {}
(Product as any).definition = { relations: {} };

class Item {}
(Item as any).definition = {
  relations: {
    product: { name: 'product', target: () => Product },
  },
};

const relations = {
  customer: { name: 'customer', target: () => Customer },
  items: { name: 'items', target: () => Item },
} as unknown as RelationDefinitionMap;

const parse = (query: Record<string, unknown>) =>
  parseODataQuery(query as Record<string, string | string[] | undefined>, { relations });

describe('parseODataQuery expansions & counts', () => {
  it('parses comma-separated expand list', () => {
    const result = parse({ $expand: 'customer, items' });
    assert.deepStrictEqual(result.include, [{ relation: 'customer' }, { relation: 'items' }]);
  });

  it('parses array expand list', () => {
    const result = parse({ $expand: ['customer', 'items'] });
    assert.deepStrictEqual(result.include, [{ relation: 'customer' }, { relation: 'items' }]);
  });

  it('deduplicates repeated relations', () => {
    const result = parse({ $expand: 'customer,customer' });
    assert.deepStrictEqual(result.include, [{ relation: 'customer' }]);
  });

  it('returns undefined include when expand missing', () => {
    const result = parse({});
    assert.equal(result.include, undefined);
    assert.equal(result.inlineCount, undefined);
  });

  it('throws for unknown relation names', () => {
    assert.throws(() => parse({ $expand: 'unknown' }), /Unknown expand relation: unknown/);
  });

  it('parses expand options with $select', () => {
    const result = parse({ $expand: 'customer($select=id,name)' });
    assert.deepStrictEqual(result.include, [
      {
        relation: 'customer',
        scope: {
          fields: { id: true, name: true },
        },
      },
    ]);
  });

  it('rejects invalid scoped expand paging and ordering options', () => {
    assert.throws(() => parse({ $expand: 'items($top=-1)' }), /Invalid \$top value/i);
    assert.throws(() => parse({ $expand: 'items($skip=abc)' }), /Invalid \$skip value/i);
    assert.throws(() => parse({ $expand: 'items($orderby=name sideways)' }), /Invalid \$orderby/i);
  });

  it('parses repository-supported scoped expand filters', () => {
    const result = parse({ $expand: "items($filter=name eq 'abc')" });
    assert.deepStrictEqual(result.include, [
      {
        relation: 'items',
        scope: {
          where: { name: 'abc' },
        },
      },
    ]);
  });

  it('rejects scoped expand filters that need relation post-filter evaluation', () => {
    const filters = [
      "tolower(name) eq 'abc'",
      "contains(tolower(name),'abc')",
      "trim(name) eq 'abc'",
      "concat(name,'-',code) eq 'abc-001'",
      "product/any(p:p/name eq 'abc')",
    ];

    for (const filter of filters) {
      assert.throws(
        () => parse({ $expand: `items($filter=${filter})` }),
        /\$expand \$filter requires unsupported relation post-filter evaluation/i,
      );
    }
  });

  it('keeps expanded relation when root $select omits navigation property', () => {
    const result = parse({ $select: 'id,name', $expand: 'customer' });
    assert.deepStrictEqual(result.include, [{ relation: 'customer' }]);
    assert.deepStrictEqual(result.fields, { id: true, name: true, customer: true });
  });

  it('parses nested expand options recursively', () => {
    const result = parse({ $expand: 'items($expand=product($select=id))' });
    assert.deepStrictEqual(result.include, [
      {
        relation: 'items',
        scope: {
          include: [
            {
              relation: 'product',
              scope: {
                fields: { id: true },
              },
            },
          ],
        },
      },
    ]);
  });

  it('preserves nested relation fields within scoped $select', () => {
    const result = parse({ $expand: 'items($select=id;$expand=product($select=id))' });
    assert.deepStrictEqual(result.include, [
      {
        relation: 'items',
        scope: {
          fields: { id: true, product: true },
          include: [
            {
              relation: 'product',
              scope: {
                fields: { id: true },
              },
            },
          ],
        },
      },
    ]);
  });

  it('supports slash-separated navigation paths', () => {
    const result = parse({ $expand: 'items/product($select=id)' });
    assert.deepStrictEqual(result.include, [
      {
        relation: 'items',
        scope: {
          include: [
            {
              relation: 'product',
              scope: {
                fields: { id: true },
              },
            },
          ],
        },
      },
    ]);
  });

  it('parses $levels option for recursive expansions', () => {
    const result = parse({ $expand: 'customer($levels=2)' });
    assert.deepStrictEqual(result.include, [
      {
        relation: 'customer',
        scope: {
          include: [
            {
              relation: 'customer',
            },
          ],
        },
      },
    ]);
  });

  it('parses $count=true into inlineCount flag', () => {
    const result = parse({ $count: 'true' });
    assert.equal(result.inlineCount, true);
  });
});

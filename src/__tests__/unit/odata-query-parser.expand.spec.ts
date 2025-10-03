/// <reference path="../../types/testing.globals.d.ts" />

import {strict as assert} from 'assert';
import {RelationDefinitionMap} from '@loopback/repository';
import {parseODataQuery} from '../../services/odata-query-parser.service';

class Customer {}
(Customer as any).definition = {relations: {}};

class Product {}
(Product as any).definition = {relations: {}};

class Item {}
(Item as any).definition = {
  relations: {
    product: {name: 'product', target: () => Product},
  },
};

const relations = {
  customer: {name: 'customer', target: () => Customer},
  items: {name: 'items', target: () => Item},
} as unknown as RelationDefinitionMap;

const parse = (query: Record<string, unknown>) =>
  parseODataQuery(query as Record<string, string | string[] | undefined>, {relations});

describe('parseODataQuery expansions & counts', () => {
  it('parses comma-separated expand list', () => {
    const result = parse({'$expand': 'customer, items'});
    assert.deepStrictEqual(result.include, [
      {relation: 'customer'},
      {relation: 'items'},
    ]);
  });

  it('parses array expand list', () => {
    const result = parse({'$expand': ['customer', 'items']});
    assert.deepStrictEqual(result.include, [
      {relation: 'customer'},
      {relation: 'items'},
    ]);
  });

  it('deduplicates repeated relations', () => {
    const result = parse({'$expand': 'customer,customer'});
    assert.deepStrictEqual(result.include, [
      {relation: 'customer'},
    ]);
  });

  it('returns undefined include when expand missing', () => {
    const result = parse({});
    assert.equal(result.include, undefined);
    assert.equal(result.inlineCount, undefined);
  });

  it('throws for unknown relation names', () => {
    assert.throws(
      () => parse({'$expand': 'unknown'}),
      /Unknown expand relation: unknown/,
    );
  });

  it('parses expand options with $select', () => {
    const result = parse({'$expand': 'customer($select=id,name)'});
    assert.deepStrictEqual(result.include, [
      {
        relation: 'customer',
        scope: {
          fields: {id: true, name: true},
        },
      },
    ]);
  });

  it('parses nested expand options recursively', () => {
    const result = parse({'$expand': 'items($expand=product($select=id))'});
    assert.deepStrictEqual(result.include, [
      {
        relation: 'items',
        scope: {
          include: [
            {
              relation: 'product',
              scope: {
                fields: {id: true},
              },
            },
          ],
        },
      },
    ]);
  });

  it('supports slash-separated navigation paths', () => {
    const result = parse({'$expand': 'items/product($select=id)'});
    assert.deepStrictEqual(result.include, [
      {
        relation: 'items',
        scope: {
          include: [
            {
              relation: 'product',
              scope: {
                fields: {id: true},
              },
            },
          ],
        },
      },
    ]);
  });

  it('throws for unsupported options', () => {
    assert.throws(
      () => parse({'$expand': 'customer($levels=2)'}),
      /Unsupported expand option/,
    );
  });

  it('parses $count=true into inlineCount flag', () => {
    const result = parse({'$count': 'true'});
    assert.equal(result.inlineCount, true);
  });
});

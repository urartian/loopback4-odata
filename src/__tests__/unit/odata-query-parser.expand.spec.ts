/// <reference path="../../types/testing.globals.d.ts" />

import {strict as assert} from 'assert';
import {RelationDefinitionMap} from '@loopback/repository';
import {parseODataQuery} from '../../services/odata-query-parser.service';

const relations = {
  customer: {name: 'customer'},
  items: {name: 'items'},
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

  it('parses $count=true into inlineCount flag', () => {
    const result = parse({'$count': 'true'});
    assert.equal(result.inlineCount, true);
  });
});

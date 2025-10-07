/// <reference path="../../types/testing.globals.d.ts" />

import {strict as assert} from 'assert';
import {parseODataQuery} from '../../services/odata-query-parser.service';

describe('parseODataQuery string functions', () => {
  it('translates contains() into like with wildcards', () => {
    const parsed = parseODataQuery({
      '$filter': "contains(name,'Lap')",
    });
    assert.deepStrictEqual(parsed.where, {
      name: {like: '%Lap%', escape: '\\', options: 'i'},
    });
  });

  it('parses contains with tolower wrappers', () => {
    const parsed = parseODataQuery({
      '$filter': "contains(tolower(title),tolower('Lap'))",
    });
    assert.deepStrictEqual(parsed.where, {
      title: {like: '%lap%', escape: '\\', options: 'i'},
    });
  });

  it('translates startswith() into like suffix wildcard', () => {
    const parsed = parseODataQuery({
      '$filter': "startswith(code,'PR-')",
    });
    assert.deepStrictEqual(parsed.where, {
      code: {like: 'PR-%', escape: '\\', options: 'i'},
    });
  });

  it('translates endswith() into like prefix wildcard', () => {
    const parsed = parseODataQuery({
      '$filter': "endswith(description,'X')",
    });
    assert.deepStrictEqual(parsed.where, {
      description: {like: '%X', escape: '\\', options: 'i'},
    });
  });

  it('rejects non-string function arguments', () => {
    assert.throws(() =>
      parseODataQuery({
        '$filter': "contains(name,123)",
      }),
      /requires a string literal argument/i,
    );
  });
});

describe('parseODataQuery extended filter grammar', () => {
  it('supports NOT on comparisons', () => {
    const parsed = parseODataQuery({
      '$filter': 'not price gt 100',
    });
    // not (price gt 100) => price lte 100
    assert.deepStrictEqual(parsed.where, {price: {lte: 100}});
  });

  it('translates round(field) eq N into range', () => {
    const parsed = parseODataQuery({
      '$filter': 'round(price) eq 10',
    });
    assert.deepStrictEqual(parsed.where, {
      and: [
        {price: {gte: 9.5}},
        {price: {lt: 10.5}},
      ],
    });
  });

  it('translates floor(field) eq N into [N, N+1)', () => {
    const parsed = parseODataQuery({
      '$filter': 'floor(price) eq 3',
    });
    assert.deepStrictEqual(parsed.where, {
      and: [
        {price: {gte: 3}},
        {price: {lt: 4}},
      ],
    });
  });

  it('translates ceiling(field) eq N into (N-1, N]', () => {
    const parsed = parseODataQuery({
      '$filter': 'ceiling(price) eq 5',
    });
    assert.deepStrictEqual(parsed.where, {
      and: [
        {price: {gt: 4}},
        {price: {le: 5}},
      ],
    });
  });

  it('supports year(date) eq Y via range', () => {
    const parsed = parseODataQuery({
      '$filter': 'year(updatedAt) eq 2020',
    });
    const where = parsed.where as any;
    // Verify structure without depending on exact Date serialization
    const and = where.and;
    assert.equal(Array.isArray(and), true);
    assert.equal(and.length, 2);
    assert.deepStrictEqual(Object.keys(and[0]), ['updatedAt']);
    assert.deepStrictEqual(Object.keys(and[1]), ['updatedAt']);
  });

  it('supports not contains() via nlike', () => {
    const parsed = parseODataQuery({
      '$filter': "not contains(name,'Lap')",
    });
    assert.deepStrictEqual(parsed.where, {
      name: {nlike: '%Lap%', escape: '\\', options: 'i'},
    });
  });
});

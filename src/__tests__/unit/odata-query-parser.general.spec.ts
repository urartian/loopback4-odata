/// <reference path="../../types/testing.globals.d.ts" />

import {strict as assert} from 'assert';
import {parseODataQuery} from '../../services/odata-query-parser.service';

describe('parseODataQuery basics', () => {
  it('maps comparison operators and logical AND/OR', () => {
    const result = parseODataQuery({
      '$filter': "price gt 100 and price lt 500 or name eq 'Laptop'",
    });

    assert.deepStrictEqual(result.where, {
      or: [
        {
          and: [
            {price: {gt: 100}},
            {price: {lt: 500}},
          ],
        },
        {name: 'Laptop'},
      ],
    });
  });

  it('parses grouped contains filters with additional predicates', () => {
    const result = parseODataQuery({
      '$filter': "(contains(tolower(title),tolower('test')) or contains(tolower(descr),tolower('test'))) and genreId eq 'abc'",
    });

    assert.deepStrictEqual(result.where, {
      and: [
        {
          or: [
            {title: {like: '%test%', escape: '\\', options: 'i'}},
            {descr: {like: '%test%', escape: '\\', options: 'i'}},
          ],
        },
        {genreId: 'abc'},
      ],
    });
  });

  it('parses $orderby, $top, $skip, and $select', () => {
    const query = parseODataQuery({
      '$orderby': 'price desc,name asc',
      '$top': '10',
      '$skip': '5',
      '$select': 'id,name,price',
    });

    assert.deepStrictEqual(query.order, ['price DESC', 'name ASC']);
    assert.equal(query.limit, 10);
    assert.equal(query.offset, 5);
    assert.deepStrictEqual(query.fields, {id: true, name: true, price: true});
  });

  it('rejects unsupported comparators', () => {
    assert.throws(
      () => parseODataQuery({'$filter': 'price like 100'}),
      /Unsupported comparator/i,
    );
  });
});

/// <reference path="../../types/testing.globals.d.ts" />

import {strict as assert} from 'assert';
import {parseODataQuery} from '../../services/odata-query-parser.service';

describe('parseODataQuery string functions', () => {
  it('translates contains() into like with wildcards', () => {
    const parsed = parseODataQuery({
      '$filter': "contains(name,'Lap')",
    });
    assert.deepStrictEqual(parsed.where, {
      name: {like: '%Lap%', escape: '\\'},
    });
  });

  it('parses contains with tolower wrappers', () => {
    const parsed = parseODataQuery({
      '$filter': "contains(tolower(title),tolower('Lap'))",
    });
    assert.deepStrictEqual(parsed.where, {
      title: {like: '%lap%', escape: '\\'},
    });
  });

  it('translates startswith() into like suffix wildcard', () => {
    const parsed = parseODataQuery({
      '$filter': "startswith(code,'PR-')",
    });
    assert.deepStrictEqual(parsed.where, {
      code: {like: 'PR-%', escape: '\\'},
    });
  });

  it('translates endswith() into like prefix wildcard', () => {
    const parsed = parseODataQuery({
      '$filter': "endswith(description,'X')",
    });
    assert.deepStrictEqual(parsed.where, {
      description: {like: '%X', escape: '\\'},
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

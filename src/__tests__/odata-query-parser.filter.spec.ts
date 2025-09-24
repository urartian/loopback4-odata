import {strict as assert} from 'assert';
import {parseODataQuery} from '../services/odata-query-parser.service';

(async () => {
  const parsed = parseODataQuery({
    '$filter': "contains(name,'Lap')",
  });
  assert.deepStrictEqual(parsed.where, {
    name: {like: '%Lap%', escape: '\\'},
  });
})();

(async () => {
  const parsed = parseODataQuery({
    '$filter': "startswith(code,'PR-')",
  });
  assert.deepStrictEqual(parsed.where, {
    code: {like: 'PR-%', escape: '\\'},
  });
})();

(async () => {
  const parsed = parseODataQuery({
    '$filter': "endswith(description,'X')",
  });
  assert.deepStrictEqual(parsed.where, {
    description: {like: '%X', escape: '\\'},
  });
})();

(async () => {
  assert.throws(() =>
    parseODataQuery({
      '$filter': "contains(name,123)",
    }),
    /requires a string literal argument/i,
  );
})();

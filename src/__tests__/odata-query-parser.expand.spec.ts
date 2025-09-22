import {strict as assert} from 'assert';
import {RelationDefinitionMap} from '@loopback/repository';
import {parseODataQuery} from '../services/odata-query-parser.service';

const relations = {
  customer: {name: 'customer'},
  items: {name: 'items'},
} as unknown as RelationDefinitionMap;

const parse = (query: Record<string, unknown>) =>
  parseODataQuery(query as Record<string, string | string[] | undefined>, {relations});

(() => {
  const result = parse({'$expand': 'customer, items'});

  assert.deepStrictEqual(result.include, [
    {relation: 'customer'},
    {relation: 'items'},
  ]);
})();

(() => {
  const result = parse({'$expand': ['customer', 'items']});

  assert.deepStrictEqual(result.include, [
    {relation: 'customer'},
    {relation: 'items'},
  ]);
})();

(() => {
  const result = parse({'$expand': 'customer,customer'});

  assert.deepStrictEqual(result.include, [
    {relation: 'customer'},
  ]);
})();

(() => {
  const result = parse({});
  assert.equal(result.include, undefined);
  assert.equal(result.inlineCount, undefined);
})();

(() => {
  assert.throws(
    () => parse({'$expand': 'unknown'}),
    /Unknown expand relation: unknown/,
  );
})();

(() => {
  const result = parse({'$count': 'true'});
  assert.equal(result.inlineCount, true);
})();

console.log('All OData parser tests passed');

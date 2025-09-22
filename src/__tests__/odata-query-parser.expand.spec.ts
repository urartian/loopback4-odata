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
  const filter = parse({'$expand': 'customer, items'});

  assert.deepStrictEqual(filter.include, [
    {relation: 'customer'},
    {relation: 'items'},
  ]);
})();

(() => {
  const filter = parse({'$expand': ['customer', 'items']});

  assert.deepStrictEqual(filter.include, [
    {relation: 'customer'},
    {relation: 'items'},
  ]);
})();

(() => {
  const filter = parse({'$expand': 'customer,customer'});

  assert.deepStrictEqual(filter.include, [
    {relation: 'customer'},
  ]);
})();

(() => {
  const filter = parse({});
  assert.equal(filter.include, undefined);
})();

(() => {
  assert.throws(
    () => parse({'$expand': 'unknown'}),
    /Unknown expand relation: unknown/,
  );
})();

console.log('All $expand parser tests passed');

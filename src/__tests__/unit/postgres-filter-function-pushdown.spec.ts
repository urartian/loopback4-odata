/// <reference path="../../types/testing.globals.d.ts" />

import 'reflect-metadata';
import { strict as assert } from 'assert';
import { Entity, juggler, model, property } from '@loopback/repository';
import {
  buildPostgresFilterCountQuery,
  buildPostgresFilterIdQuery,
  supportsPostgresLambdaPushdown,
} from '../../util/postgres-lambda-pushdown';
import { ParsedExpression } from '../../services/odata-query-parser.service';

describe('Postgres $filter function pushdown', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;

    @property({ type: 'string' })
    name!: string;

    @property({ type: Date })
    createdAt!: Date;
  }

  function stubPostgresDataSource(): juggler.DataSource {
    return {
      connector: {
        name: 'postgresql',
        table: (modelName: string) => modelName,
        column: (_modelName: string, propertyName: string) => propertyName,
      },
      execute: async () => [],
    } as unknown as juggler.DataSource;
  }

  it('detects Postgres support from connector settings and execute capability', () => {
    assert.equal(
      supportsPostgresLambdaPushdown({
        connector: {settings: {name: 'postgresql'}},
        execute: async () => [],
      } as unknown as juggler.DataSource),
      true,
    );

    assert.equal(
      supportsPostgresLambdaPushdown({
        connector: {name: 'postgresql'},
      } as unknown as juggler.DataSource),
      false,
    );
  });

  it('builds SQL for trim(...) comparisons', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'stringfncmp',
      name: 'trim',
      args: [{ kind: 'field', name: 'name' }],
      comparator: 'eq',
      value: 'x',
    };

    const result = buildPostgresFilterIdQuery({
      dataSource,
      modelCtor: Widget,
      expression: expr,
      where: undefined,
      order: ['id ASC'],
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /btrim\(/i);
    assert.match(result.sql, /btrim\(\s*r\./i);
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], 'x');
  });

  it('builds SQL for concat(...) comparisons', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'stringfncmp',
      name: 'concat',
      args: [
        { kind: 'field', name: 'name' },
        { kind: 'literal', value: '!' },
      ],
      comparator: 'eq',
      value: 'x!',
    };

    const result = buildPostgresFilterIdQuery({
      dataSource,
      modelCtor: Widget,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /concat\(/i);
    assert.equal(result.params.length, 2);
    assert.equal(result.params[0], '!');
    assert.equal(result.params[1], 'x!');
  });

  it('builds SQL for month(...) comparisons using UTC semantics', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'datepart',
      part: 'month',
      field: 'createdAt',
      comparator: 'eq',
      value: 1,
    };

    const result = buildPostgresFilterCountQuery({
      dataSource,
      modelCtor: Widget,
      expression: expr,
      where: undefined,
    });

    assert('sql' in result);
    assert.match(result.sql, /EXTRACT\s*\(\s*MONTH\s+FROM\s+timezone\('UTC'/i);
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], 1);
  });

  it('builds SQL for tolower(field) eq value comparisons', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'transformcmp',
      transform: 'tolower',
      field: 'name',
      comparator: 'eq',
      value: 'x',
    };

    const result = buildPostgresFilterIdQuery({
      dataSource,
      modelCtor: Widget,
      expression: expr,
      where: undefined,
      order: ['id ASC'],
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /LOWER\s*\(\s*r\."name"\s*\)\s*=\s*\$1/i);
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], 'x');
  });

  it('builds SQL for toupper(field) ne null comparisons', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'transformcmp',
      transform: 'toupper',
      field: 'name',
      comparator: 'neq',
      value: null,
    };

    const result = buildPostgresFilterCountQuery({
      dataSource,
      modelCtor: Widget,
      expression: expr,
      where: undefined,
    });

    assert('sql' in result);
    assert.match(result.sql, /UPPER\s*\(\s*r\."name"\s*\)\s+IS\s+NOT\s+NULL/i);
    assert.equal(result.params.length, 0);
  });

  it('declines non-Postgres datasources and unsupported root where clauses', () => {
    const expr: ParsedExpression = {
      operator: 'transformcmp',
      transform: 'tolower',
      field: 'name',
      comparator: 'eq',
      value: 'x',
    };

    const nonPostgres = buildPostgresFilterIdQuery({
      dataSource: {
        connector: {name: 'memory'},
        execute: async () => [],
      } as unknown as juggler.DataSource,
      modelCtor: Widget,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(nonPostgres, {declineReason: 'non-postgres'});

    const unsupportedWhere = buildPostgresFilterCountQuery({
      dataSource: stubPostgresDataSource(),
      modelCtor: Widget,
      expression: expr,
      where: {name: {regexp: 'x'}} as any,
    });
    assert.deepEqual(unsupportedWhere, {declineReason: 'unsupported-root-where'});
  });

  it('declines unsupported ordering and composite identifiers', () => {
    @model()
    class CompositeWidget extends Entity {
      @property({id: true, type: 'number'})
      id!: number;

      @property({id: true, type: 'string'})
      region!: string;

      @property({type: 'string'})
      name!: string;
    }

    const expr: ParsedExpression = {
      operator: 'transformcmp',
      transform: 'tolower',
      field: 'name',
      comparator: 'eq',
      value: 'x',
    };

    const unsupportedOrder = buildPostgresFilterIdQuery({
      dataSource: stubPostgresDataSource(),
      modelCtor: Widget,
      expression: expr,
      where: undefined,
      order: ['name SIDEWAYS'],
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(unsupportedOrder, {declineReason: 'unsupported-order'});

    const compositeId = buildPostgresFilterIdQuery({
      dataSource: stubPostgresDataSource(),
      modelCtor: CompositeWidget,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(compositeId, {declineReason: 'composite-or-missing-id'});
  });
});

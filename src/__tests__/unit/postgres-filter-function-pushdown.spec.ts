/// <reference path="../../types/testing.globals.d.ts" />

import 'reflect-metadata';
import { strict as assert } from 'assert';
import { Entity, juggler, model, property } from '@loopback/repository';
import {
  buildPostgresFilterCountQuery,
  buildPostgresFilterIdQuery,
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
});

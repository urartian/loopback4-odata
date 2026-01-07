/// <reference path="../../types/testing.globals.d.ts" />

import 'reflect-metadata';
import { strict as assert } from 'assert';
import { belongsTo, Entity, juggler, model, property } from '@loopback/repository';
import {
  buildPostgresMixedFilterCountQuery,
  buildPostgresMixedFilterIdQuery,
} from '../../util/postgres-filter-pushdown';
import { ParsedExpression } from '../../services/odata-query-parser.service';
import { OrderItem } from '../../../examples/basic-app';

describe('Postgres mixed $filter pushdown', () => {
  @model()
  class Customer extends Entity {
    @property({ id: true })
    id!: number;

    @property({ type: 'string' })
    name!: string;
  }

  @model()
  class Purchase extends Entity {
    @property({ id: true })
    id!: number;

    @property({ type: 'string' })
    status!: string;

    @belongsTo(() => Customer, { name: 'customer' })
    customerId!: number;
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

  it('builds SQL for mixed OR root+navigation predicates', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'logical',
      type: 'or',
      expressions: [
        { operator: 'comparison', field: 'status', comparator: 'eq', value: 'Open' },
        { operator: 'comparison', field: 'customer/name', comparator: 'eq', value: 'Alice' },
      ],
    };

    const ids = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: expr,
      where: undefined,
      order: ['id ASC'],
      limit: 10,
      offset: 0,
    });
    assert('sql' in ids);
    assert.match(ids.sql, /\bWHERE\b/i);
    assert.match(ids.sql, /\bOR\b/i);
    assert.match(ids.sql, /\bEXISTS\s*\(SELECT 1 FROM/i);
    assert.equal(ids.params.length, 2);
    assert.equal(ids.params[0], 'Open');
    assert.equal(ids.params[1], 'Alice');

    const count = buildPostgresMixedFilterCountQuery({
      dataSource,
      modelCtor: Purchase,
      expression: expr,
      where: undefined,
    });
    assert('sql' in count);
    assert.match(count.sql, /COUNT\(\*\)/i);
    assert.equal(count.params.length, 2);
  });

  it('declines when combined join-count exceeds maxJoinCount', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'logical',
      type: 'and',
      expressions: [
        { operator: 'comparison', field: 'order/total', comparator: 'gt', value: 0 },
        {
          operator: 'function',
          name: 'contains',
          field: 'product/name',
          args: ['Widget'],
          caseInsensitive: true,
        } as any,
      ],
    };

    const result = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: OrderItem,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
      maxJoinCount: 1,
    });

    assert('declineReason' in result);
    assert.equal((result as any).declineReason, 'pushdown-join-count-exceeded');
  });

  it('does not double-count joins when multiple leaves share the same nav chain', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'logical',
      type: 'and',
      expressions: [
        { operator: 'comparison', field: 'customer/name', comparator: 'eq', value: 'Alice' },
        { operator: 'comparison', field: 'customer/name', comparator: 'neq', value: 'Bob' },
      ],
    };

    const result = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
      maxJoinCount: 1,
    });

    assert('sql' in result);
    assert.match(result.sql, /\bEXISTS\s*\(SELECT 1 FROM/i);
  });

  it('supports NOT and nested boolean trees', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'not',
      expr: {
        operator: 'logical',
        type: 'or',
        expressions: [
          { operator: 'comparison', field: 'status', comparator: 'eq', value: 'Open' },
          { operator: 'comparison', field: 'customer/name', comparator: 'eq', value: 'Alice' },
        ],
      },
    };

    const result = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: expr,
      where: undefined,
      order: ['id ASC'],
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /\bNOT\s*\(/i);
    assert.match(result.sql, /\bOR\b/i);
  });

  it('pushes down nav contains(...) with ILIKE + ESCAPE', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'function',
      name: 'contains',
      field: 'customer/name',
      args: ['ali'],
      caseInsensitive: true,
    };

    const result = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /\bEXISTS\s*\(SELECT 1 FROM/i);
    assert.match(result.sql, /\bILIKE\b/i);
    assert.ok(result.sql.includes("ESCAPE E'\\\\'"));
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], '%ali%');
  });

  it('translates root where inq/nin with null using IS NULL/IS NOT NULL', () => {
    const dataSource = stubPostgresDataSource();

    const inq = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: { operator: 'comparison', field: 'status', comparator: 'eq', value: 'Open' },
      where: { status: { inq: ['Open', null] } },
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in inq);
    assert.ok(inq.sql.includes('IS NULL'));
    assert.match(inq.sql, /\bIN\s*\(/i);
    assert.match(inq.sql, /\bOR\b/i);

    const nin = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: { operator: 'comparison', field: 'status', comparator: 'eq', value: 'Open' },
      where: { status: { nin: ['Open', null] } },
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in nin);
    assert.ok(nin.sql.includes('IS NOT NULL'));
    assert.match(nin.sql, /\bNOT IN\s*\(/i);
    assert.match(nin.sql, /\bAND\b/i);
  });

  it("treats where options:'i' strictly (does not accept arbitrary strings containing i)", () => {
    const dataSource = stubPostgresDataSource();

    const insensitive = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Customer,
      expression: { operator: 'comparison', field: 'id', comparator: 'eq', value: 1 },
      where: { name: { like: '%foo%', options: 'i' } },
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in insensitive);
    assert.match(insensitive.sql, /\bILIKE\b/i);

    const notInsensitive = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Customer,
      expression: { operator: 'comparison', field: 'id', comparator: 'eq', value: 1 },
      where: { name: { like: '%foo%', options: 'nilike' } },
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in notInsensitive);
    assert.match(notInsensitive.sql, /\bLIKE\b/i);
    assert.doesNotMatch(notInsensitive.sql, /\bILIKE\b/i);
  });

  it('pushes down length() comparisons using LIKE patterns (repo-compatible semantics)', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'lengthcmp',
      field: 'status',
      comparator: 'gte',
      value: 2,
    };

    const result = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /\bLIKE\b/i);
    assert.ok(result.sql.includes("ESCAPE E'\\\\'"));
    assert.equal(result.params[0], '__%');
  });

  it('declines unsupported root where and unsupported order', () => {
    const dataSource = stubPostgresDataSource();

    const unsupportedWhere = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: { operator: 'comparison', field: 'status', comparator: 'eq', value: 'Open' },
      where: { status: { regexp: 'Open' } } as any,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('declineReason' in unsupportedWhere);
    assert.equal((unsupportedWhere as any).declineReason, 'unsupported-root-where');

    const unsupportedOrder = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: { operator: 'comparison', field: 'status', comparator: 'eq', value: 'Open' },
      where: undefined,
      order: ['customer/name ASC'],
      limit: 10,
      offset: 0,
    });
    assert('declineReason' in unsupportedOrder);
    assert.equal((unsupportedOrder as any).declineReason, 'unsupported-order');
  });
});

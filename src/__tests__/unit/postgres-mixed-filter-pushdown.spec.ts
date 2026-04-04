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

  @model()
  class CompositePurchase extends Entity {
    @property({id: true})
    id!: number;

    @property({id: true, type: 'string'})
    region!: string;

    @property({type: 'string'})
    status!: string;
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

  it('pushes down root startswith/endswith variants with transform and negation', () => {
    const dataSource = stubPostgresDataSource();

    const startsWith = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: {
        operator: 'function',
        name: 'startswith',
        field: 'status',
        args: ['Op'],
        transform: 'tolower',
      } as any,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in startsWith);
    assert.match(startsWith.sql, /LOWER\(r\."status"\)\s+LIKE/i);
    assert.equal(startsWith.params[0], 'Op%');

    const endsWithNegated = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: {
        operator: 'function',
        name: 'endswith',
        field: 'status',
        args: ['ed'],
        negated: true,
      } as any,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in endsWithNegated);
    assert.match(endsWithNegated.sql, /\bNOT LIKE\b/i);
    assert.equal(endsWithNegated.params[0], '%ed');
  });

  it('pushes down transformed null comparisons on root fields', () => {
    const dataSource = stubPostgresDataSource();
    const result = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: {
        operator: 'transformcmp',
        transform: 'toupper',
        field: 'status',
        comparator: 'eq',
        value: null,
      },
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /UPPER\(r\."status"\)\s+IS\s+NULL/i);
    assert.equal(result.params.length, 0);
  });

  it('pushes down root datepart, indexof, and substring comparisons', () => {
    @model()
    class TimedPurchase extends Entity {
      @property({id: true})
      id!: number;

      @property({type: Date})
      createdAt!: Date;

      @property({type: 'string'})
      status!: string;
    }

    const dataSource = stubPostgresDataSource();

    const datepart = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: TimedPurchase,
      expression: {
        operator: 'datepart',
        part: 'month',
        field: 'createdAt',
        comparator: 'gte',
        value: 4,
      },
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in datepart);
    assert.match(datepart.sql, /EXTRACT\(MONTH FROM timezone\('UTC', r\."createdAt"\)\)\s+>=/i);
    assert.equal(datepart.params[0], 4);

    const indexOf = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: TimedPurchase,
      expression: {
        operator: 'indexofcmp',
        field: 'status',
        needle: 'pen',
        comparator: 'eq',
        value: -1,
      } as any,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in indexOf);
    assert.match(indexOf.sql, /\bNOT ILIKE\b/i);
    assert.equal(indexOf.params[0], '%pen%');

    const substring = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: TimedPurchase,
      expression: {
        operator: 'substrcmp',
        field: 'status',
        start: 2,
        literal: 'en',
        comparator: 'neq',
      } as any,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in substring);
    assert.match(substring.sql, /\bNOT LIKE\b/i);
    assert.equal(substring.params[0], '__en');
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

  it('covers root length edge cases for zero and upper bounds', () => {
    const dataSource = stubPostgresDataSource();

    const equalsZero = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: {
        operator: 'lengthcmp',
        field: 'status',
        comparator: 'eq',
        value: 0,
      },
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in equalsZero);
    assert.match(equalsZero.sql, /r\."status"\s*=\s*\$1/i);
    assert.equal(equalsZero.params[0], '');

    const lte = buildPostgresMixedFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: {
        operator: 'lengthcmp',
        field: 'status',
        comparator: 'lte',
        value: 2,
      },
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert('sql' in lte);
    assert.match(lte.sql, /\bNOT LIKE\b/i);
    assert.equal(lte.params[0], '___%');
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

  it('declines non-Postgres datasources, composite ids, and unsupported lambda roots', () => {
    const nonPostgres = buildPostgresMixedFilterIdQuery({
      dataSource: {
        connector: {name: 'memory'},
        execute: async () => [],
      } as unknown as juggler.DataSource,
      modelCtor: Purchase,
      expression: {operator: 'comparison', field: 'status', comparator: 'eq', value: 'Open'},
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(nonPostgres, {declineReason: 'non-postgres'});

    const compositeId = buildPostgresMixedFilterIdQuery({
      dataSource: stubPostgresDataSource(),
      modelCtor: CompositePurchase,
      expression: {operator: 'comparison', field: 'status', comparator: 'eq', value: 'Open'},
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(compositeId, {declineReason: 'composite-or-missing-id'});

    const unsupportedLambda = buildPostgresMixedFilterCountQuery({
      dataSource: stubPostgresDataSource(),
      modelCtor: Purchase,
      expression: {
        operator: 'lambda',
        lambdaType: 'any',
        path: ['customer'],
        alias: 'c',
        predicate: {operator: 'comparison', field: 'c/name', comparator: 'eq', value: 'Alice'},
      } as any,
      where: undefined,
    });
    assert.deepEqual(unsupportedLambda, {declineReason: 'unsupported-filter'});
  });
});

/// <reference path="../../types/testing.globals.d.ts" />

import 'reflect-metadata';
import { strict as assert } from 'assert';
import { belongsTo, Entity, juggler, model, property } from '@loopback/repository';
import { OrderItem, Product } from '../../../examples/basic-app';
import {
  buildPostgresNavigationFilterCountQuery,
  buildPostgresNavigationFilterIdQuery,
} from '../../util/postgres-navigation-filter-pushdown';
import { ParsedExpression } from '../../services/odata-query-parser.service';

describe('Postgres navigation-property filter pushdown', () => {
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

  it('builds EXISTS SQL for to-one navigation property comparisons', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'comparison',
      field: 'order/total',
      comparator: 'eq',
      value: 1000,
    };

    const result = buildPostgresNavigationFilterIdQuery({
      dataSource,
      modelCtor: OrderItem,
      expression: expr,
      where: { quantity: { gt: 1 } } as any,
      order: ['id DESC'],
      limit: 20,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /EXISTS\s*\(SELECT 1 FROM/i);
    assert.match(result.sql, /\bWHERE\b/i);
    assert.match(result.sql, /\bORDER\s+BY\b/i);
    assert.equal(result.params.length, 2);
    assert.equal(result.params[0], 1);
    assert.equal(result.params[1], 1000);
  });

  it('splits null out of inq(...) navigation predicates', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'comparison',
      field: 'order/total',
      comparator: 'inq',
      value: [null, 1000],
    } as any;

    const result = buildPostgresNavigationFilterIdQuery({
      dataSource,
      modelCtor: OrderItem,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /\bIS\s+NULL\b/i);
    assert.match(result.sql, /\bIN\s*\(\$1\)/i);
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], 1000);
  });

  it('builds EXISTS SQL for to-one navigation tolower() comparisons', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'transformcmp',
      transform: 'tolower',
      field: 'product/name',
      comparator: 'eq',
      value: 'widget',
    };

    const result = buildPostgresNavigationFilterIdQuery({
      dataSource,
      modelCtor: OrderItem,
      expression: expr,
      where: { quantity: { gt: 1 } } as any,
      order: ['id ASC'],
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /EXISTS\s*\(SELECT 1 FROM/i);
    assert.match(result.sql, /LOWER\s*\(\s*t\d+\."name"\s*\)\s*=\s*\$2/i);
    assert.equal(result.params.length, 2);
    assert.equal(result.params[0], 1);
    assert.equal(result.params[1], 'widget');
  });

  it('declines when maxJoinCount is exceeded', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'logical',
      type: 'and',
      expressions: [
        { operator: 'comparison', field: 'order/total', comparator: 'gt', value: 0 },
        { operator: 'comparison', field: 'product/name', comparator: 'eq', value: 'Widget' },
      ],
    };

    const result = buildPostgresNavigationFilterIdQuery({
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
    assert.equal(result.declineReason, 'pushdown-join-count-exceeded');
  });

  it('declines when navigation path traverses a to-many relation', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'comparison',
      field: 'orderItems/unitPrice',
      comparator: 'gt',
      value: 10,
    };

    const result = buildPostgresNavigationFilterIdQuery({
      dataSource,
      modelCtor: Product,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('declineReason' in result);
    assert.equal(result.declineReason, 'unsupported-navigation-filter');
  });

  it('builds COUNT(*) SQL for navigation property predicates', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'comparison',
      field: 'order/total',
      comparator: 'gte',
      value: 900,
    };

    const result = buildPostgresNavigationFilterCountQuery({
      dataSource,
      modelCtor: OrderItem,
      expression: expr,
      where: undefined,
    });

    assert('sql' in result);
    assert.match(result.sql, /SELECT\s+COUNT\(\*\)\s+AS\s+count/i);
    assert.match(result.sql, /EXISTS\s*\(SELECT 1 FROM/i);
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], 900);
  });

  it('supports root where like/ilike with ESCAPE', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'comparison',
      field: 'customer/name',
      comparator: 'eq',
      value: 'Alice',
    };

    const result = buildPostgresNavigationFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: expr,
      where: { status: { like: '%foo\\_%', options: 'i' } } as any,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /\bILIKE\b/i);
    assert.match(result.sql, /ESCAPE\s+E'\\\\'/i);
    assert.equal(result.params[0], '%foo\\_%');
  });

  it('supports root where nlike', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'comparison',
      field: 'customer/name',
      comparator: 'eq',
      value: 'Alice',
    };

    const result = buildPostgresNavigationFilterIdQuery({
      dataSource,
      modelCtor: Purchase,
      expression: expr,
      where: { status: { nlike: '___%' } } as any,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /\bNOT\s+LIKE\b/i);
    assert.match(result.sql, /ESCAPE\s+E'\\\\'/i);
    assert.equal(result.params[0], '___%');
  });
});

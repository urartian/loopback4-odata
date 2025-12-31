/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { juggler } from '@loopback/repository';
import { Product } from '../../../examples/basic-app';
import { buildPostgresLambdaIdQuery } from '../../util/postgres-lambda-pushdown';
import { LambdaExpression } from '../../services/odata-query-parser.service';

describe('Postgres lambda pushdown', () => {
  function stubPostgresDataSource(): juggler.DataSource {
    const ds = {
      connector: {
        name: 'postgresql',
        table: (modelName: string) => modelName,
        column: (_modelName: string, propertyName: string) => propertyName,
      },
      execute: async () => [],
    } as unknown as juggler.DataSource;
    return ds;
  }

  it('builds EXISTS SQL for any(...)', () => {
    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['orderItems'],
      alias: 'i',
      predicate: { operator: 'comparison', field: 'i/unitPrice', comparator: 'gt', value: 800 },
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      lambdas: [lambda],
      where: { price: { gt: 1000 } } as any,
      order: ['price DESC'],
      limit: 50,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /EXISTS\s*\(SELECT 1 FROM/i);
    assert.match(result.sql, /WHERE/i);
    assert.equal(result.params.length, 2);
    assert.equal(result.params[0], 1000);
    assert.equal(result.params[1], 800);
  });

  it('builds NOT EXISTS SQL for all(...)', () => {
    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'all',
      path: ['orderItems'],
      alias: 'i',
      predicate: { operator: 'comparison', field: 'i/unitPrice', comparator: 'gt', value: 800 },
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      lambdas: [lambda],
      where: undefined,
      order: undefined,
      limit: 50,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /NOT EXISTS\s*\(SELECT 1 FROM/i);
    assert.match(result.sql, /IS NOT TRUE/i);
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], 800);
  });

  it('combines multiple lambdas with AND', () => {
    const dataSource = stubPostgresDataSource();
    const lambdas: LambdaExpression[] = [
      {
        type: 'any',
        path: ['orderItems'],
        alias: 'i',
        predicate: { operator: 'comparison', field: 'i/unitPrice', comparator: 'gt', value: 800 },
      },
      {
        type: 'any',
        path: ['orderItems'],
        alias: 'j',
        predicate: { operator: 'comparison', field: 'j/unitPrice', comparator: 'lt', value: 900 },
      },
    ];

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      lambdas,
      where: undefined,
      order: undefined,
      limit: 50,
      offset: 0,
    });

    assert('sql' in result);
    assert.equal(result.params.length, 2);
    assert.match(result.sql, /\)\s+AND\s+\(/i);
  });

  it('declines hasManyThrough paths', () => {
    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['orders'],
      alias: 'o',
      predicate: { operator: 'comparison', field: 'o/id', comparator: 'gt', value: 0 },
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      lambdas: [lambda],
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('declineReason' in result);
    assert.equal(result.declineReason, 'unsupported-lambda');
  });

  it('declines when root OR contains an unsupported clause', () => {
    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['orderItems'],
      alias: 'i',
      predicate: { operator: 'comparison', field: 'i/unitPrice', comparator: 'gt', value: 800 },
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      lambdas: [lambda],
      where: {
        or: [{ price: { gt: 1000 } }, { price: { regexp: 'x' } as any }],
      } as any,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('declineReason' in result);
    assert.equal(result.declineReason, 'unsupported-root-where');
  });

  it('declines when lambda OR contains an unsupported predicate branch', () => {
    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['orderItems'],
      alias: 'i',
      predicate: {
        operator: 'logical',
        type: 'or',
        expressions: [
          { operator: 'comparison', field: 'i/unitPrice', comparator: 'gt', value: 800 },
          { operator: 'stringfncmp', name: 'trim', args: [], comparator: 'eq', value: 'x' } as any,
        ],
      },
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      lambdas: [lambda],
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('declineReason' in result);
    assert.equal(result.declineReason, 'unsupported-lambda');
  });

  it('declines unknown lambda string functions', () => {
    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['orderItems'],
      alias: 'i',
      predicate: {
        operator: 'function',
        name: 'unknown',
        field: 'i/text',
        args: ['x'],
        caseInsensitive: true,
      } as any,
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      lambdas: [lambda],
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('declineReason' in result);
    assert.equal(result.declineReason, 'unsupported-lambda');
  });
});

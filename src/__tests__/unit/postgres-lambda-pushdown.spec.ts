/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { juggler, model, property, hasMany, Entity } from '@loopback/repository';
import { Product } from '../../../examples/basic-app';
import {
  buildPostgresLambdaCountQuery,
  buildPostgresLambdaIdQuery,
} from '../../util/postgres-lambda-pushdown';
import { LambdaExpression, ParsedExpression } from '../../services/odata-query-parser.service';

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

  it('builds nested EXISTS SQL for nested any(...)', () => {
    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['orderItems'],
      alias: 'i',
      predicate: {
        operator: 'lambda',
        lambdaType: 'any',
        path: ['i', 'order', 'items'],
        alias: 'j',
        predicate: { operator: 'comparison', field: 'j/unitPrice', comparator: 'gt', value: 800 },
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

    assert('sql' in result);
    assert.match(result.sql, /EXISTS[\s\S]*EXISTS/i);
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], 800);
  });

  it('declines when maxJoinCount is exceeded', () => {
    const dataSource = stubPostgresDataSource();
    const nestedPredicate = (outerAlias: string, innerAlias: string) =>
      ({
        operator: 'lambda',
        lambdaType: 'any',
        path: [outerAlias, 'order', 'items'],
        alias: innerAlias,
        predicate: {
          operator: 'comparison',
          field: `${innerAlias}/unitPrice`,
          comparator: 'gt',
          value: 800,
        },
      }) as any;

    const lambdas: LambdaExpression[] = [
      { type: 'any', path: ['orderItems'], alias: 'i', predicate: nestedPredicate('i', 'j') },
      { type: 'any', path: ['orderItems'], alias: 'k', predicate: nestedPredicate('k', 'm') },
    ];

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      lambdas,
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
      maxJoinCount: 1,
    });

    assert('declineReason' in result);
    assert.equal(result.declineReason, 'pushdown-join-count-exceeded');
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

  it('builds OR SQL for top-level lambda expressions', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'logical',
      type: 'or',
      expressions: [
        {
          operator: 'lambda',
          lambdaType: 'any',
          path: ['orderItems'],
          alias: 'i',
          predicate: { operator: 'comparison', field: 'i/unitPrice', comparator: 'gt', value: 800 },
        } as any,
        { operator: 'comparison', field: 'price', comparator: 'gt', value: 1000 },
      ],
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: Product,
      expression: expr,
      where: undefined,
      order: undefined,
      limit: 50,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /\)\s+OR\s+\(/i);
    assert.equal(result.params.length, 2);
    assert.equal(result.params[0], 800);
    assert.equal(result.params[1], 1000);
  });

  it('builds COUNT(*) SQL for top-level lambda expressions', () => {
    const dataSource = stubPostgresDataSource();
    const expr: ParsedExpression = {
      operator: 'logical',
      type: 'or',
      expressions: [
        {
          operator: 'lambda',
          lambdaType: 'any',
          path: ['orderItems'],
          alias: 'i',
          predicate: { operator: 'comparison', field: 'i/unitPrice', comparator: 'gt', value: 800 },
        } as any,
        { operator: 'comparison', field: 'price', comparator: 'gt', value: 1000 },
      ],
    };

    const result = buildPostgresLambdaCountQuery({
      dataSource,
      modelCtor: Product,
      expression: expr,
      where: undefined,
    });

    assert('sql' in result);
    assert.match(result.sql, /SELECT\s+COUNT\(\*\)\s+AS\s+count/i);
    assert.doesNotMatch(result.sql, /\bORDER\s+BY\b/i);
    assert.equal(result.params.length, 2);
    assert.equal(result.params[0], 800);
    assert.equal(result.params[1], 1000);
  });

  it('builds EXISTS SQL for hasManyThrough any(...)', () => {
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

    assert('sql' in result);
    assert.match(result.sql, /EXISTS\s*\(SELECT 1 FROM/i);
    assert.match(result.sql, /\bJOIN\b/i);
  });

  it('declines incomplete through metadata', () => {
    @model()
    class BrokenTarget extends Entity {
      @property({ type: 'number', id: true })
      id!: number;
    }

    @model()
    class BrokenThrough extends Entity {
      @property({ type: 'number', id: true })
      id!: number;
    }

    @model()
    class BrokenSource extends Entity {
      @property({ type: 'number', id: true })
      id!: number;

      @hasMany(() => BrokenTarget, { through: { model: () => BrokenThrough } as any })
      targets?: BrokenTarget[];
    }

    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['targets'],
      alias: 't',
      predicate: { operator: 'comparison', field: 't/id', comparator: 'gt', value: 0 },
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: BrokenSource,
      lambdas: [lambda],
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('declineReason' in result);
    assert.equal(result.declineReason, 'through-relation-unsupported');
  });

  it('pushes down length(field) comparisons inside lambda predicates', () => {
    @model()
    class LengthChild extends Entity {
      @property({ type: 'number', id: true })
      id!: number;

      @property({ type: 'number' })
      lengthParentId!: number;

      @property({ type: 'string' })
      name!: string;
    }

    @model()
    class LengthParent extends Entity {
      @property({ type: 'number', id: true })
      id!: number;

      @hasMany(() => LengthChild)
      children?: LengthChild[];
    }

    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['children'],
      alias: 'c',
      predicate: { operator: 'lengthcmp', field: 'c/name', comparator: 'gt', value: 3 } as any,
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: LengthParent,
      lambdas: [lambda],
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /char_length/i);
    assert.equal(result.params.length, 1);
    assert.equal(result.params[0], 3);
  });

  it('pushes down LOWER/UPPER wrappers for lambda string functions', () => {
    @model()
    class FnChild extends Entity {
      @property({ type: 'number', id: true })
      id!: number;

      @property({ type: 'number' })
      fnParentId!: number;

      @property({ type: 'string' })
      name!: string;
    }

    @model()
    class FnParent extends Entity {
      @property({ type: 'number', id: true })
      id!: number;

      @hasMany(() => FnChild)
      children?: FnChild[];
    }

    const dataSource = stubPostgresDataSource();
    const lambda: LambdaExpression = {
      type: 'any',
      path: ['children'],
      alias: 'c',
      predicate: {
        operator: 'function',
        name: 'contains',
        field: 'c/name',
        args: ['acme'],
        caseInsensitive: true,
        transform: 'tolower',
      } as any,
    };

    const result = buildPostgresLambdaIdQuery({
      dataSource,
      modelCtor: FnParent,
      lambdas: [lambda],
      where: undefined,
      order: undefined,
      limit: 10,
      offset: 0,
    });

    assert('sql' in result);
    assert.match(result.sql, /LOWER\(/i);
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

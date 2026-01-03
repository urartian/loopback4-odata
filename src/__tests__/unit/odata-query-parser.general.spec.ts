/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { parseODataQuery, parseApplyPipeline } from '../../services/odata-query-parser.service';

describe('parseODataQuery basics', () => {
  it('maps comparison operators and logical AND/OR', () => {
    const result = parseODataQuery({
      $filter: "price gt 100 and price lt 500 or name eq 'Laptop'",
    });

    assert.deepStrictEqual(result.where, {
      or: [
        {
          and: [{ price: { gt: 100 } }, { price: { lt: 500 } }],
        },
        { name: 'Laptop' },
      ],
    });
  });

  it('parses grouped contains filters with additional predicates', () => {
    const result = parseODataQuery({
      $filter:
        "(contains(tolower(title),tolower('test')) or contains(tolower(descr),tolower('test'))) and genreId eq 'abc'",
    });

    assert.deepStrictEqual(result.where, {
      and: [
        {
          or: [
            { title: { like: '%test%', options: 'i' } },
            { descr: { like: '%test%', options: 'i' } },
          ],
        },
        { genreId: 'abc' },
      ],
    });
  });

  it('parses $orderby, $top, $skip, and $select', () => {
    const query = parseODataQuery({
      $orderby: 'price desc,name asc',
      $top: '10',
      $skip: '5',
      $select: 'id,name,price',
    });

    assert.deepStrictEqual(query.order, ['price DESC', 'name ASC']);
    assert.equal(query.limit, 10);
    assert.equal(query.offset, 5);
    assert.deepStrictEqual(query.fields, { id: true, name: true, price: true });
  });

  it('rejects unsupported comparators', () => {
    assert.throws(() => parseODataQuery({ $filter: 'price like 100' }), /Unsupported comparator/i);
  });

  it('treats null literals as null values', () => {
    const parsed = parseODataQuery({
      $filter: 'name eq null',
    });

    assert.deepStrictEqual(parsed.where, { name: null });
  });

  it('unescapes doubled quotes inside string literals', () => {
    const parsed = parseODataQuery({
      $filter: "name eq 'O''Brian'",
    });

    assert.deepStrictEqual(parsed.where, { name: "O'Brian" });
  });

  it('extracts lambda predicates combined with additional AND conditions', () => {
    const parsed = parseODataQuery({
      $filter: 'orderItems/any(i: i/unitPrice gt 800) and price gt 1000',
    });

    assert(parsed.lambdas);
    assert.equal(parsed.lambdas?.length, 1);
    assert.deepStrictEqual(parsed.lambdas?.[0]?.path, ['orderItems']);
    assert.deepStrictEqual(parsed.where, { price: { gt: 1000 } });
  });

  it('parses lambda expressions combined with OR predicates', () => {
    const parsed = parseODataQuery({
      $filter: 'orderItems/any(i: i/unitPrice gt 800) or price gt 1000',
    });

    assert(parsed.lambdaExpression);
    assert.equal(parsed.lambdaExpression?.operator, 'logical');
    assert.equal((parsed.lambdaExpression as any)?.type, 'or');
  });

  it('applies logical operator precedence (and > or)', () => {
    const parsed = parseODataQuery({
      $filter: 'a eq 1 or b eq 1 and c eq 1',
    });

    const expr = parsed.whereExpression;
    assert(expr);
    assert.equal(expr.operator, 'logical');
    if (expr.operator === 'logical') {
      assert.equal(expr.type, 'or');
      assert.equal(expr.expressions[1]?.operator, 'logical');
      const rhs = expr.expressions[1];
      if (rhs.operator === 'logical') {
        assert.equal(rhs.type, 'and');
      }
    }
  });

  it('applies logical operator precedence (not > and)', () => {
    const parsed = parseODataQuery({
      $filter: 'not a eq 1 and b eq 1',
    });

    const expr = parsed.whereExpression;
    assert(expr);
    assert.equal(expr.operator, 'logical');
    if (expr.operator === 'logical') {
      assert.equal(expr.type, 'and');
      assert.equal(expr.expressions[0]?.operator, 'not');
    }
  });

  it('parses lambda aliases without whitespace after ":"', () => {
    const parsed = parseODataQuery({
      $filter: 'orderItems/any(i:i/unitPrice gt 800)',
    });

    assert(parsed.lambdas);
    assert.equal(parsed.lambdas?.[0]?.alias, 'i');
  });

  it('retains tolower/toupper wrappers inside lambda string functions', () => {
    const parsed = parseODataQuery({
      $filter: "notes/any(n: contains(tolower(n/text),'acme'))",
    });

    assert(parsed.lambdas);
    assert.equal(parsed.lambdas?.length, 1);
    const lambda = parsed.lambdas?.[0];
    assert(lambda);
    assert.equal(lambda.predicate.operator, 'function');
    if (lambda.predicate.operator === 'function') {
      assert.equal((lambda.predicate as any).transform, 'tolower');
    }
  });

  it('supports multiple lambda expressions combined with AND', () => {
    const parsed = parseODataQuery({
      $filter: 'orderItems/any(i: i/unitPrice gt 800) and orderItems/any(i: i/unitPrice lt 900)',
    });

    assert(parsed.lambdas);
    assert.equal(parsed.lambdas?.length, 2);
    assert.equal(parsed.where, undefined);
  });

  it('supports multiple lambdas with non-lambda predicates', () => {
    const parsed = parseODataQuery({
      $filter:
        "orderItems/any(i: i/unitPrice gt 800) and notes/any(n: contains(n/text,'urgent')) and price gt 1000",
    });

    assert(parsed.lambdas);
    assert.equal(parsed.lambdas?.length, 2);
    assert.deepStrictEqual(parsed.where, { price: { gt: 1000 } });
  });

  it('rewrites negated any(...) to all(not ...)', () => {
    const parsed = parseODataQuery({
      $filter: 'not orderItems/any(i: i/unitPrice gt 800)',
    });

    assert(parsed.lambdas);
    assert.equal(parsed.lambdas?.length, 1);
    const lambda = parsed.lambdas?.[0];
    assert(lambda);
    assert.equal(lambda.type, 'all');
    assert.equal(lambda.alias, 'i');
    assert.equal(lambda.predicate.operator, 'not');
  });

  it('rewrites negated all(...) to any(not ...)', () => {
    const parsed = parseODataQuery({
      $filter: 'not orderItems/all(i: i/unitPrice gt 800)',
    });

    assert(parsed.lambdas);
    assert.equal(parsed.lambdas?.length, 1);
    const lambda = parsed.lambdas?.[0];
    assert(lambda);
    assert.equal(lambda.type, 'any');
    assert.equal(lambda.alias, 'i');
    assert.equal(lambda.predicate.operator, 'not');
  });

  it('parses nested lambdas (depth 2)', () => {
    const parsed = parseODataQuery({
      $filter: 'orderItems/any(i: i/subItems/any(s: s/id eq 1))',
    });

    assert(parsed.lambdas);
    assert.equal(parsed.lambdas?.length, 1);
    const outer = parsed.lambdas?.[0];
    assert(outer);
    assert.equal(outer.type, 'any');
    assert.equal(outer.predicate.operator, 'lambda');
    if (outer.predicate.operator === 'lambda') {
      assert.equal(outer.predicate.lambdaType, 'any');
      assert.deepStrictEqual(outer.predicate.path, ['i', 'subItems']);
      assert.equal(outer.predicate.alias, 's');
    }
  });

  it('rejects nested lambdas above the configured depth cap', () => {
    assert.throws(
      () =>
        parseODataQuery({
          $filter: 'a/any(o: o/b/any(i: i/c/all(j: j/id eq 1)))',
        }),
      /nested-lambda-depth-exceeded/i,
    );
  });

  it('rejects unprefixed fields inside lambda predicates', () => {
    assert.throws(
      () =>
        parseODataQuery({
          $filter: 'orderItems/any(i: unitPrice gt 800)',
        }),
      /lambda-alias-prefix-required/i,
    );
  });

  it('attaches simple $apply pipelines to the parsed query', () => {
    const parsed = parseODataQuery({
      $apply: 'groupby((total), aggregate(id with count as OrderCount))',
    });

    assert(parsed.apply);
    assert(parsed.applyPipeline);
    assert.equal(parsed.apply?.groupBy[0], 'total');
    assert.equal(parsed.applyPipeline?.transformations[0].type, 'groupby');
  });

  it('parses multi-stage $apply pipelines into an AST', () => {
    const pipeline = parseApplyPipeline(
      'filter(price gt 100)/groupby((category), aggregate(price with sum as TotalPrice))',
    );

    assert.equal(pipeline.transformations.length, 2);
    const [first, second] = pipeline.transformations;
    assert.equal(first.type, 'filter');
    assert.equal(second.type, 'groupby');
    if (second.type === 'groupby') {
      assert.deepStrictEqual(second.keys, ['category']);
      assert.equal(second.aggregates[0].alias, 'TotalPrice');
    }

    const parsed = parseODataQuery({
      $apply: 'filter(price gt 100)/groupby((category), aggregate(price with sum as TotalPrice))',
    });

    assert(parsed.applyPipeline);
    assert(parsed.apply);
    assert.deepStrictEqual(parsed.apply?.groupBy, ['category']);
    assert.equal(parsed.apply?.aggregates[0].alias, 'TotalPrice');
  });

  it('supports navigation paths in groupby and aggregate expressions', () => {
    const parsed = parseODataQuery({
      $apply: 'groupby((customer/country), aggregate(order/total with sum as TotalRevenue))',
    });

    assert(parsed.applyPipeline);
    assert(parsed.apply);
    assert.deepStrictEqual(parsed.apply?.groupBy, ['customer/country']);
    assert.equal(parsed.apply?.aggregates[0].field, 'order/total');
  });

  it('parses arithmetic aggregate operands', () => {
    const parsed = parseODataQuery({
      $apply: 'aggregate(quantity mul unitPrice with sum as TotalRevenue)',
    });

    assert(parsed.applyPipeline);
    assert(parsed.apply);
    const aggregate = parsed.apply?.aggregates[0];
    assert(aggregate);
    assert.equal(aggregate.alias, 'TotalRevenue');
    assert(!aggregate.field);
    assert(aggregate.expression);
    if (aggregate.expression) {
      assert.equal(aggregate.expression.type, 'binary');
      assert.equal(aggregate.expression.operator, 'mul');
    }
  });

  it('parses concat transformations inside $apply pipelines', () => {
    const expression =
      'concat(aggregate(quantity with sum as TotalQuantity),groupby((product/name), aggregate(quantity with sum as TotalQuantity))/concat(aggregate($count as UI5__count),top(5)))';
    const pipeline = parseApplyPipeline(expression);
    assert.equal(pipeline.transformations.length, 1);
    const [root] = pipeline.transformations;
    assert.equal(root.type, 'concat');
    if (root.type === 'concat') {
      assert.equal(root.pipelines.length, 2);
      const summary = root.pipelines.find(
        (branch) => branch.transformations[0]?.type === 'aggregate',
      );
      const detail = root.pipelines.find((branch) => branch.transformations[0]?.type === 'groupby');
      assert(summary);
      assert(detail);
      if (summary && summary.transformations[0].type === 'aggregate') {
        assert.equal(summary.transformations[0].expressions[0].alias, 'TotalQuantity');
      }
      if (detail) {
        assert.equal(detail.transformations.length, 2);
        const [aggregateStage, innerConcat] = detail.transformations;
        assert.equal(aggregateStage.type, 'groupby');
        assert.equal(innerConcat.type, 'concat');
        if (aggregateStage.type === 'groupby') {
          assert.equal(aggregateStage.aggregates[0].alias, 'TotalQuantity');
        }
        if (innerConcat.type === 'concat') {
          assert.equal(innerConcat.pipelines.length, 2);
          const trailing = innerConcat.pipelines[1];
          const [firstTransform] = trailing.transformations;
          assert(firstTransform);
          assert.equal(firstTransform.type, 'top');
        }
      }
    }

    const parsed = parseODataQuery({ $apply: expression });
    assert(parsed.applyPipeline);
    assert(parsed.apply);
    assert.equal(parsed.apply?.aggregates[0].alias, 'TotalQuantity');
  });
});

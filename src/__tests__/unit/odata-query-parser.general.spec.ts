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

    assert(parsed.lambda);
    assert.deepStrictEqual(parsed.lambda?.path, ['orderItems']);
    assert.deepStrictEqual(parsed.where, { price: { gt: 1000 } });
  });

  it('rejects lambda expressions combined with OR predicates', () => {
    assert.throws(
      () => parseODataQuery({ $filter: 'orderItems/any(i: i/unitPrice gt 800) or price gt 1000' }),
      /Lambda expressions combined with OR are not supported yet/i,
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

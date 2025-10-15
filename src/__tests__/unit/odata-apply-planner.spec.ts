/// <reference path="../../types/testing.globals.d.ts" />

import {strict as assert} from 'assert';
import {buildApplyExecutionPlan} from '../../services/odata-apply-planner.service';
import {parseApplyPipeline} from '../../services/odata-query-parser.service';

describe('OData $apply planner', () => {
  it('pushes down filter() expressions when possible', () => {
    const pipeline = parseApplyPipeline(
      "filter(price gt 100)/groupby((category), aggregate(price with sum as TotalPrice))",
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert(plan.pushdownWhere);
    assert.deepStrictEqual(plan.pushdownWhere, {price: {gt: 100}});
    assert.ok(plan.groupBy);
    assert.equal(plan.groupBy?.aggregates[0].alias, 'TotalPrice');
    assert.equal(plan.postFilters.length, 0);
  });

  it('falls back to post-filtering when filter() contains unsupported functions', () => {
    const pipeline = parseApplyPipeline(
      "filter(trim(name) eq 'Laptop')/groupby((price), aggregate(id with count as ProductCount))",
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert.equal(plan.pushdownWhere, undefined);
    assert.equal(plan.postFilters.length, 1);
    assert.ok(plan.groupBy);
  });

  it('throws in strict mode when filter() cannot be pushed down', () => {
    const pipeline = parseApplyPipeline(
      "filter(trim(name) eq 'Laptop')/groupby((price), aggregate(id with count as ProductCount))",
    );

    assert.throws(
      () => buildApplyExecutionPlan(pipeline, {strict: true}),
      /filter\(\) transformation/i,
    );
  });

  it('captures orderby(), top(), and skip() stages', () => {
    const pipeline = parseApplyPipeline(
      'groupby((category), aggregate(price with sum as TotalPrice))/orderby(TotalPrice desc)/top(5)/skip(1)',
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert.ok(plan.groupBy);
    assert.deepStrictEqual(plan.groupBy?.keys, ['category']);
    assert.deepStrictEqual(plan.orderBy, [{field: 'TotalPrice', direction: 'desc'}]);
    assert.equal(plan.top, 5);
    assert.equal(plan.skip, 1);
  });

  it('requires a groupby() or aggregate() transformation', () => {
    const pipeline = parseApplyPipeline('filter(price gt 100)');

    assert.throws(() => buildApplyExecutionPlan(pipeline), /groupby\(\) or aggregate\(\)/i);
  });

  it('supports aggregate() without groupby()', () => {
    const pipeline = parseApplyPipeline('aggregate(price with sum as TotalPrice)');

    const plan = buildApplyExecutionPlan(pipeline);

    assert.ok(plan.groupBy);
    assert.deepStrictEqual(plan.groupBy?.keys, []);
    assert.equal(plan.groupBy?.aggregates[0].alias, 'TotalPrice');
  });

  it('preserves navigation paths within groupby and aggregates', () => {
    const pipeline = parseApplyPipeline(
      'groupby((order/customer/country), aggregate(order/total with sum as TotalRevenue))',
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert.ok(plan.groupBy);
    assert.deepStrictEqual(plan.groupBy?.keys, ['order/customer/country']);
    assert.equal(plan.groupBy?.aggregates[0].field, 'order/total');
  });

  it('rejects orderby() before groupby()', () => {
    const pipeline = parseApplyPipeline(
      'orderby(price desc)/groupby((category), aggregate(price with sum as TotalPrice))',
    );

    assert.throws(() => buildApplyExecutionPlan(pipeline), /requires a preceding groupby\(\)/i);
  });
});

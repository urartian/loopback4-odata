/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { expect } from '@loopback/testlab';
import { buildApplyExecutionPlan } from '../../services/odata-apply-planner.service';
import { parseApplyPipeline } from '../../services/odata-query-parser.service';
import { Product } from '../../../examples/basic-app';

describe('OData $apply planner', () => {
  it('pushes down filter() expressions when possible', () => {
    const pipeline = parseApplyPipeline(
      'filter(price gt 100)/groupby((category), aggregate(price with sum as TotalPrice))',
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert(plan.pushdownWhere);
    assert.deepStrictEqual(plan.pushdownWhere, { price: { gt: 100 } });
    assert.equal(plan.preAggregationFilters.length, 0);
    assert.equal(plan.stages.length, 1);
    assert.deepStrictEqual(plan.stages[0].spec.groupBy, ['category']);
    assert.equal(plan.stages[0].spec.aggregates[0].alias, 'TotalPrice');
    assert.equal(plan.stages[0].postAggregationFilters.length, 0);
    assert.equal(plan.stages[0].navigationPaths.length, 0);
  });

  it('falls back to post-filtering when filter() contains unsupported functions', () => {
    const pipeline = parseApplyPipeline(
      "filter(trim(name) eq 'Laptop')/groupby((price), aggregate(id with count as ProductCount))",
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert.equal(plan.pushdownWhere, undefined);
    assert.equal(plan.preAggregationFilters.length, 1);
    assert.equal(plan.stages.length, 1);
    assert.equal(plan.stages[0].postAggregationFilters.length, 0);
    assert.equal(plan.stages[0].navigationPaths.length, 0);
  });

  it('throws in strict mode when filter() cannot be pushed down', () => {
    const pipeline = parseApplyPipeline(
      "filter(trim(name) eq 'Laptop')/groupby((price), aggregate(id with count as ProductCount))",
    );

    assert.throws(
      () => buildApplyExecutionPlan(pipeline, { strict: true }),
      /filter\(\) transformation/i,
    );
  });

  it('captures orderby(), top(), and skip() stages', () => {
    const pipeline = parseApplyPipeline(
      'groupby((category), aggregate(price with sum as TotalPrice))/orderby(TotalPrice desc)/top(5)/skip(1)',
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert.equal(plan.stages.length, 1);
    assert.deepStrictEqual(plan.stages[0].spec.groupBy, ['category']);
    assert.deepStrictEqual(plan.stages[0].orderBy, [{ field: 'TotalPrice', direction: 'desc' }]);
    assert.equal(plan.stages[0].top, 5);
    assert.equal(plan.stages[0].skip, 1);
  });

  it('builds a plan for filter-only pipelines', () => {
    const pipeline = parseApplyPipeline('filter(price gt 100)');

    const plan = buildApplyExecutionPlan(pipeline);

    assert(plan.pushdownWhere);
    assert.deepStrictEqual(plan.pushdownWhere, { price: { gt: 100 } });
    assert.equal(plan.stages.length, 0);
  });

  it('captures paging stages for non-aggregate pipelines', () => {
    const pipeline = parseApplyPipeline('filter(price gt 100)/top(5)/skip(2)');

    const plan = buildApplyExecutionPlan(pipeline);

    assert.equal(plan.stages.length, 0);
    assert.equal(plan.postTop, 5);
    assert.equal(plan.postSkip, 2);
    assert(plan.pushdownWhere);
  });

  it('supports aggregate() without groupby()', () => {
    const pipeline = parseApplyPipeline('aggregate(price with sum as TotalPrice)');

    const plan = buildApplyExecutionPlan(pipeline);

    assert.equal(plan.preAggregationFilters.length, 0);
    assert.equal(plan.stages.length, 1);
    assert.deepStrictEqual(plan.stages[0].spec.groupBy, []);
    assert.equal(plan.stages[0].spec.aggregates[0].alias, 'TotalPrice');
    assert.equal(plan.stages[0].postAggregationFilters.length, 0);
    assert.equal(plan.stages[0].navigationPaths.length, 0);
  });

  it('captures post-aggregation filters', () => {
    const pipeline = parseApplyPipeline(
      'groupby((category), aggregate(price with sum as TotalPrice))/filter(TotalPrice gt 1000)',
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert.equal(plan.preAggregationFilters.length, 0);
    assert.equal(plan.stages.length, 1);
    assert.equal(plan.stages[0].postAggregationFilters.length, 1);
    assert.equal(plan.stages[0].navigationPaths.length, 0);
  });

  it('preserves navigation paths within groupby and aggregates', () => {
    const pipeline = parseApplyPipeline(
      'groupby((order/customer/country), aggregate(order/total with sum as TotalRevenue))',
    );

    const plan = buildApplyExecutionPlan(pipeline);

    assert.equal(plan.stages.length, 1);
    assert.deepStrictEqual(plan.stages[0].spec.groupBy, ['order/customer/country']);
    assert.equal(plan.stages[0].spec.aggregates[0].field, 'order/total');
    assert.equal(plan.stages[0].navigationPaths.length, 0);
  });

  it('rejects orderby() before groupby()', () => {
    const pipeline = parseApplyPipeline(
      'orderby(price desc)/groupby((category), aggregate(price with sum as TotalPrice))',
    );

    assert.throws(() => buildApplyExecutionPlan(pipeline), /requires a preceding groupby\(\)/i);
  });

  it('captures navigation paths when modelCtor is provided', () => {
    const pipeline = parseApplyPipeline(
      'groupby((orderItems/productId), aggregate(orderItems/quantity with sum as TotalQty))',
    );

    const plan = buildApplyExecutionPlan(pipeline, { modelCtor: Product });

    expect(plan.stages[0].navigationPaths).to.have.length(2);
    const paths = plan.stages[0].navigationPaths.map((p) => p.originalPath).sort();
    expect(paths).to.deepEqual(['orderItems/productId', 'orderItems/quantity']);
  });

  it('builds plans for concat pipelines with branch stages', () => {
    const pipeline = parseApplyPipeline(
      'concat(aggregate(quantity with sum as TotalQuantity),groupby((product/name), aggregate(quantity with sum as TotalQuantity))/concat(aggregate($count as UI5__count),top(3)))',
    );

    const plan = buildApplyExecutionPlan(pipeline);

    expect(plan.stages).to.have.length(0);
    expect(plan.concat).to.be.an.Array();
    expect(plan.concat).to.have.length(2);

    const [summaryPlan, detailPlan] = plan.concat!;
    expect(summaryPlan.stages).to.have.length(1);
    expect(summaryPlan.stages[0].spec.aggregates[0].alias).to.equal('TotalQuantity');

    expect(detailPlan.stages).to.have.length(1);
    expect(detailPlan.stages[0].spec.aggregates[0].alias).to.equal('TotalQuantity');
    expect(detailPlan.concat).to.have.length(2);

    const [, detailBranches] = detailPlan.concat!;
    expect(detailBranches?.postTop).to.equal(3);
  });

  it('collects navigation paths from compute aggregate operands', () => {
    const pipeline = parseApplyPipeline(
      'groupby((productId), aggregate(quantity mul product/price with sum as TotalRevenue))',
    );

    const plan = buildApplyExecutionPlan(pipeline, { modelCtor: Product });

    expect(plan.stages).to.have.length(1);
    const [stage] = plan.stages;
    expect(
      stage.navigationPaths.some((path) => path.originalPath === 'product/price'),
    ).to.be.true();
  });
});

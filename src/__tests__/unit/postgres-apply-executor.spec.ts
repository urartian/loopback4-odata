/// <reference path="../../types/testing.globals.d.ts" />

import {expect} from '@loopback/testlab';
import {
  AnyObject,
  Entity,
  Filter,
  ModelDefinition,
  juggler,
} from '@loopback/repository';
import {ApplyAggregationStage, ApplyExecutionPlan} from '../../services/odata-apply-planner.service';
import {ParsedExpression} from '../../services/odata-query-parser.service';
import {
  ODataApplyExecutorContext,
} from '../../services/odata-apply-executor.registry';
import {PostgresApplyExecutor} from '../../services/postgres-apply-executor';
import {EntitySetDef} from '../../registry/entityset-registry';

describe('PostgresApplyExecutor (multi-stage)', () => {
  it('pushes down chained stages with filters, ordering, and pagination', async () => {
    class Order extends Entity {
      id!: number;
      total!: number;
      status!: string;
    }
    (Order as AnyObject).definition = {
      name: 'Order',
      properties: {
        id: {type: 'number', id: true},
        total: {type: 'number'},
        status: {type: 'string'},
      },
    } as unknown as ModelDefinition;

    const executor = new PostgresApplyExecutor();

    let executedSql = '';
    let executedParams: unknown[] = [];
    const dataSource = {
      connector: {name: 'postgresql'},
      execute: async (sql: string, params: unknown[]) => {
        executedSql = sql;
        executedParams = params;
        return [{OverallCount: 42}];
      },
    } as unknown as juggler.DataSource;

    const repository = {dataSource} as AnyObject;

    const stageOneFilter: ParsedExpression = {
      operator: 'comparison',
      field: 'OrderCount',
      comparator: 'gt',
      value: 0,
    };
    const stageTwoFilter: ParsedExpression = {
      operator: 'comparison',
      field: 'OverallCount',
      comparator: 'gt',
      value: 10,
    };

    const stageOne: ApplyAggregationStage = {
      spec: {
        groupBy: ['total'],
        aggregates: [{field: 'id', operator: 'count', alias: 'OrderCount'}],
      },
      postAggregationFilters: [stageOneFilter],
      orderBy: [{field: 'total', direction: 'desc'}],
      top: 10,
      skip: 5,
      navigationPaths: [],
    };

    const stageTwo: ApplyAggregationStage = {
      spec: {
        groupBy: [],
        aggregates: [{field: 'OrderCount', operator: 'sum', alias: 'OverallCount'}],
      },
      postAggregationFilters: [stageTwoFilter],
      orderBy: [{field: 'OverallCount', direction: 'desc'}],
      top: 1,
      navigationPaths: [],
    };

    const plan: ApplyExecutionPlan = {
      pushdownWhere: undefined,
      preAggregationFilters: [],
      stages: [stageOne, stageTwo],
    };

    const fetchFilter: Filter<AnyObject> = {
      where: {status: 'pending'},
    };

    const entitySet: EntitySetDef = {
      name: 'Orders',
      modelCtor: Order,
      applyPushdown: true,
      applyExecutorId: 'postgresql',
      sqlMetadata: {
        tableName: 'orders',
        columnMap: {
          id: 'id',
          total: 'total',
          status: 'status',
        },
      },
    };

    const context: ODataApplyExecutorContext = {
      entitySet,
      repository: repository as any,
      plan,
      pipeline: {transformations: []},
      aggregation: stageTwo.spec,
      baseFilter: {...fetchFilter},
      fetchFilter,
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: plan.stages.length,
      telemetry: () => {},
    };

    const result = await executor.execute(context);
    expect(result).to.not.be.undefined();
    expect(result?.rows).to.deepEqual([{OverallCount: 42}]);
    expect(result?.appliedOrder).to.be.true();
    expect(result?.appliedPipelinePagination).to.be.true();
    expect(result?.appliedStageFilters).to.be.true();

    expect(executedParams).to.deepEqual(['pending', 0, 10]);

    expect(executedSql).to.match(/WITH stage0 AS \(/);
    expect(executedSql.includes('FROM "orders" AS t')).to.be.true();
    expect(executedSql.includes('WHERE t."status" = $1')).to.be.true();
    expect(executedSql.includes('GROUP BY t."total"')).to.be.true();
    expect(executedSql.includes('HAVING "OrderCount" > $2')).to.be.true();
    expect(executedSql.includes('ORDER BY "total" DESC LIMIT 10 OFFSET 5')).to.be.true();
    expect(executedSql.includes('FROM stage0 AS s1')).to.be.true();
    expect(executedSql.includes('HAVING "OverallCount" > $3')).to.be.true();
    expect(executedSql.includes('SELECT * FROM stage1 ORDER BY "OverallCount" DESC LIMIT 1')).to.be.true();
    expect(executedSql.indexOf('HAVING "OrderCount" > $2')).to.be.lessThan(
      executedSql.indexOf('ORDER BY "total" DESC LIMIT 10 OFFSET 5'),
    );
    expect(executedSql.indexOf('HAVING "OverallCount" > $3')).to.be.lessThan(
      executedSql.indexOf('SELECT * FROM stage1 ORDER BY "OverallCount" DESC LIMIT 1'),
    );
  });
});

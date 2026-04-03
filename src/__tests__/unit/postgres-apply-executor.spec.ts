/// <reference path="../../types/testing.globals.d.ts" />

import { expect } from '@loopback/testlab';
import { AnyObject, Entity, Filter, ModelDefinition, juggler } from '@loopback/repository';
import {
  ApplyAggregationStage,
  ApplyExecutionPlan,
} from '../../services/odata-apply-planner.service';
import { ParsedExpression } from '../../services/odata-query-parser.service';
import {
  ODataApplyExecutorContext,
  ODataApplyExecutorResult,
} from '../../services/odata-apply-executor.registry';
import { PostgresApplyExecutor } from '../../services/postgres-apply-executor';
import { EntitySetDef } from '../../registry/entityset-registry';

describe('PostgresApplyExecutor (multi-stage)', () => {
  it('recognizes supported Postgres datasources from connector settings', () => {
    const executor = new PostgresApplyExecutor();

    expect(
      executor.supports({
        connector: {settings: {name: 'postgresql'}},
        execute: async () => [],
      } as unknown as juggler.DataSource),
    ).to.be.true();

    expect(
      executor.supports({
        connector: {name: 'postgresql'},
      } as unknown as juggler.DataSource),
    ).to.be.false();
  });

  it('returns undefined for unsupported include and pre-aggregation inputs', async () => {
    class Order extends Entity {
      id!: number;
      total!: number;
    }
    (Order as AnyObject).definition = {
      name: 'Order',
      properties: {
        id: {type: 'number', id: true},
        total: {type: 'number'},
      },
    } as unknown as ModelDefinition;

    const executor = new PostgresApplyExecutor();
    const dataSource = {
      connector: {name: 'postgresql'},
      execute: async () => [{Total: 10}],
    } as unknown as juggler.DataSource;
    const repository = {dataSource} as AnyObject;
    const stage: ApplyAggregationStage = {
      spec: {
        groupBy: [],
        aggregates: [{field: 'total', operator: 'sum', alias: 'Total'}],
      },
      postAggregationFilters: [],
      navigationPaths: [],
    };
    const entitySet: EntitySetDef = {
      name: 'Orders',
      modelCtor: Order,
      applyPushdown: true,
      applyExecutorId: 'postgresql',
      sqlMetadata: {tableName: 'orders', columnMap: {id: 'id', total: 'total'}},
    };

    const includeArray = await executor.execute({
      entitySet,
      repository: repository as any,
      plan: {pushdownWhere: undefined, preAggregationFilters: [], stages: [stage]},
      pipeline: {transformations: []},
      aggregation: stage.spec,
      baseFilter: {include: ['items']},
      fetchFilter: {include: ['items']},
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: 1,
      telemetry: () => {},
    });
    expect(includeArray).to.equal(undefined);

    const includeObject = await executor.execute({
      entitySet,
      repository: repository as any,
      plan: {pushdownWhere: undefined, preAggregationFilters: [], stages: [stage]},
      pipeline: {transformations: []},
      aggregation: stage.spec,
      baseFilter: {include: {relation: 'items'}} as any,
      fetchFilter: {include: {relation: 'items'}} as any,
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: 1,
      telemetry: () => {},
    });
    expect(includeObject).to.equal(undefined);

    const preAggregation = await executor.execute({
      entitySet,
      repository: repository as any,
      plan: {
        pushdownWhere: undefined,
        preAggregationFilters: [{operator: 'comparison', field: 'total', comparator: 'gt', value: 0}],
        stages: [stage],
      },
      pipeline: {transformations: []},
      aggregation: stage.spec,
      baseFilter: {},
      fetchFilter: {},
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: 1,
      telemetry: () => {},
    });
    expect(preAggregation).to.equal(undefined);
  });

  it('pushes down chained stages with filters, ordering, and pagination', async () => {
    class Order extends Entity {
      id!: number;
      total!: number;
      status!: string;
    }
    (Order as AnyObject).definition = {
      name: 'Order',
      properties: {
        id: { type: 'number', id: true },
        total: { type: 'number' },
        status: { type: 'string' },
      },
    } as unknown as ModelDefinition;

    const executor = new PostgresApplyExecutor();

    let executedSql = '';
    let executedParams: unknown[] = [];
    const dataSource = {
      connector: { name: 'postgresql' },
      execute: async (sql: string, params: unknown[]) => {
        executedSql = sql;
        executedParams = params;
        return [{ OverallCount: 42 }];
      },
    } as unknown as juggler.DataSource;

    const repository = { dataSource } as AnyObject;

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
        aggregates: [{ field: 'id', operator: 'count', alias: 'OrderCount' }],
      },
      postAggregationFilters: [stageOneFilter],
      orderBy: [{ field: 'total', direction: 'desc' }],
      top: 10,
      skip: 5,
      navigationPaths: [],
    };

    const stageTwo: ApplyAggregationStage = {
      spec: {
        groupBy: [],
        aggregates: [{ field: 'OrderCount', operator: 'sum', alias: 'OverallCount' }],
      },
      postAggregationFilters: [stageTwoFilter],
      orderBy: [{ field: 'OverallCount', direction: 'desc' }],
      top: 1,
      navigationPaths: [],
    };

    const plan: ApplyExecutionPlan = {
      pushdownWhere: undefined,
      preAggregationFilters: [],
      stages: [stageOne, stageTwo],
    };

    const fetchFilter: Filter<AnyObject> = {
      where: { status: 'pending' },
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
      pipeline: { transformations: [] },
      aggregation: stageTwo.spec,
      baseFilter: { ...fetchFilter },
      fetchFilter,
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: plan.stages.length,
      telemetry: () => {},
    };

    const execOutcome = await executor.execute(context);
    expect(execOutcome).to.not.have.property('declineReason');
    const result = execOutcome as ODataApplyExecutorResult;
    expect(result.rows).to.deepEqual([{ OverallCount: 42 }]);
    expect(result.appliedOrder).to.be.true();
    expect(result.appliedPipelinePagination).to.be.true();
    expect(result.appliedStageFilters).to.be.true();

    expect(executedParams).to.deepEqual(['pending', 0, 10]);

    expect(executedSql).to.match(/WITH stage0 AS \(/);
    expect(executedSql.includes('FROM "orders" AS t')).to.be.true();
    expect(executedSql.includes('WHERE t."status" = $1')).to.be.true();
    expect(executedSql.includes('GROUP BY t."total"')).to.be.true();
    expect(executedSql.includes('HAVING "OrderCount" > $2')).to.be.true();
    expect(executedSql.includes('ORDER BY "total" DESC LIMIT 10 OFFSET 5')).to.be.true();
    expect(executedSql.includes('FROM stage0 AS s1')).to.be.true();
    expect(executedSql.includes('HAVING "OverallCount" > $3')).to.be.true();
    expect(
      executedSql.includes('SELECT * FROM stage1 ORDER BY "OverallCount" DESC LIMIT 1'),
    ).to.be.true();
    expect(executedSql.indexOf('HAVING "OrderCount" > $2')).to.be.lessThan(
      executedSql.indexOf('ORDER BY "total" DESC LIMIT 10 OFFSET 5'),
    );
    expect(executedSql.indexOf('HAVING "OverallCount" > $3')).to.be.lessThan(
      executedSql.indexOf('SELECT * FROM stage1 ORDER BY "OverallCount" DESC LIMIT 1'),
    );
  });

  it('pushes down structured property groupBy, aggregates, and filters', async () => {
    class Incident extends Entity {
      id!: number;
      location!: AnyObject;
    }
    (Incident as AnyObject).definition = {
      name: 'Incident',
      properties: {
        id: { type: 'number', id: true },
        location: {
          jsonSchema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              coordinates: {
                type: 'object',
                properties: {
                  lat: { type: 'number' },
                  lon: { type: 'number' },
                },
              },
            },
          },
        },
      },
    } as unknown as ModelDefinition;

    const executor = new PostgresApplyExecutor();

    let executedSql = '';
    let executedParams: unknown[] = [];
    const dataSource = {
      connector: { name: 'postgresql' },
      execute: async (sql: string, params: unknown[]) => {
        executedSql = sql;
        executedParams = params;
        return [{ 'location/city': 'Paris', TotalLat: 15 }];
      },
    } as unknown as juggler.DataSource;

    const entitySet: EntitySetDef = {
      name: 'Incidents',
      modelCtor: Incident,
      applyPushdown: true,
      applyExecutorId: 'postgresql',
      sqlMetadata: {
        tableName: 'incidents',
        columnMap: { id: 'id', location: 'location' },
      },
    };

    const stage: ApplyAggregationStage = {
      spec: {
        groupBy: ['location/city'],
        aggregates: [{ field: 'location/coordinates/lat', operator: 'sum', alias: 'TotalLat' }],
      },
      postAggregationFilters: [],
      navigationPaths: [],
    };

    const plan: ApplyExecutionPlan = {
      pushdownWhere: undefined,
      preAggregationFilters: [],
      stages: [stage],
    };

    const fetchFilter: Filter<AnyObject> = {
      where: { 'location/coordinates/lon': { gt: 0 } },
    };

    const repository = { dataSource } as AnyObject;
    const context: ODataApplyExecutorContext = {
      entitySet,
      repository: repository as any,
      plan,
      pipeline: { transformations: [] },
      aggregation: stage.spec,
      baseFilter: { ...fetchFilter },
      fetchFilter,
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: 1,
      telemetry: () => {},
    };

    const execOutcome = await executor.execute(context);
    expect(execOutcome).to.not.have.property('declineReason');
    const result = execOutcome as ODataApplyExecutorResult;
    expect(result.rows).to.deepEqual([{ 'location/city': 'Paris', TotalLat: 15 }]);
    expect(executedParams).to.deepEqual([0]);
    expect(executedSql.includes('#>> \'{"city"}\'')).to.be.true();
    expect(executedSql.includes('#>> \'{"coordinates","lat"}\'')).to.be.true();
    expect(executedSql.includes('#>> \'{"coordinates","lon"}\'')).to.be.true();
    expect(executedSql.includes('::numeric')).to.be.true();
  });

  it('reports structured-path-unsupported when JSON arrays are referenced', async () => {
    class Incident extends Entity {
      id!: number;
      metadata!: AnyObject;
    }
    (Incident as AnyObject).definition = {
      name: 'Incident',
      properties: {
        id: { type: 'number', id: true },
        metadata: {
          jsonSchema: {
            type: 'object',
            properties: {
              tags: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as ModelDefinition;

    const executor = new PostgresApplyExecutor();
    const dataSource = {
      connector: { name: 'postgresql' },
      execute: async () => [],
    } as unknown as juggler.DataSource;

    const stage: ApplyAggregationStage = {
      spec: {
        groupBy: ['metadata/tags/name'],
        aggregates: [{ field: 'id', operator: 'count', alias: 'Count' }],
      },
      postAggregationFilters: [],
      navigationPaths: [],
    };

    const plan: ApplyExecutionPlan = {
      pushdownWhere: undefined,
      preAggregationFilters: [],
      stages: [stage],
    };

    const fetchFilter: Filter<AnyObject> = {};

    const repository = { dataSource } as AnyObject;
    const context: ODataApplyExecutorContext = {
      entitySet: {
        name: 'Incidents',
        modelCtor: Incident,
        applyPushdown: true,
        applyExecutorId: 'postgresql',
        sqlMetadata: { tableName: 'incidents', columnMap: { id: 'id', metadata: 'metadata' } },
      },
      repository: repository as any,
      plan,
      pipeline: { transformations: [] },
      aggregation: stage.spec,
      baseFilter: { ...fetchFilter },
      fetchFilter,
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: 1,
      telemetry: () => {},
    };

    const execOutcome = await executor.execute(context);
    expect(execOutcome).to.have.property('declineReason', 'structured-path-unsupported');
  });

  it('builds a single-stage plan from aggregation and applies external paging', async () => {
    class Order extends Entity {
      id!: number;
      total!: number;
    }
    (Order as AnyObject).definition = {
      name: 'Order',
      properties: {
        id: {type: 'number', id: true},
        total: {type: 'number'},
      },
    } as unknown as ModelDefinition;

    const executor = new PostgresApplyExecutor();
    let executedSql = '';
    let executedParams: unknown[] = [];
    const telemetryPayloads: AnyObject[] = [];
    const dataSource = {
      connector: {name: 'postgresql'},
      execute: async (sql: string, params: unknown[]) => {
        executedSql = sql;
        executedParams = params;
        return [{Total: 30}, {Total: 20}, {Total: 10}];
      },
    } as unknown as juggler.DataSource;

    const result = await executor.execute({
      entitySet: {
        name: 'Orders',
        modelCtor: Order,
        applyPushdown: true,
        applyExecutorId: 'postgresql',
        sqlMetadata: {tableName: 'orders', columnMap: {id: 'id', total: 'total'}},
      },
      repository: {dataSource} as any,
      plan: undefined as unknown as ApplyExecutionPlan,
      pipeline: {transformations: []},
      aggregation: {
        groupBy: [],
        aggregates: [{field: 'total', operator: 'sum', alias: 'Total'}],
      },
      baseFilter: {},
      fetchFilter: {},
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: 1,
      paging: {
        order: [{field: 'Total', direction: 'DESC'}],
        skipTokenValues: ['25'],
        pageSize: 2,
        stageTop: 2,
      },
      telemetry: (payload) => telemetryPayloads.push(payload),
    });

    expect(result).to.not.have.property('declineReason');
    const success = result as ODataApplyExecutorResult;
    expect(success).to.have.properties({
      appliedOrder: true,
      appliedExternalPagination: true,
    });
    expect(success.rows).to.deepEqual([{Total: 30}, {Total: 20}]);
    expect(success.nextSkipTokenValues).to.deepEqual(['20']);
    expect(executedSql.includes('LIMIT 2')).to.be.true();
    expect(/"Total"\s*<\s*\$\d+/.test(executedSql)).to.be.true();
    expect(executedParams).to.deepEqual(['25']);
    expect(telemetryPayloads).to.have.length(1);
    expect(telemetryPayloads[0]).to.containDeep({
      rows: 3,
      executorId: 'postgresql',
    });
  });

  it('rejects invalid external paging inputs before executing SQL', async () => {
    class Order extends Entity {
      id!: number;
      total!: number;
    }
    (Order as AnyObject).definition = {
      name: 'Order',
      properties: {
        id: {type: 'number', id: true},
        total: {type: 'number'},
      },
    } as unknown as ModelDefinition;

    const executor = new PostgresApplyExecutor();
    const dataSource = {
      connector: {name: 'postgresql'},
      execute: async () => [{Total: 1}],
    } as unknown as juggler.DataSource;
    const entitySet: EntitySetDef = {
      name: 'Orders',
      modelCtor: Order,
      applyPushdown: true,
      applyExecutorId: 'postgresql',
      sqlMetadata: {tableName: 'orders', columnMap: {id: 'id', total: 'total'}},
    };
    const stage: ApplyAggregationStage = {
      spec: {
        groupBy: [],
        aggregates: [{field: 'total', operator: 'sum', alias: 'Total'}],
      },
      postAggregationFilters: [],
      navigationPaths: [],
    };

    const pageSizeWithoutOrder = await executor.execute({
      entitySet,
      repository: {dataSource} as any,
      plan: {pushdownWhere: undefined, preAggregationFilters: [], stages: [stage]},
      pipeline: {transformations: []},
      aggregation: stage.spec,
      baseFilter: {},
      fetchFilter: {},
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: 1,
      paging: {order: [], pageSize: 2},
      telemetry: () => {},
    });
    expect(pageSizeWithoutOrder).to.equal(undefined);

    const mismatchedSkipToken = await executor.execute({
      entitySet,
      repository: {dataSource} as any,
      plan: {pushdownWhere: undefined, preAggregationFilters: [], stages: [stage]},
      pipeline: {transformations: []},
      aggregation: stage.spec,
      baseFilter: {},
      fetchFilter: {},
      options: undefined,
      requestedLimit: undefined,
      requestedOffset: undefined,
      stageIndex: 0,
      stageCount: 1,
      paging: {
        order: [
          {field: 'Total', direction: 'DESC'},
          {field: 'Other', direction: 'ASC'},
        ],
        skipTokenValues: ['20'],
      },
      telemetry: () => {},
    });
    expect(mismatchedSkipToken).to.equal(undefined);
  });
});

import {
  AnyObject,
  DataObject,
  ModelDefinition,
  PropertyDefinition,
  Where,
  juggler,
  Entity,
} from '@loopback/repository';
import {
  ODataApplyExecutor,
  ODataApplyExecutorContext,
  ODataApplyExecutorResult,
  ApplyOrderDescriptor,
} from './odata-apply-executor.registry';
import { ParsedExpression, AggregationSpec } from './odata-query-parser.service';
import {
  ApplyAggregationStage,
  ApplyExecutionPlan,
  collectNavigationPathsForStage,
} from './odata-apply-planner.service';
import { EntitySqlMetadata } from '../registry/entityset-registry';
import { inferSqlMetadata } from '../util/sql-metadata';
import {
  resolveNavigationPath,
  NavigationPathError,
  ResolvedNavigationPath,
} from '../util/navigation-path';

interface ColumnResolution {
  column: string;
  rawColumn: string;
}

interface StageSource {
  alias: string;
  fromClause: string;
  resolveField(field: string): ColumnResolution | undefined;
  getJoinClauses?(): string[];
  getJoinCount?(): number;
  availableColumns?: Set<string>;
}

interface StageSqlBuildResult {
  name: string;
  sql: string;
  outputColumns: Set<string>;
  finalOrderClause?: string;
  finalLimitClause?: string;
  finalOffsetClause?: string;
  finalWhereClause?: string;
  filtersApplied: boolean;
  paginationApplied: boolean;
  joinCountContribution: number;
}

interface StageBuildOptions {
  stageIndex: number;
  stageName: string;
  source: StageSource;
  params: unknown[];
  isFinalStage: boolean;
  where?: Where<DataObject<AnyObject>>;
}

const SUPPORTED_AGGREGATES = new Set(['sum', 'average', 'min', 'max', 'count', 'countdistinct']);

export class MySqlApplyExecutor implements ODataApplyExecutor {
  readonly id = 'mysql';
  readonly capabilities = { navigation: true };

  supports(datasource: juggler.DataSource): boolean {
    const connectorName =
      datasource?.connector?.name ?? datasource?.connector?.settings?.name ?? '';
    if (!connectorName) return false;
    if (typeof datasource.execute !== 'function') return false;
    const normalized = connectorName.toLowerCase();
    return normalized.includes('mysql') || normalized.includes('mariadb');
  }

  async execute(ctx: ODataApplyExecutorContext): Promise<ODataApplyExecutorResult | undefined> {
    const { repository, plan, fetchFilter, entitySet } = ctx;

    const dataSource = (repository as { dataSource?: juggler.DataSource }).dataSource;
    if (!dataSource || typeof dataSource.execute !== 'function') {
      return undefined;
    }

    if (fetchFilter.include && Array.isArray(fetchFilter.include) && fetchFilter.include.length) {
      return undefined;
    }
    if (fetchFilter.include && !Array.isArray(fetchFilter.include)) {
      return undefined;
    }

    const effectivePlan = plan ?? this.buildPlanFromAggregation(ctx);
    const stages = effectivePlan?.stages ?? [];
    if (!stages.length) return undefined;
    if (effectivePlan?.preAggregationFilters?.length) {
      return undefined;
    }
    const finalStageSpec = stages[stages.length - 1]?.spec;
    if (!finalStageSpec?.aggregates?.length) return undefined;

    const modelDefinition = (entitySet.modelCtor as { definition?: ModelDefinition }).definition;
    if (!modelDefinition) return undefined;

    const metadataCache = new Map<typeof Entity, EntitySqlMetadata>();
    const baseMetadata = this.getBaseSqlMetadata(ctx, dataSource, metadataCache);
    if (!baseMetadata) return undefined;

    const tableInfo = this.buildTableInfo(baseMetadata);
    if (!tableInfo) return undefined;

    const maxJoinDepth = 5;
    const navigationMap = new Map<string, ResolvedNavigationPath>();
    const firstStage = stages[0];
    firstStage?.navigationPaths?.forEach((path) => navigationMap.set(path.originalPath, path));

    const joinManager = new NavigationJoinManager(
      entitySet.modelCtor,
      tableInfo.alias,
      tableInfo.tableRef,
      (model) => this.getModelSqlMetadata(model, dataSource, metadataCache),
      maxJoinDepth,
      navigationMap,
    );

    const params: unknown[] = [];

    const baseSource: StageSource = {
      alias: tableInfo.alias,
      fromClause: `${tableInfo.tableRef} AS ${tableInfo.alias}`,
      resolveField: (field) => joinManager.resolveField(field),
      getJoinClauses: () => joinManager.getJoinClauses(),
      getJoinCount: () => joinManager.joinCount,
    };

    const stageResults: StageSqlBuildResult[] = [];
    let currentSource: StageSource = baseSource;
    let totalJoinCount = 0;
    let stageFiltersApplied = true;
    let stagePaginationApplied = true;

    const fetchWhere = fetchFilter.where as Where<DataObject<AnyObject>> | undefined;

    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
      const stageItem = stages[stageIndex];
      const stageName = `stage${stageIndex}`;
      const isFinalStage = stageIndex === stages.length - 1;

      const stageResult = this.buildStageSql(stageItem, {
        stageIndex,
        stageName,
        source: currentSource,
        params,
        isFinalStage,
        where: stageIndex === 0 ? fetchWhere : undefined,
      });
      if (!stageResult) {
        return undefined;
      }

      stageResults.push(stageResult);

      if (stageIndex === 0) {
        totalJoinCount += stageResult.joinCountContribution;
      }

      const requiresFilters = stageItem.postAggregationFilters.length > 0;
      if (requiresFilters && !stageResult.filtersApplied) {
        stageFiltersApplied = false;
      }
      const requiresPagination = stageItem.top !== undefined || stageItem.skip !== undefined;
      if (requiresPagination && !stageResult.paginationApplied) {
        stagePaginationApplied = false;
      }

      if (!isFinalStage) {
        const nextAlias = `s${stageIndex + 1}`;
        currentSource = this.createDerivedStageSource(stageResult, nextAlias);
      }
    }

    if (!stageResults.length) return undefined;

    const paging = ctx.paging;
    const orderDescriptors = paging?.order ?? [];
    if (paging?.pageSize && paging.pageSize > 0 && !orderDescriptors.length) {
      return undefined;
    }
    if (
      paging?.skipTokenValues &&
      (!orderDescriptors.length || paging.skipTokenValues.length !== orderDescriptors.length)
    ) {
      return undefined;
    }

    const finalStage = stageResults[stageResults.length - 1];
    if (paging?.pageSize && paging.pageSize > 0 && orderDescriptors.length) {
      const limitCandidate = paging.pageSize + 1;
      const stageTop = paging.stageTop;
      const limitValue = stageTop != null ? Math.min(stageTop, limitCandidate) : limitCandidate;
      if (limitValue > 0) {
        finalStage.finalLimitClause = `LIMIT ${limitValue}`;
      }
    }
    if (paging?.skipTokenValues && orderDescriptors.length) {
      const predicate = this.buildSkipTokenPredicate(
        orderDescriptors,
        paging.skipTokenValues,
        params,
      );
      if (!predicate) return undefined;
      finalStage.finalWhereClause = finalStage.finalWhereClause
        ? `(${finalStage.finalWhereClause}) AND (${predicate})`
        : predicate;
    }

    const sql = this.composeFinalQuery(stageResults, finalStage);
    if (!sql) return undefined;

    const start = Date.now();
    const result = await dataSource.execute(sql, params, ctx.options);
    const rows = Array.isArray(result)
      ? result.map((row) => (row && typeof row === 'object' ? { ...row } : { value: row }))
      : [];

    const durationMs = Date.now() - start;
    ctx.telemetry?.({
      durationMs,
      rows: rows.length,
      joinCount: totalJoinCount,
      executorId: this.id,
    });

    const hasStageFilters = stages.some((stageItem) => stageItem.postAggregationFilters.length > 0);
    const hasStagePagination = stages.some(
      (stageItem) => stageItem.top !== undefined || stageItem.skip !== undefined,
    );
    const finalStageHasOrder = Boolean(stages[stages.length - 1]?.orderBy?.length);

    let processedRows = rows;
    let nextSkipTokenValues: string[] | undefined;
    if (paging?.pageSize && paging.pageSize > 0 && orderDescriptors.length) {
      const effectiveSize = Math.min(paging.pageSize, rows.length);
      const hasMore = rows.length > paging.pageSize;
      processedRows = rows.slice(0, effectiveSize);
      if (hasMore && processedRows.length) {
        const lastRow = processedRows[processedRows.length - 1];
        nextSkipTokenValues = this.createSkipTokenValues(lastRow, orderDescriptors);
      }
    }

    return {
      rows: processedRows,
      appliedOrder: finalStageHasOrder || orderDescriptors.length ? true : undefined,
      appliedPipelinePagination: hasStagePagination ? stagePaginationApplied : undefined,
      appliedStageFilters: hasStageFilters ? stageFiltersApplied : undefined,
      appliedExternalPagination: paging?.pageSize && orderDescriptors.length ? true : undefined,
      nextSkipTokenValues,
    };
  }

  private buildPlanFromAggregation(ctx: ODataApplyExecutorContext): ApplyExecutionPlan | undefined {
    const aggregation = ctx.aggregation;
    if (!aggregation) return undefined;

    const spec: AggregationSpec = {
      groupBy: [...aggregation.groupBy],
      aggregates: aggregation.aggregates.map((expr) => ({ ...expr })),
    };

    let navigationPaths: ResolvedNavigationPath[] = [];
    try {
      navigationPaths = collectNavigationPathsForStage(ctx.entitySet.modelCtor, spec);
    } catch {
      navigationPaths = [];
    }

    const stage: ApplyAggregationStage = {
      spec,
      postAggregationFilters: [],
      navigationPaths,
    };

    return {
      pushdownWhere: undefined,
      preAggregationFilters: [],
      stages: [stage],
    };
  }

  private buildStageSql(
    stage: ApplyAggregationStage,
    options: StageBuildOptions,
  ): StageSqlBuildResult | undefined {
    const { stageName, source, params, isFinalStage, where } = options;

    const selectParts: string[] = [];
    const groupByParts: string[] = [];
    const outputColumns = new Set<string>();

    for (const field of stage.spec.groupBy ?? []) {
      const resolved = source.resolveField(field);
      if (!resolved) return undefined;
      selectParts.push(`${resolved.column} AS ${quoteIdentifier(field)}`);
      groupByParts.push(resolved.column);
      outputColumns.add(field);
    }

    for (const expr of stage.spec.aggregates) {
      if (!SUPPORTED_AGGREGATES.has(expr.operator)) return undefined;
      const resolved = expr.field ? source.resolveField(expr.field) : undefined;
      if (expr.field && !resolved) return undefined;
      const fragment = this.buildAggregateFragment(expr.operator, resolved?.column);
      if (!fragment) return undefined;
      const alias = expr.alias || `${expr.operator}`;
      selectParts.push(`${fragment} AS ${quoteIdentifier(alias)}`);
      outputColumns.add(alias);
    }

    if (!selectParts.length) return undefined;

    const sqlParts: string[] = [];
    sqlParts.push(`SELECT ${selectParts.join(', ')}`);
    sqlParts.push(`FROM ${source.fromClause}`);

    const joinClauses = source.getJoinClauses ? source.getJoinClauses() : [];
    sqlParts.push(...joinClauses);

    if (where) {
      const whereClause = this.buildWhereClause(
        where,
        (field) => source.resolveField(field),
        params,
      );
      if (whereClause === null) return undefined;
      if (whereClause) {
        sqlParts.push(`WHERE ${whereClause}`);
      } else if (Object.keys(where).length) {
        return undefined;
      }
    }

    if (groupByParts.length) {
      sqlParts.push(`GROUP BY ${groupByParts.join(', ')}`);
    }

    const havingClause = this.buildHavingClause(
      stage.postAggregationFilters,
      (field) => source.resolveField(field),
      stage.spec,
      params,
    );
    if (havingClause === null) {
      return undefined;
    }
    if (stage.postAggregationFilters.length) {
      if (!havingClause) return undefined;
      sqlParts.push(`HAVING ${havingClause}`);
    }

    const orderClause = this.buildOrderClause(stage.orderBy);
    const limitClause = stage.top !== undefined ? `LIMIT ${Math.max(0, stage.top)}` : undefined;
    const offsetClause = stage.skip !== undefined ? `OFFSET ${Math.max(0, stage.skip)}` : undefined;

    if (!isFinalStage) {
      if (orderClause) sqlParts.push(orderClause);
      if (limitClause) sqlParts.push(limitClause);
      if (offsetClause) sqlParts.push(offsetClause);
    }

    const sql = sqlParts.filter((part) => part && part.length).join(' ');

    const requiresFilters = stage.postAggregationFilters.length > 0;

    const joinCountContribution = source.getJoinCount ? (source.getJoinCount() ?? 0) : 0;

    return {
      name: stageName,
      sql,
      outputColumns,
      finalOrderClause: isFinalStage && orderClause ? orderClause : undefined,
      finalLimitClause: isFinalStage && limitClause ? limitClause : undefined,
      finalOffsetClause: isFinalStage && offsetClause ? offsetClause : undefined,
      finalWhereClause: undefined,
      filtersApplied: requiresFilters ? Boolean(havingClause) : true,
      paginationApplied: true,
      joinCountContribution,
    };
  }

  private createDerivedStageSource(stageResult: StageSqlBuildResult, alias: string): StageSource {
    const resolver = this.createDerivedFieldResolver(alias, stageResult.outputColumns);
    return {
      alias,
      fromClause: `${stageResult.name} AS ${alias}`,
      resolveField: resolver,
      availableColumns: stageResult.outputColumns,
    };
  }

  private createDerivedFieldResolver(
    alias: string,
    fields: Set<string>,
  ): (field: string) => ColumnResolution | undefined {
    const exact = new Map<string, string>();
    const lower = new Map<string, string>();
    for (const field of fields) {
      exact.set(field, field);
      lower.set(field.toLowerCase(), field);
    }
    return (field: string): ColumnResolution | undefined => {
      const match = exact.get(field) ?? lower.get(field.toLowerCase());
      if (!match) return undefined;
      const quoted = quoteIdentifier(match);
      return {
        column: `${alias}.${quoted}`,
        rawColumn: quoted,
      };
    };
  }

  private composeFinalQuery(
    stages: StageSqlBuildResult[],
    finalStage: StageSqlBuildResult,
  ): string | undefined {
    if (!stages.length) return undefined;
    const cteClause = stages.map((stage) => `${stage.name} AS (${stage.sql})`).join(', ');
    let finalQuery = `SELECT * FROM ${finalStage.name}`;
    if (finalStage.finalWhereClause) finalQuery += ` WHERE ${finalStage.finalWhereClause}`;
    if (finalStage.finalOrderClause) finalQuery += ` ${finalStage.finalOrderClause}`;
    if (finalStage.finalLimitClause) finalQuery += ` ${finalStage.finalLimitClause}`;
    if (finalStage.finalOffsetClause) finalQuery += ` ${finalStage.finalOffsetClause}`;
    return `WITH ${cteClause} ${finalQuery}`;
  }

  private extractTokenValue(row: AnyObject | undefined, field: string): unknown {
    if (!row) return undefined;
    return (row as AnyObject)[field];
  }

  private stringifyTokenValue(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private buildSkipTokenPredicate(
    descriptors: ApplyOrderDescriptor[],
    tokens: string[],
    params: unknown[],
  ): string | undefined {
    if (!descriptors.length || !tokens.length) return undefined;
    if (descriptors.length !== tokens.length) {
      throw new Error('Skip token length mismatch.');
    }
    const branches: string[] = [];
    for (let index = 0; index < descriptors.length; index++) {
      const descriptor = descriptors[index];
      const equalityParts: string[] = [];
      for (let eqIndex = 0; eqIndex < index; eqIndex++) {
        const placeholder = '?';
        params.push(tokens[eqIndex]);
        equalityParts.push(`${quoteIdentifier(descriptors[eqIndex].field)} = ${placeholder}`);
      }
      const comparator = descriptor.direction === 'DESC' ? '<' : '>';
      const placeholder = '?';
      params.push(tokens[index]);
      equalityParts.push(`${quoteIdentifier(descriptor.field)} ${comparator} ${placeholder}`);
      const clause =
        equalityParts.length === 1
          ? equalityParts[0]
          : equalityParts.map((part) => `(${part})`).join(' AND ');
      branches.push(`(${clause})`);
    }
    if (!branches.length) return undefined;
    return branches.join(' OR ');
  }

  private createSkipTokenValues(
    row: AnyObject | undefined,
    descriptors: ApplyOrderDescriptor[],
  ): string[] | undefined {
    if (!row || !descriptors.length) return undefined;
    const values: string[] = [];
    for (const descriptor of descriptors) {
      const value = this.extractTokenValue(row, descriptor.field);
      if (value === undefined) return undefined;
      values.push(this.stringifyTokenValue(value));
    }
    return values;
  }

  private getOrInferSqlMetadata(
    ctx: ODataApplyExecutorContext,
    dataSource: juggler.DataSource,
  ): EntitySqlMetadata | undefined {
    if (ctx.entitySet.sqlMetadata?.tableName) {
      return ctx.entitySet.sqlMetadata;
    }
    const inferred = inferSqlMetadata(ctx.entitySet.modelCtor, dataSource);
    if (inferred) {
      ctx.entitySet.sqlMetadata = inferred;
      return inferred;
    }
    return ctx.entitySet.sqlMetadata;
  }

  private buildTableInfo(
    metadata: EntitySqlMetadata | undefined,
  ): { tableRef: string; alias: string } | undefined {
    if (!metadata?.tableName) return undefined;
    const alias = 't';
    const schemaPart = metadata.schema ? `${quoteIdentifier(metadata.schema)}.` : '';
    const tableRef = `${schemaPart}${quoteIdentifier(metadata.tableName)}`;
    return { tableRef, alias };
  }

  private createColumnResolver(
    metadata: EntitySqlMetadata | undefined,
    definition: ModelDefinition,
    tableAlias: string,
  ): (field: string) => ColumnResolution | undefined {
    const properties = definition?.properties ?? {};
    const columnMap = metadata?.columnMap ?? {};
    return (property: string): ColumnResolution | undefined => {
      if (!property || property.includes('/')) return undefined;
      const propertyDef = properties[property] as PropertyDefinition | undefined;
      if (!propertyDef && columnMap[property] === undefined) {
        return undefined;
      }
      const columnName =
        columnMap[property] ??
        (propertyDef?.mysql as { columnName?: string } | undefined)?.columnName ??
        propertyDef?.name ??
        property;
      const quoted = `${tableAlias}.${quoteIdentifier(columnName)}`;
      return {
        column: quoted,
        rawColumn: quoteIdentifier(columnName),
      };
    };
  }

  private buildHavingClause(
    filters: ParsedExpression[] | undefined,
    resolver: (field: string) => ColumnResolution | undefined,
    stageSpec: AggregationSpec,
    params: unknown[],
  ): string | null | undefined {
    if (!filters?.length) return undefined;
    const start = params.length;
    const clauses: string[] = [];

    for (const expr of filters) {
      const translated = this.translateHavingExpression(expr, resolver, stageSpec, params);
      if (!translated) {
        params.length = start;
        return null;
      }
      clauses.push(translated);
    }

    if (!clauses.length) {
      params.length = start;
      return null;
    }

    return clauses.length === 1 ? clauses[0] : clauses.map((c) => `(${c})`).join(' AND ');
  }

  private translateHavingExpression(
    expr: ParsedExpression,
    resolver: (field: string) => ColumnResolution | undefined,
    stageSpec: AggregationSpec,
    params: unknown[],
  ): string | undefined {
    const start = params.length;
    switch (expr.operator) {
      case 'comparison':
        return this.translateHavingComparison(
          expr.field,
          expr.comparator,
          expr.value,
          resolver,
          stageSpec,
          params,
        );
      case 'logical': {
        const parts: string[] = [];
        for (const child of expr.expressions) {
          const translated = this.translateHavingExpression(child, resolver, stageSpec, params);
          if (!translated) {
            params.length = start;
            return undefined;
          }
          parts.push(translated);
        }
        if (!parts.length) {
          params.length = start;
          return undefined;
        }
        return parts.length === 1
          ? parts[0]
          : parts.map((p) => `(${p})`).join(` ${expr.type.toUpperCase()} `);
      }
      case 'not': {
        const inner = this.translateHavingExpression(expr.expr, resolver, stageSpec, params);
        if (!inner) {
          params.length = start;
          return undefined;
        }
        return `NOT (${inner})`;
      }
      default:
        params.length = start;
        return undefined;
    }
  }

  private translateHavingComparison(
    field: string,
    comparator: string,
    value: unknown,
    resolver: (field: string) => ColumnResolution | undefined,
    stageSpec: AggregationSpec,
    params: unknown[],
  ): string | undefined {
    const columnSql = this.resolveHavingField(field, resolver, stageSpec);
    if (!columnSql) return undefined;
    const start = params.length;

    switch (comparator) {
      case 'eq':
        if (value === null) return `${columnSql} IS NULL`;
        params.push(value);
        return `${columnSql} = ?`;
      case 'neq':
        if (value === null) return `${columnSql} IS NOT NULL`;
        params.push(value);
        return `${columnSql} <> ?`;
      case 'gt':
      case 'ge':
      case 'lt':
      case 'le': {
        params.push(value);
        const map: Record<string, string> = { gt: '>', ge: '>=', lt: '<', le: '<=' };
        return `${columnSql} ${map[comparator]} ?`;
      }
      default:
        params.length = start;
        return undefined;
    }
  }

  private resolveHavingField(
    field: string,
    resolver: (field: string) => ColumnResolution | undefined,
    stageSpec: AggregationSpec,
  ): string | undefined {
    if (!field) return undefined;
    const aggregateMatch = stageSpec.aggregates.find((a) => a.alias === field);
    if (aggregateMatch) {
      return quoteIdentifier(field);
    }
    if (stageSpec.groupBy.includes(field)) {
      const resolved = resolver(field);
      return resolved?.column;
    }
    const resolved = resolver(field);
    if (resolved) return resolved.column;
    // Allow matching by alias even when alias is lower/upper variations
    const aggregateInsensitive = stageSpec.aggregates.find(
      (a) => (a.alias ?? '').toLowerCase() === field.toLowerCase(),
    );
    if (aggregateInsensitive) {
      return quoteIdentifier(aggregateInsensitive.alias);
    }
    return undefined;
  }

  private buildAggregateFragment(operator: string, column?: string): string | undefined {
    switch (operator) {
      case 'sum':
        return column ? `SUM(${column})` : undefined;
      case 'average':
        return column ? `AVG(${column})` : undefined;
      case 'min':
        return column ? `MIN(${column})` : undefined;
      case 'max':
        return column ? `MAX(${column})` : undefined;
      case 'count':
        return column ? `COUNT(${column})` : 'COUNT(*)';
      case 'countdistinct':
        return column ? `COUNT(DISTINCT ${column})` : undefined;
      default:
        return undefined;
    }
  }

  private buildOrderClause(
    items: Array<{ field: string; direction: 'asc' | 'desc' }> | undefined,
  ): string {
    if (!items?.length) return '';
    const clauses: string[] = [];
    for (const item of items) {
      if (!item.field) continue;
      clauses.push(`${quoteIdentifier(item.field)} ${item.direction.toUpperCase()}`);
    }
    return clauses.length ? `ORDER BY ${clauses.join(', ')}` : '';
  }

  private buildWhereClause(
    where: Where<DataObject<AnyObject>> | undefined,
    resolver: (field: string) => ColumnResolution | undefined,
    params: unknown[],
  ): string | null | undefined {
    if (!where || !Object.keys(where).length) return undefined;
    const start = params.length;
    const clause = this.visitWhereNode(where as AnyObject, resolver, params);
    if (!clause) {
      params.length = start;
      return null;
    }
    return clause;
  }

  private visitWhereNode(
    node: AnyObject,
    resolver: (field: string) => ColumnResolution | undefined,
    params: unknown[],
  ): string | undefined {
    const startLength = params.length;
    if (Array.isArray(node)) {
      const parts: string[] = [];
      for (const entry of node) {
        const part = this.visitWhereNode(entry, resolver, params);
        if (!part) {
          params.length = startLength;
          return undefined;
        }
        parts.push(part);
      }
      if (!parts.length) {
        params.length = startLength;
        return undefined;
      }
      return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
    }
    const clauses: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'and' || key === 'or') {
        const arrayVal = Array.isArray(value) ? value : [value];
        if (!arrayVal.length) continue;
        const subParts: string[] = [];
        for (const entry of arrayVal) {
          const sub = this.visitWhereNode(entry as AnyObject, resolver, params);
          if (!sub) {
            params.length = startLength;
            return undefined;
          }
          subParts.push(sub);
        }
        if (!subParts.length) continue;
        const joined =
          subParts.length === 1 ? subParts[0] : `(${subParts.join(` ${key.toUpperCase()} `)})`;
        clauses.push(joined);
        continue;
      }
      const resolved = resolver(key);
      if (!resolved) {
        params.length = startLength;
        return undefined;
      }
      const condition = this.buildPropertyCondition(resolved.column, value, params);
      if (!condition) {
        params.length = startLength;
        return undefined;
      }
      clauses.push(condition);
    }
    if (!clauses.length) {
      params.length = startLength;
      return undefined;
    }
    return clauses.length === 1 ? clauses[0] : clauses.map((part) => `(${part})`).join(' AND ');
  }

  private buildPropertyCondition(
    column: string,
    value: unknown,
    params: unknown[],
  ): string | undefined {
    const startLength = params.length;
    if (value == null || typeof value !== 'object' || value instanceof Date) {
      if (value === null) {
        return `${column} IS NULL`;
      }
      params.push(value);
      return `${column} = ?`;
    }

    const fragments: string[] = [];
    for (const [operator, operand] of Object.entries(value as Record<string, unknown>)) {
      switch (operator) {
        case 'eq': {
          if (operand === null) {
            fragments.push(`${column} IS NULL`);
            break;
          }
          params.push(operand);
          fragments.push(`${column} = ?`);
          break;
        }
        case 'neq': {
          if (operand === null) {
            fragments.push(`${column} IS NOT NULL`);
            break;
          }
          params.push(operand);
          fragments.push(`${column} <> ?`);
          break;
        }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          params.push(operand);
          const opMap: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
          fragments.push(`${column} ${opMap[operator]} ?`);
          break;
        }
        case 'inq':
        case 'nin': {
          if (!Array.isArray(operand) || !operand.length) {
            fragments.push(operator === 'inq' ? '1=0' : '1=1');
            break;
          }
          const placeholders: string[] = [];
          for (const entry of operand) {
            params.push(entry);
            placeholders.push(`?`);
          }
          const keyword = operator === 'inq' ? 'IN' : 'NOT IN';
          fragments.push(`${column} ${keyword} (${placeholders.join(', ')})`);
          break;
        }
        case 'between': {
          if (!Array.isArray(operand) || operand.length !== 2) return undefined;
          params.push(operand[0]);
          params.push(operand[1]);
          fragments.push(`${column} BETWEEN ? AND ?`);
          break;
        }
        case 'like':
        case 'ilike': {
          params.push(operand);
          fragments.push(`${column} LIKE ?`);
          break;
        }
        default:
          params.length = startLength;
          return undefined;
      }
    }
    if (!fragments.length) {
      params.length = startLength;
      return undefined;
    }
    return fragments.length === 1 ? fragments[0] : `(${fragments.join(' AND ')})`;
  }

  private getBaseSqlMetadata(
    ctx: ODataApplyExecutorContext,
    dataSource: juggler.DataSource,
    cache: Map<typeof Entity, EntitySqlMetadata>,
  ): EntitySqlMetadata | undefined {
    const existing = ctx.entitySet.sqlMetadata;
    if (existing) {
      cache.set(ctx.entitySet.modelCtor, existing);
      return existing;
    }
    const inferred = inferSqlMetadata(ctx.entitySet.modelCtor, dataSource);
    if (inferred) {
      cache.set(ctx.entitySet.modelCtor, inferred);
      ctx.entitySet.sqlMetadata = inferred;
    }
    return inferred;
  }

  private getModelSqlMetadata(
    modelCtor: typeof Entity,
    dataSource: juggler.DataSource,
    cache: Map<typeof Entity, EntitySqlMetadata>,
  ): EntitySqlMetadata | undefined {
    const cached = cache.get(modelCtor);
    if (cached) return cached;
    const inferred = inferSqlMetadata(modelCtor, dataSource);
    if (inferred) {
      cache.set(modelCtor, inferred);
    }
    return inferred;
  }
}

type MetadataProvider = (model: typeof Entity) => EntitySqlMetadata | undefined;

interface JoinNode {
  alias: string;
  tableRef: string;
  condition: string;
  targetModel: typeof Entity;
}

class NavigationJoinManager {
  private readonly joinNodes = new Map<string, JoinNode>();
  private readonly joinOrder: string[] = [];
  private aliasCounter = 0;
  private readonly navigationMap: Map<string, ResolvedNavigationPath>;

  constructor(
    private readonly baseModel: typeof Entity,
    readonly baseAlias: string,
    readonly baseTableRef: string,
    private readonly metadataProvider: MetadataProvider,
    private readonly maxDepth: number,
    navigationPaths?: Map<string, ResolvedNavigationPath>,
  ) {
    this.navigationMap = navigationPaths ?? new Map();
  }

  resolveField(field: string): ColumnResolution | undefined {
    if (!field) return undefined;
    if (!field.includes('/')) {
      const metadata = this.metadataProvider(this.baseModel);
      if (!metadata) return undefined;
      const columnName = this.resolveColumnName(metadata, field);
      if (!columnName) return undefined;
      const quoted = quoteIdentifier(columnName);
      return {
        column: `${this.baseAlias}.${quoted}`,
        rawColumn: quoted,
      };
    }

    const resolved = this.navigationMap.get(field) ?? this.tryResolvePath(field);
    if (!resolved?.joins.length) {
      return undefined;
    }

    const chain = this.ensureJoinChain(resolved);
    if (!chain) return undefined;

    const propertyPath = resolved.propertyPath;
    if (!propertyPath || propertyPath.includes('/')) {
      return undefined;
    }

    const metadata = this.metadataProvider(chain.targetModel);
    if (!metadata) return undefined;
    const columnName = this.resolveColumnName(metadata, propertyPath);
    if (!columnName) return undefined;
    const quoted = quoteIdentifier(columnName);
    return {
      column: `${chain.alias}.${quoted}`,
      rawColumn: quoted,
    };
  }

  getJoinClauses(): string[] {
    return this.joinOrder.map((path) => {
      const node = this.joinNodes.get(path)!;
      return `LEFT JOIN ${node.tableRef} AS ${node.alias} ON ${node.condition}`;
    });
  }

  get joinCount(): number {
    return this.joinOrder.length;
  }

  private nextAlias(): string {
    this.aliasCounter += 1;
    return `j${this.aliasCounter}`;
  }

  private buildTableRef(metadata: EntitySqlMetadata): string {
    const schemaPart = metadata.schema ? `${quoteIdentifier(metadata.schema)}.` : '';
    return `${schemaPart}${quoteIdentifier(metadata.tableName ?? '')}`;
  }

  private resolveColumnName(metadata: EntitySqlMetadata, property: string): string | undefined {
    if (!property) return undefined;
    const map = metadata.columnMap ?? {};
    const candidate = map[property] ?? property;
    return candidate;
  }

  private tryResolvePath(field: string): ResolvedNavigationPath | undefined {
    try {
      const resolved = resolveNavigationPath(this.baseModel, field, { maxDepth: this.maxDepth });
      this.navigationMap.set(field, resolved);
      return resolved;
    } catch (err) {
      if (err instanceof NavigationPathError) return undefined;
      throw err;
    }
  }

  private ensureJoinChain(
    path: ResolvedNavigationPath,
  ): { alias: string; targetModel: typeof Entity } | undefined {
    let currentAlias = this.baseAlias;
    let currentModel = this.baseModel;
    let pathKey = '';

    for (const segment of path.joins) {
      pathKey = pathKey ? `${pathKey}/${segment.relationName}` : segment.relationName;
      let node = this.joinNodes.get(pathKey);
      if (!node) {
        const sourceMetadata = this.metadataProvider(currentModel);
        const targetMetadata = this.metadataProvider(segment.targetModel);
        if (!sourceMetadata || !targetMetadata) return undefined;
        const alias = this.nextAlias();
        const tableRef = this.buildTableRef(targetMetadata);
        const sourceColumn = this.resolveColumnName(sourceMetadata, segment.sourceKey);
        const targetColumn = this.resolveColumnName(targetMetadata, segment.targetKey);
        if (!sourceColumn || !targetColumn) return undefined;
        const condition = `${currentAlias}.${quoteIdentifier(sourceColumn)} = ${alias}.${quoteIdentifier(targetColumn)}`;
        node = {
          alias,
          tableRef,
          condition,
          targetModel: segment.targetModel,
        };
        this.joinNodes.set(pathKey, node);
        this.joinOrder.push(pathKey);
      }
      currentAlias = node.alias;
      currentModel = node.targetModel;
    }

    return { alias: currentAlias, targetModel: currentModel };
  }
}

function quoteIdentifier(identifier: string): string {
  const safe = identifier.replace(/`/g, '``');
  return `\`${safe}\``;
}

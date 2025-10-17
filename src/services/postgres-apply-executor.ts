import {AnyObject, DataObject, ModelDefinition, PropertyDefinition, Where, juggler} from '@loopback/repository';
import {ODataApplyExecutor, ODataApplyExecutorContext, ODataApplyExecutorResult} from './odata-apply-executor.registry';
import {EntitySqlMetadata} from '../registry/entityset-registry';
import {inferSqlMetadata} from '../util/sql-metadata';

interface ColumnResolution {
  column: string;
  rawColumn: string;
}

const SUPPORTED_AGGREGATES = new Set(['sum', 'average', 'min', 'max', 'count', 'countdistinct']);

export class PostgresApplyExecutor implements ODataApplyExecutor {
  readonly id = 'postgresql';

  supports(datasource: juggler.DataSource): boolean {
    const connectorName = datasource?.connector?.name ?? datasource?.connector?.settings?.name ?? '';
    if (!connectorName) return false;
    if (typeof datasource.execute !== 'function') return false;
    return connectorName.toLowerCase().includes('postgres');
  }

  async execute(ctx: ODataApplyExecutorContext): Promise<ODataApplyExecutorResult | undefined> {
    const {repository, aggregation, plan, fetchFilter, entitySet} = ctx;
    if (!aggregation || !aggregation.aggregates?.length) return undefined;

    const dataSource = (repository as {dataSource?: juggler.DataSource}).dataSource;
    if (!dataSource || typeof dataSource.execute !== 'function') {
      return undefined;
    }

    if (fetchFilter.include && Array.isArray(fetchFilter.include) && fetchFilter.include.length) {
      return undefined; // navigation joins not supported in pushdown (yet)
    }
    if (fetchFilter.include && !Array.isArray(fetchFilter.include)) {
      return undefined;
    }

    const modelDefinition = (entitySet.modelCtor as {definition?: ModelDefinition}).definition;
    if (!modelDefinition) return undefined;

    const sqlMetadata = this.getOrInferSqlMetadata(ctx, dataSource);
    const tableInfo = this.buildTableInfo(sqlMetadata);
    if (!tableInfo) return undefined;

    const columnResolver = this.createColumnResolver(sqlMetadata, modelDefinition, tableInfo.alias);

    const selectParts: string[] = [];
    const groupByParts: string[] = [];

    for (const field of aggregation.groupBy ?? []) {
      const resolved = columnResolver(field);
      if (!resolved) return undefined;
      selectParts.push(`${resolved.column} AS ${quoteIdentifier(field)}`);
      groupByParts.push(resolved.column);
    }

    for (const expr of aggregation.aggregates) {
      if (!SUPPORTED_AGGREGATES.has(expr.operator)) return undefined;
      if (expr.field && expr.field.includes('/')) return undefined;
      const resolved = expr.field ? columnResolver(expr.field) : undefined;
      const fragment = this.buildAggregateFragment(expr.operator, resolved?.column);
      if (!fragment) return undefined;
      const alias = expr.alias || `${expr.operator}`;
      selectParts.push(`${fragment} AS ${quoteIdentifier(alias)}`);
    }

    if (!selectParts.length) return undefined;

    const whereResult = this.buildWhereClause(
      fetchFilter.where as Where<DataObject<AnyObject>> | undefined,
      columnResolver,
    );
    const whereClause = whereResult?.clause;
    const params = whereResult?.params ?? [];

    const orderClause = this.buildOrderClause(plan.orderBy);
    const groupByClause = groupByParts.length ? `GROUP BY ${groupByParts.join(', ')}` : '';

    const sqlParts = [
      `SELECT ${selectParts.join(', ')}`,
      `FROM ${tableInfo.tableRef} AS ${tableInfo.alias}`,
    ];
    if (whereClause) sqlParts.push(`WHERE ${whereClause}`);
    if (groupByClause) sqlParts.push(groupByClause);
    if (orderClause) sqlParts.push(orderClause);

    const sql = sqlParts.join(' ');
    const result = await dataSource.execute(sql, params, ctx.options);
    const rows = Array.isArray(result)
      ? result.map(row => (row && typeof row === 'object' ? {...row} : {value: row}))
      : [];

    return {rows};
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

  private buildTableInfo(metadata: EntitySqlMetadata | undefined): {tableRef: string; alias: string} | undefined {
    if (!metadata?.tableName) return undefined;
    const alias = 't';
    const schemaPart = metadata.schema ? `${quoteIdentifier(metadata.schema)}.` : '';
    const tableRef = `${schemaPart}${quoteIdentifier(metadata.tableName)}`;
    return {tableRef, alias};
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
      const columnName = columnMap[property] ??
        (propertyDef?.postgresql as {columnName?: string} | undefined)?.columnName ??
        propertyDef?.name ??
        property;
      const quoted = `${tableAlias}.${quoteIdentifier(columnName)}`;
      return {
        column: quoted,
        rawColumn: quoteIdentifier(columnName),
      };
    };
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
    items: Array<{field: string; direction: 'asc' | 'desc'}> | undefined,
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
  ): {clause: string; params: unknown[]} | undefined {
    if (!where || !Object.keys(where).length) return undefined;
    const params: unknown[] = [];
    const clause = this.visitWhereNode(where as AnyObject, resolver, params);
    if (!clause) return undefined;
    return {clause, params};
  }

  private visitWhereNode(
    node: AnyObject,
    resolver: (field: string) => ColumnResolution | undefined,
    params: unknown[],
  ): string | undefined {
    if (Array.isArray(node)) {
      const parts = node
        .map(entry => this.visitWhereNode(entry, resolver, params))
        .filter(Boolean) as string[];
      if (!parts.length) return undefined;
      return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
    }
    const clauses: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'and' || key === 'or') {
        const arrayVal = Array.isArray(value) ? value : [value];
        const subParts = arrayVal
          .map(entry => this.visitWhereNode(entry as AnyObject, resolver, params))
          .filter(Boolean) as string[];
        if (!subParts.length) continue;
        const joined = subParts.length === 1 ? subParts[0] : `(${subParts.join(` ${key.toUpperCase()} `)})`;
        clauses.push(joined);
        continue;
      }
      const resolved = resolver(key);
      if (!resolved) return undefined;
      const condition = this.buildPropertyCondition(resolved.column, value, params);
      if (!condition) return undefined;
      clauses.push(condition);
    }
    if (!clauses.length) return undefined;
    return clauses.length === 1 ? clauses[0] : clauses.map(part => `(${part})`).join(' AND ');
  }

  private buildPropertyCondition(
    column: string,
    value: unknown,
    params: unknown[],
  ): string | undefined {
    if (value == null || typeof value !== 'object' || value instanceof Date) {
      if (value === null) {
        return `${column} IS NULL`;
      }
      params.push(value);
      return `${column} = $${params.length}`;
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
          fragments.push(`${column} = $${params.length}`);
          break;
        }
        case 'neq': {
          if (operand === null) {
            fragments.push(`${column} IS NOT NULL`);
            break;
          }
          params.push(operand);
          fragments.push(`${column} <> $${params.length}`);
          break;
        }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          params.push(operand);
          const opMap: Record<string, string> = {gt: '>', gte: '>=', lt: '<', lte: '<='};
          fragments.push(`${column} ${opMap[operator]} $${params.length}`);
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
            placeholders.push(`$${params.length}`);
          }
          const keyword = operator === 'inq' ? 'IN' : 'NOT IN';
          fragments.push(`${column} ${keyword} (${placeholders.join(', ')})`);
          break;
        }
        case 'between': {
          if (!Array.isArray(operand) || operand.length !== 2) return undefined;
          params.push(operand[0]);
          params.push(operand[1]);
          fragments.push(`${column} BETWEEN $${params.length - 1} AND $${params.length}`);
          break;
        }
        case 'like':
        case 'ilike': {
          params.push(operand);
          const keyword = operator === 'ilike' ? 'ILIKE' : 'LIKE';
          fragments.push(`${column} ${keyword} $${params.length}`);
          break;
        }
        default:
          return undefined;
      }
    }
    if (!fragments.length) return undefined;
    return fragments.length === 1 ? fragments[0] : `(${fragments.join(' AND ')})`;
  }
}

function quoteIdentifier(identifier: string): string {
  const safe = identifier.replace(/"/g, '""');
  return `"${safe}"`;
}

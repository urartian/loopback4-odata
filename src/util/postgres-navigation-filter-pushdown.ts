import { AnyObject, Entity, ModelDefinition, Where, juggler } from '@loopback/repository';
import { inferSqlMetadata } from './sql-metadata';
import {
  resolveNavigationPath,
  NavigationPathError,
  ResolvedNavigationPath,
} from './navigation-path';
import { ParsedExpression } from '../services/odata-query-parser.service';
import { supportsPostgresLambdaPushdown } from './postgres-lambda-pushdown';

export interface NavigationFilterPushdownBuildResult {
  sql: string;
  params: unknown[];
  idProperty: string;
}

export interface NavigationFilterPushdownCountBuildResult {
  sql: string;
  params: unknown[];
}

export interface NavigationFilterPushdownDecline {
  declineReason: string;
}

interface SqlMetadata {
  tableName: string;
  schema?: string;
  columnMap: Record<string, string>;
}

function quoteIdentifier(identifier: string): string {
  const safe = identifier.replace(/"/g, '""');
  return `"${safe}"`;
}

function buildTableRef(metadata: SqlMetadata): string {
  const schemaPart = metadata.schema ? `${quoteIdentifier(metadata.schema)}.` : '';
  return `${schemaPart}${quoteIdentifier(metadata.tableName)}`;
}

function getModelDefinition(modelCtor: typeof Entity): ModelDefinition | undefined {
  return (modelCtor as typeof Entity & { definition?: ModelDefinition }).definition;
}

function getSingleIdProperty(modelCtor: typeof Entity): string | undefined {
  const definition = getModelDefinition(modelCtor);
  const ids = definition?.idProperties?.() ?? [];
  if (Array.isArray(ids) && ids.length === 1) return ids[0];
  return undefined;
}

function resolveColumn(
  modelCtor: typeof Entity,
  property: string,
  dataSource: juggler.DataSource,
  cache: Map<typeof Entity, SqlMetadata>,
): string | undefined {
  if (!property) return undefined;
  if (property.includes('/')) return undefined;
  if (property.includes('.')) return undefined;
  if (property === '__proto__' || property === 'prototype' || property === 'constructor')
    return undefined;

  let meta = cache.get(modelCtor);
  if (!meta) {
    const inferred = inferSqlMetadata(modelCtor, dataSource);
    if (!inferred?.tableName) return undefined;
    meta = {
      tableName: inferred.tableName,
      schema: inferred.schema,
      columnMap: inferred.columnMap ?? {},
    };
    cache.set(modelCtor, meta);
  }
  const columnName = meta.columnMap[property] ?? property;
  return quoteIdentifier(columnName);
}

type WhereBuildContext = {
  dataSource: juggler.DataSource;
  modelCtor: typeof Entity;
  tableAlias: string;
  metaCache: Map<typeof Entity, SqlMetadata>;
};

function placeholder(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function translateWhere(
  where: Where<AnyObject> | undefined,
  ctx: WhereBuildContext,
  params: unknown[],
): string | undefined {
  if (!where || typeof where !== 'object') return undefined;
  const entries = Object.entries(where as AnyObject);
  if (!entries.length) return undefined;

  const clauses: string[] = [];
  for (const [key, value] of entries) {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(value)) return undefined;
      const start = params.length;
      const inner: string[] = [];
      for (const item of value) {
        const sql = translateWhere(item as Where<AnyObject>, ctx, params);
        if (!sql) {
          params.length = start;
          return undefined;
        }
        inner.push(sql);
      }
      if (!inner.length) {
        params.length = start;
        return undefined;
      }
      const joined = inner.map((sql) => `(${sql})`).join(` ${key.toUpperCase()} `);
      clauses.push(joined);
      continue;
    }
    if (key === 'not') {
      const start = params.length;
      const inner = translateWhere(value as Where<AnyObject>, ctx, params);
      if (!inner) {
        params.length = start;
        return undefined;
      }
      clauses.push(`NOT (${inner})`);
      continue;
    }

    const column = resolveColumn(ctx.modelCtor, key, ctx.dataSource, ctx.metaCache);
    if (!column) return undefined;
    const columnExpr = `${ctx.tableAlias}.${column}`;

    if (value === null) {
      clauses.push(`${columnExpr} IS NULL`);
      continue;
    }
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
      clauses.push(`${columnExpr} = ${placeholder(params, value)}`);
      continue;
    }

    const ops = value as AnyObject;
    const opClauses: string[] = [];
    const caseInsensitive =
      typeof ops.options === 'string' ? ops.options.toLowerCase().includes('i') : false;

    for (const [op, operand] of Object.entries(ops)) {
      if (op === 'options') continue;
      switch (op) {
        case 'eq': {
          if (operand === null) opClauses.push(`${columnExpr} IS NULL`);
          else opClauses.push(`${columnExpr} = ${placeholder(params, operand)}`);
          break;
        }
        case 'neq': {
          if (operand === null) opClauses.push(`${columnExpr} IS NOT NULL`);
          else opClauses.push(`${columnExpr} <> ${placeholder(params, operand)}`);
          break;
        }
        case 'gt':
          opClauses.push(`${columnExpr} > ${placeholder(params, operand)}`);
          break;
        case 'gte':
          opClauses.push(`${columnExpr} >= ${placeholder(params, operand)}`);
          break;
        case 'lt':
          opClauses.push(`${columnExpr} < ${placeholder(params, operand)}`);
          break;
        case 'lte':
          opClauses.push(`${columnExpr} <= ${placeholder(params, operand)}`);
          break;
        case 'inq':
        case 'nin': {
          if (!Array.isArray(operand)) return undefined;
          if (!operand.length) {
            opClauses.push(op === 'inq' ? 'FALSE' : 'TRUE');
            break;
          }
          const placeholders = operand.map((entry) => placeholder(params, entry)).join(', ');
          const comparator = op === 'inq' ? 'IN' : 'NOT IN';
          opClauses.push(`${columnExpr} ${comparator} (${placeholders})`);
          break;
        }
        case 'like':
        case 'nlike': {
          if (operand === undefined) return undefined;
          if (operand === null) return undefined;
          const likeKeyword = caseInsensitive ? 'ILIKE' : 'LIKE';
          const not = op === 'nlike' ? 'NOT ' : '';
          opClauses.push(
            `${columnExpr} ${not}${likeKeyword} ${placeholder(params, operand)} ESCAPE E'\\\\'`,
          );
          break;
        }
        default:
          return undefined;
      }
    }

    if (!opClauses.length) return undefined;
    clauses.push(
      opClauses.length === 1 ? opClauses[0] : opClauses.map((c) => `(${c})`).join(' AND '),
    );
  }

  if (!clauses.length) return undefined;
  return clauses.length === 1 ? clauses[0] : clauses.map((c) => `(${c})`).join(' AND ');
}

type SqlFragment = { sql: string; joinCount: number };

function normalizeOrder(order?: string | string[]): string[] {
  if (!order) return [];
  if (Array.isArray(order)) return order;
  return [order];
}

function isSupportedNavPath(
  resolved: ResolvedNavigationPath,
): { joins: ResolvedNavigationPath['joins']; property: string } | undefined {
  if (!resolved.joins.length) return undefined;
  if (!resolved.propertyPath) return undefined;
  if (resolved.propertyPath.includes('/')) return undefined;
  if (resolved.joins.some((j) => j.relationType === 'hasMany')) return undefined;
  return { joins: resolved.joins, property: resolved.propertyPath };
}

function translateNavPredicateExpression(options: {
  modelCtor: typeof Entity;
  expr: ParsedExpression;
  dataSource: juggler.DataSource;
  metaCache: Map<typeof Entity, SqlMetadata>;
  params: unknown[];
  rootAlias: string;
  maxDepth: number;
}): SqlFragment | undefined {
  const { expr } = options;
  switch (expr.operator) {
    case 'comparison': {
      if (!expr.field.includes('/')) return undefined;
      const start = options.params.length;
      let resolved: ResolvedNavigationPath;
      try {
        resolved = resolveNavigationPath(options.modelCtor, expr.field, {
          maxDepth: options.maxDepth,
        });
      } catch (error) {
        options.params.length = start;
        if (error instanceof NavigationPathError) return undefined;
        throw error;
      }

      const supported = isSupportedNavPath(resolved);
      if (!supported) {
        options.params.length = start;
        return undefined;
      }

      const joinSegments = supported.joins;
      const property = supported.property;

      const aliases = joinSegments.map((_j, idx) => `t${idx + 1}`);
      const first = joinSegments[0]!;
      const firstAlias = aliases[0]!;
      const firstTableMetaRaw = inferSqlMetadata(first.targetModel, options.dataSource);
      if (!firstTableMetaRaw?.tableName) {
        options.params.length = start;
        return undefined;
      }
      options.metaCache.set(first.targetModel, {
        tableName: firstTableMetaRaw.tableName,
        schema: firstTableMetaRaw.schema,
        columnMap: firstTableMetaRaw.columnMap ?? {},
      });

      const from = `${buildTableRef({
        tableName: firstTableMetaRaw.tableName,
        schema: firstTableMetaRaw.schema,
        columnMap: firstTableMetaRaw.columnMap ?? {},
      })} AS ${firstAlias}`;

      const joinClauses: string[] = [];
      for (let i = 1; i < joinSegments.length; i++) {
        const seg = joinSegments[i]!;
        const prev = joinSegments[i - 1]!;
        const alias = aliases[i]!;
        const prevAlias = aliases[i - 1]!;
        const metaRaw = inferSqlMetadata(seg.targetModel, options.dataSource);
        if (!metaRaw?.tableName) {
          options.params.length = start;
          return undefined;
        }
        options.metaCache.set(seg.targetModel, {
          tableName: metaRaw.tableName,
          schema: metaRaw.schema,
          columnMap: metaRaw.columnMap ?? {},
        });

        const sourceColumn = resolveColumn(
          prev.targetModel,
          seg.sourceKey,
          options.dataSource,
          options.metaCache,
        );
        const targetColumn = resolveColumn(
          seg.targetModel,
          seg.targetKey,
          options.dataSource,
          options.metaCache,
        );
        if (!sourceColumn || !targetColumn) {
          options.params.length = start;
          return undefined;
        }
        joinClauses.push(
          `JOIN ${buildTableRef({
            tableName: metaRaw.tableName,
            schema: metaRaw.schema,
            columnMap: metaRaw.columnMap ?? {},
          })} AS ${alias} ON ${alias}.${targetColumn} = ${prevAlias}.${sourceColumn}`,
        );
      }

      const rootSourceColumn = resolveColumn(
        first.sourceModel,
        first.sourceKey,
        options.dataSource,
        options.metaCache,
      );
      const rootTargetColumn = resolveColumn(
        first.targetModel,
        first.targetKey,
        options.dataSource,
        options.metaCache,
      );
      if (!rootSourceColumn || !rootTargetColumn) {
        options.params.length = start;
        return undefined;
      }

      const lastJoin = joinSegments[joinSegments.length - 1]!;
      const lastAlias = aliases[aliases.length - 1]!;
      const propertyColumn = resolveColumn(
        lastJoin.targetModel,
        property,
        options.dataSource,
        options.metaCache,
      );
      if (!propertyColumn) {
        options.params.length = start;
        return undefined;
      }
      const columnExpr = `${lastAlias}.${propertyColumn}`;

      const whereClauses: string[] = [];
      whereClauses.push(
        `${firstAlias}.${rootTargetColumn} = ${options.rootAlias}.${rootSourceColumn}`,
      );

      const comparatorMap: Record<string, string> = {
        eq: '=',
        neq: '<>',
        gt: '>',
        gte: '>=',
        lt: '<',
        lte: '<=',
      };

      if (expr.comparator === 'inq' || expr.comparator === 'nin') {
        if (!Array.isArray(expr.value)) {
          options.params.length = start;
          return undefined;
        }
        const values = expr.value;
        const hasNull = values.some((v) => v === null);
        const nonNull = values.filter((v) => v !== null);
        const op = expr.comparator === 'inq' ? 'IN' : 'NOT IN';
        const nullSql =
          expr.comparator === 'inq'
            ? hasNull
              ? `${columnExpr} IS NULL`
              : undefined
            : hasNull
              ? `${columnExpr} IS NOT NULL`
              : undefined;
        const listSql = nonNull.length
          ? `${columnExpr} ${op} (${nonNull.map((v) => placeholder(options.params, v)).join(', ')})`
          : undefined;
        if (expr.comparator === 'inq') {
          if (nullSql && listSql) whereClauses.push(`(${nullSql} OR ${listSql})`);
          else if (nullSql) whereClauses.push(nullSql);
          else if (listSql) whereClauses.push(listSql);
          else whereClauses.push('FALSE');
        } else {
          if (nullSql && listSql) whereClauses.push(`(${nullSql} AND ${listSql})`);
          else if (nullSql) whereClauses.push(nullSql);
          else if (listSql) whereClauses.push(listSql);
          else whereClauses.push('TRUE');
        }
      } else if (expr.value === null) {
        if (expr.comparator === 'eq') whereClauses.push(`${columnExpr} IS NULL`);
        else if (expr.comparator === 'neq') whereClauses.push(`${columnExpr} IS NOT NULL`);
        else {
          options.params.length = start;
          return undefined;
        }
      } else {
        const comparator = comparatorMap[expr.comparator];
        if (!comparator) {
          options.params.length = start;
          return undefined;
        }
        whereClauses.push(`${columnExpr} ${comparator} ${placeholder(options.params, expr.value)}`);
      }

      const whereSql = whereClauses.length
        ? `WHERE ${whereClauses.map((c) => `(${c})`).join(' AND ')}`
        : '';

      return {
        sql: `EXISTS (SELECT 1 FROM ${from} ${joinClauses.join(' ')} ${whereSql})`,
        joinCount: joinSegments.length,
      };
    }
    case 'logical': {
      const start = options.params.length;
      const parts: string[] = [];
      let joinCount = 0;
      for (const child of expr.expressions) {
        const built = translateNavPredicateExpression({ ...options, expr: child });
        if (!built) {
          options.params.length = start;
          return undefined;
        }
        parts.push(built.sql);
        joinCount += built.joinCount;
      }
      if (!parts.length) {
        options.params.length = start;
        return undefined;
      }
      const joiner = expr.type === 'and' ? 'AND' : 'OR';
      return {
        sql: parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(` ${joiner} `),
        joinCount,
      };
    }
    case 'not': {
      const inner = translateNavPredicateExpression({ ...options, expr: expr.expr });
      if (!inner) return undefined;
      return { sql: `NOT (${inner.sql})`, joinCount: inner.joinCount };
    }
    default:
      return undefined;
  }
}

function containsNavPaths(expr: ParsedExpression): boolean {
  switch (expr.operator) {
    case 'comparison':
      return typeof expr.field === 'string' && expr.field.includes('/');
    case 'logical':
      return expr.expressions.some(containsNavPaths);
    case 'not':
      return containsNavPaths(expr.expr);
    case 'lambda':
      return containsNavPaths(expr.predicate);
    default:
      return false;
  }
}

function normalizeMaxJoinCount(maxJoinCount: unknown): number {
  const n = Number(maxJoinCount);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 8;
}

export function buildPostgresNavigationFilterIdQuery(options: {
  dataSource: juggler.DataSource;
  modelCtor: typeof Entity;
  expression: ParsedExpression;
  where?: Where<AnyObject>;
  order?: string | string[];
  offset?: number;
  limit?: number;
  maxDepth?: number;
  maxJoinCount?: number;
}): NavigationFilterPushdownBuildResult | NavigationFilterPushdownDecline {
  if (!supportsPostgresLambdaPushdown(options.dataSource)) {
    return { declineReason: 'non-postgres' };
  }
  if (!containsNavPaths(options.expression)) {
    return { declineReason: 'no-navigation-paths' };
  }

  const idProperty = getSingleIdProperty(options.modelCtor);
  if (!idProperty) return { declineReason: 'composite-or-missing-id' };

  const metaCache = new Map<typeof Entity, SqlMetadata>();
  const baseMetaRaw = inferSqlMetadata(options.modelCtor, options.dataSource);
  if (!baseMetaRaw?.tableName) return { declineReason: 'missing-sql-metadata' };
  metaCache.set(options.modelCtor, {
    tableName: baseMetaRaw.tableName,
    schema: baseMetaRaw.schema,
    columnMap: baseMetaRaw.columnMap ?? {},
  });

  const rootAlias = 'r';
  const idColumn = resolveColumn(options.modelCtor, idProperty, options.dataSource, metaCache);
  if (!idColumn) return { declineReason: 'id-column-resolution' };

  const params: unknown[] = [];
  const whereCtx: WhereBuildContext = {
    dataSource: options.dataSource,
    modelCtor: options.modelCtor,
    tableAlias: rootAlias,
    metaCache,
  };

  const baseWhereSql = options.where ? translateWhere(options.where, whereCtx, params) : undefined;
  if (options.where && !baseWhereSql) return { declineReason: 'unsupported-root-where' };

  const start = params.length;
  const maxDepth =
    typeof options.maxDepth === 'number' && options.maxDepth > 0 ? options.maxDepth : 5;
  const maxJoinCount = normalizeMaxJoinCount(options.maxJoinCount);
  const navBuilt = translateNavPredicateExpression({
    modelCtor: options.modelCtor,
    expr: options.expression,
    dataSource: options.dataSource,
    metaCache,
    params,
    rootAlias,
    maxDepth,
  });
  if (!navBuilt) {
    params.length = start;
    return { declineReason: 'unsupported-navigation-filter' };
  }
  if (navBuilt.joinCount > maxJoinCount) {
    params.length = start;
    return { declineReason: 'pushdown-join-count-exceeded' };
  }

  const whereParts = [baseWhereSql, navBuilt.sql].filter(Boolean) as string[];
  const whereClause = whereParts.length
    ? `WHERE ${whereParts.map((p) => `(${p})`).join(' AND ')}`
    : '';

  const orderSqlParts: string[] = [];
  for (const clause of normalizeOrder(options.order)) {
    const trimmed = String(clause).trim();
    if (!trimmed) continue;
    const [fieldToken, dirToken] = trimmed.split(/\s+/);
    const direction = (dirToken ?? 'ASC').toUpperCase();
    if (direction !== 'ASC' && direction !== 'DESC') return { declineReason: 'unsupported-order' };
    const col = resolveColumn(options.modelCtor, fieldToken, options.dataSource, metaCache);
    if (!col) return { declineReason: 'unsupported-order' };
    orderSqlParts.push(`${rootAlias}.${col} ${direction}`);
  }
  const orderClause = orderSqlParts.length ? `ORDER BY ${orderSqlParts.join(', ')}` : '';

  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : undefined;
  const offset =
    typeof options.offset === 'number' && Number.isFinite(options.offset) && options.offset > 0
      ? Math.floor(options.offset)
      : undefined;

  const limitClause = limit ? `LIMIT ${limit}` : '';
  const offsetClause = offset ? `OFFSET ${offset}` : '';

  const sql =
    `SELECT ${rootAlias}.${idColumn} AS ${quoteIdentifier(idProperty)} FROM ${buildTableRef({
      tableName: baseMetaRaw.tableName,
      schema: baseMetaRaw.schema,
      columnMap: baseMetaRaw.columnMap ?? {},
    })} AS ${rootAlias} ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim();

  return { sql, params, idProperty };
}

export function buildPostgresNavigationFilterCountQuery(options: {
  dataSource: juggler.DataSource;
  modelCtor: typeof Entity;
  expression: ParsedExpression;
  where?: Where<AnyObject>;
  maxDepth?: number;
  maxJoinCount?: number;
}): NavigationFilterPushdownCountBuildResult | NavigationFilterPushdownDecline {
  if (!supportsPostgresLambdaPushdown(options.dataSource)) {
    return { declineReason: 'non-postgres' };
  }
  if (!containsNavPaths(options.expression)) {
    return { declineReason: 'no-navigation-paths' };
  }

  const metaCache = new Map<typeof Entity, SqlMetadata>();
  const baseMetaRaw = inferSqlMetadata(options.modelCtor, options.dataSource);
  if (!baseMetaRaw?.tableName) return { declineReason: 'missing-sql-metadata' };
  metaCache.set(options.modelCtor, {
    tableName: baseMetaRaw.tableName,
    schema: baseMetaRaw.schema,
    columnMap: baseMetaRaw.columnMap ?? {},
  });

  const rootAlias = 'r';
  const params: unknown[] = [];
  const whereCtx: WhereBuildContext = {
    dataSource: options.dataSource,
    modelCtor: options.modelCtor,
    tableAlias: rootAlias,
    metaCache,
  };

  const baseWhereSql = options.where ? translateWhere(options.where, whereCtx, params) : undefined;
  if (options.where && !baseWhereSql) return { declineReason: 'unsupported-root-where' };

  const start = params.length;
  const maxDepth =
    typeof options.maxDepth === 'number' && options.maxDepth > 0 ? options.maxDepth : 5;
  const maxJoinCount = normalizeMaxJoinCount(options.maxJoinCount);
  const navBuilt = translateNavPredicateExpression({
    modelCtor: options.modelCtor,
    expr: options.expression,
    dataSource: options.dataSource,
    metaCache,
    params,
    rootAlias,
    maxDepth,
  });
  if (!navBuilt) {
    params.length = start;
    return { declineReason: 'unsupported-navigation-filter' };
  }
  if (navBuilt.joinCount > maxJoinCount) {
    params.length = start;
    return { declineReason: 'pushdown-join-count-exceeded' };
  }

  const whereParts = [baseWhereSql, navBuilt.sql].filter(Boolean) as string[];
  const whereClause = whereParts.length
    ? `WHERE ${whereParts.map((p) => `(${p})`).join(' AND ')}`
    : '';

  const sql = `SELECT COUNT(*) AS count FROM ${buildTableRef({
    tableName: baseMetaRaw.tableName,
    schema: baseMetaRaw.schema,
    columnMap: baseMetaRaw.columnMap ?? {},
  })} AS ${rootAlias} ${whereClause}`.trim();

  return { sql, params };
}

import { AnyObject, Entity, ModelDefinition, Where, juggler } from '@loopback/repository';
import { escapeLikeLiteral } from './like-escaping';
import { inferSqlMetadata } from './sql-metadata';
import {
  resolveNavigationPath,
  NavigationPathError,
  ResolvedNavigationPath,
} from './navigation-path';
import { LambdaExpression, ParsedExpression } from '../services/odata-query-parser.service';

export interface LambdaPushdownBuildResult {
  sql: string;
  params: unknown[];
  idProperty: string;
}

export interface LambdaPushdownDecline {
  declineReason: string;
}

export function supportsPostgresLambdaPushdown(
  dataSource: juggler.DataSource | undefined,
): boolean {
  const connectorName =
    dataSource?.connector?.name ??
    (dataSource?.connector as AnyObject | undefined)?.settings?.name ??
    '';
  if (!connectorName) return false;
  if (typeof dataSource?.execute !== 'function') return false;
  return connectorName.toLowerCase().includes('postgres');
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
    const useInsensitiveLike = typeof ops.options === 'string' && ops.options.toLowerCase() === 'i';

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
        case 'like':
        case 'nlike': {
          if (typeof operand !== 'string') return undefined;
          const comparator = useInsensitiveLike
            ? op === 'like'
              ? 'ILIKE'
              : 'NOT ILIKE'
            : op === 'like'
              ? 'LIKE'
              : 'NOT LIKE';
          opClauses.push(
            `${columnExpr} ${comparator} ${placeholder(params, operand)} ESCAPE '\\\\'`,
          );
          break;
        }
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
        case 'between': {
          if (!Array.isArray(operand) || operand.length !== 2) return undefined;
          const low = placeholder(params, operand[0]);
          const high = placeholder(params, operand[1]);
          opClauses.push(`${columnExpr} BETWEEN ${low} AND ${high}`);
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

type PredicateBuildContext = {
  dataSource: juggler.DataSource;
  rootModel: typeof Entity;
  rootAlias: string;
  lambdaModel: typeof Entity;
  lambdaAliasToken: string;
  lambdaTableAlias: string;
  metaCache: Map<typeof Entity, SqlMetadata>;
};

function resolvePredicateField(
  field: string,
  ctx: PredicateBuildContext,
): { sql: string } | undefined {
  if (!field) return undefined;
  const aliasPrefix = `${ctx.lambdaAliasToken}/`;
  const isLambdaField = field.startsWith(aliasPrefix);
  const raw = isLambdaField ? field.slice(aliasPrefix.length) : field;
  const model = isLambdaField ? ctx.lambdaModel : ctx.rootModel;
  const alias = isLambdaField ? ctx.lambdaTableAlias : ctx.rootAlias;
  const column = resolveColumn(model, raw, ctx.dataSource, ctx.metaCache);
  if (!column) return undefined;
  return { sql: `${alias}.${column}` };
}

function translatePredicateExpression(
  expr: ParsedExpression,
  ctx: PredicateBuildContext,
  params: unknown[],
): string | undefined {
  switch (expr.operator) {
    case 'comparison': {
      const resolved = resolvePredicateField(expr.field, ctx);
      if (!resolved) return undefined;
      const comparatorMap: Record<string, string> = {
        eq: '=',
        neq: '<>',
        gt: '>',
        gte: '>=',
        lt: '<',
        lte: '<=',
      };
      const comparator = comparatorMap[expr.comparator];
      if (!comparator) return undefined;
      if (expr.value === null) {
        if (expr.comparator === 'eq') return `${resolved.sql} IS NULL`;
        if (expr.comparator === 'neq') return `${resolved.sql} IS NOT NULL`;
        return undefined;
      }
      return `${resolved.sql} ${comparator} ${placeholder(params, expr.value)}`;
    }
    case 'logical': {
      const start = params.length;
      const parts: string[] = [];
      for (const child of expr.expressions) {
        const sql = translatePredicateExpression(child, ctx, params);
        if (!sql) {
          params.length = start;
          return undefined;
        }
        parts.push(sql);
      }
      if (!parts.length) {
        params.length = start;
        return undefined;
      }
      const joiner = expr.type === 'and' ? 'AND' : 'OR';
      return parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(` ${joiner} `);
    }
    case 'not': {
      const inner = translatePredicateExpression(expr.expr, ctx, params);
      if (!inner) return undefined;
      return `NOT (${inner})`;
    }
    case 'function': {
      if (expr.name !== 'contains' && expr.name !== 'startswith' && expr.name !== 'endswith') {
        return undefined;
      }
      const resolved = resolvePredicateField(expr.field, ctx);
      if (!resolved) return undefined;
      const value = expr.args?.[0];
      if (typeof value !== 'string') return undefined;
      const escaped = escapeLikeLiteral(value);
      const pattern =
        expr.name === 'contains'
          ? `%${escaped}%`
          : expr.name === 'startswith'
            ? `${escaped}%`
            : `%${escaped}`;
      const comparator = expr.caseInsensitive ? 'ILIKE' : 'LIKE';
      const negated = expr.negated === true ? 'NOT ' : '';
      return `${resolved.sql} ${negated}${comparator} ${placeholder(params, pattern)} ESCAPE '\\\\'`;
    }
    default:
      return undefined;
  }
}

function buildLambdaExistsClause(
  rootModel: typeof Entity,
  rootAlias: string,
  lambda: LambdaExpression,
  dataSource: juggler.DataSource,
  metaCache: Map<typeof Entity, SqlMetadata>,
  params: unknown[],
): string | undefined {
  const path = lambda.path.join('/');
  let resolved: ResolvedNavigationPath;
  try {
    resolved = resolveNavigationPath(rootModel, path, { maxDepth: 5 });
  } catch (err) {
    if (err instanceof NavigationPathError) return undefined;
    return undefined;
  }

  if (!resolved.joins.length) return undefined;
  if (resolved.propertyPath) return undefined;

  const joinSegments = resolved.joins;
  const lastJoin = joinSegments[joinSegments.length - 1];
  const lambdaModel = lastJoin?.targetModel;
  if (!lambdaModel) return undefined;

  const lambdaTableMetaRaw = inferSqlMetadata(lambdaModel, dataSource);
  if (!lambdaTableMetaRaw?.tableName) return undefined;
  const lambdaTableMeta: SqlMetadata = {
    tableName: lambdaTableMetaRaw.tableName,
    schema: lambdaTableMetaRaw.schema,
    columnMap: lambdaTableMetaRaw.columnMap ?? {},
  };
  metaCache.set(lambdaModel, lambdaTableMeta);

  const aliases = joinSegments.map((_, index) => `t${index + 1}`);
  const lastAlias = aliases[aliases.length - 1]!;

  const joinClauses: string[] = [];
  const whereClauses: string[] = [];

  const first = joinSegments[0]!;
  const firstAlias = aliases[0]!;
  const firstTableMetaRaw = inferSqlMetadata(first.targetModel, dataSource);
  if (!firstTableMetaRaw?.tableName) return undefined;
  metaCache.set(first.targetModel, {
    tableName: firstTableMetaRaw.tableName,
    schema: firstTableMetaRaw.schema,
    columnMap: firstTableMetaRaw.columnMap ?? {},
  });
  const firstFrom = `${buildTableRef({
    tableName: firstTableMetaRaw.tableName,
    schema: firstTableMetaRaw.schema,
    columnMap: firstTableMetaRaw.columnMap ?? {},
  })} AS ${firstAlias}`;

  const rootKeyColumn = resolveColumn(first.sourceModel, first.sourceKey, dataSource, metaCache);
  const firstTargetColumn = resolveColumn(
    first.targetModel,
    first.targetKey,
    dataSource,
    metaCache,
  );
  if (!rootKeyColumn || !firstTargetColumn) return undefined;

  if (first.relationType === 'belongsTo') {
    whereClauses.push(`${rootAlias}.${rootKeyColumn} = ${firstAlias}.${firstTargetColumn}`);
  } else {
    whereClauses.push(`${firstAlias}.${firstTargetColumn} = ${rootAlias}.${rootKeyColumn}`);
  }

  for (let i = 1; i < joinSegments.length; i++) {
    const segment = joinSegments[i]!;
    const sourceAlias = aliases[i - 1]!;
    const targetAlias = aliases[i]!;

    const targetMetaRaw = inferSqlMetadata(segment.targetModel, dataSource);
    if (!targetMetaRaw?.tableName) return undefined;
    metaCache.set(segment.targetModel, {
      tableName: targetMetaRaw.tableName,
      schema: targetMetaRaw.schema,
      columnMap: targetMetaRaw.columnMap ?? {},
    });
    const sourceKeyColumn = resolveColumn(
      segment.sourceModel,
      segment.sourceKey,
      dataSource,
      metaCache,
    );
    const targetKeyColumn = resolveColumn(
      segment.targetModel,
      segment.targetKey,
      dataSource,
      metaCache,
    );
    if (!sourceKeyColumn || !targetKeyColumn) return undefined;

    const tableRef = buildTableRef({
      tableName: targetMetaRaw.tableName,
      schema: targetMetaRaw.schema,
      columnMap: targetMetaRaw.columnMap ?? {},
    });

    const condition =
      segment.relationType === 'belongsTo'
        ? `${sourceAlias}.${sourceKeyColumn} = ${targetAlias}.${targetKeyColumn}`
        : `${targetAlias}.${targetKeyColumn} = ${sourceAlias}.${sourceKeyColumn}`;
    joinClauses.push(`JOIN ${tableRef} AS ${targetAlias} ON ${condition}`);
  }

  const predicateCtx: PredicateBuildContext = {
    dataSource,
    rootModel,
    rootAlias,
    lambdaModel,
    lambdaAliasToken: lambda.alias,
    lambdaTableAlias: lastAlias,
    metaCache,
  };
  const predicateSql = translatePredicateExpression(lambda.predicate, predicateCtx, params);
  if (!predicateSql) return undefined;

  if (lambda.type === 'any') {
    whereClauses.push(predicateSql);
    const whereSql = whereClauses.length
      ? `WHERE ${whereClauses.map((c) => `(${c})`).join(' AND ')}`
      : '';
    return `EXISTS (SELECT 1 FROM ${firstFrom} ${joinClauses.join(' ')} ${whereSql})`;
  }

  // all: NOT EXISTS (... WHERE predicate IS NOT TRUE)
  whereClauses.push(`(${predicateSql}) IS NOT TRUE`);
  const whereSql = whereClauses.length
    ? `WHERE ${whereClauses.map((c) => `(${c})`).join(' AND ')}`
    : '';
  return `NOT EXISTS (SELECT 1 FROM ${firstFrom} ${joinClauses.join(' ')} ${whereSql})`;
}

export function buildPostgresLambdaIdQuery(options: {
  dataSource: juggler.DataSource;
  modelCtor: typeof Entity;
  lambdas: LambdaExpression[];
  where?: Where<AnyObject>;
  order?: string | string[];
  offset?: number;
  limit?: number;
}): LambdaPushdownBuildResult | LambdaPushdownDecline {
  const { dataSource, modelCtor, lambdas } = options;
  if (!supportsPostgresLambdaPushdown(dataSource)) {
    return { declineReason: 'non-postgres' };
  }
  if (!lambdas.length) {
    return { declineReason: 'no-lambdas' };
  }

  const idProperty = getSingleIdProperty(modelCtor);
  if (!idProperty) {
    return { declineReason: 'composite-or-missing-id' };
  }

  const metaCache = new Map<typeof Entity, SqlMetadata>();
  const baseMetaRaw = inferSqlMetadata(modelCtor, dataSource);
  if (!baseMetaRaw?.tableName) {
    return { declineReason: 'missing-sql-metadata' };
  }
  metaCache.set(modelCtor, {
    tableName: baseMetaRaw.tableName,
    schema: baseMetaRaw.schema,
    columnMap: baseMetaRaw.columnMap ?? {},
  });

  const rootAlias = 'r';
  const idColumn = resolveColumn(modelCtor, idProperty, dataSource, metaCache);
  if (!idColumn) {
    return { declineReason: 'id-column-resolution' };
  }

  const params: unknown[] = [];
  const whereCtx: WhereBuildContext = {
    dataSource,
    modelCtor,
    tableAlias: rootAlias,
    metaCache,
  };

  const baseWhereSql = options.where ? translateWhere(options.where, whereCtx, params) : undefined;
  if (options.where && !baseWhereSql) {
    return { declineReason: 'unsupported-root-where' };
  }

  const lambdaClauses: string[] = [];
  for (const lambda of lambdas) {
    const start = params.length;
    const clause = buildLambdaExistsClause(
      modelCtor,
      rootAlias,
      lambda,
      dataSource,
      metaCache,
      params,
    );
    if (!clause) {
      params.length = start;
      return { declineReason: 'unsupported-lambda' };
    }
    lambdaClauses.push(clause);
  }

  const whereParts = [baseWhereSql, ...lambdaClauses].filter(Boolean) as string[];
  const whereClause = whereParts.length
    ? `WHERE ${whereParts.map((p) => `(${p})`).join(' AND ')}`
    : '';

  const orderRaw = options.order;
  const orderList = Array.isArray(orderRaw) ? orderRaw : orderRaw ? [orderRaw] : [];
  const orderSqlParts: string[] = [];
  for (const clause of orderList) {
    const trimmed = String(clause).trim();
    if (!trimmed) continue;
    const [fieldToken, dirToken] = trimmed.split(/\s+/);
    const direction = (dirToken ?? 'ASC').toUpperCase();
    if (direction !== 'ASC' && direction !== 'DESC') return { declineReason: 'unsupported-order' };
    const col = resolveColumn(modelCtor, fieldToken, dataSource, metaCache);
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

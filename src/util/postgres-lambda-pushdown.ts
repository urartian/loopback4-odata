import { AnyObject, Entity, ModelDefinition, Where, juggler } from '@loopback/repository';
import { escapeLikeLiteral } from './like-escaping';
import { inferSqlMetadata } from './sql-metadata';
import {
  resolveNavigationPath,
  NavigationPathError,
  ResolvedNavigationPath,
} from './navigation-path';
import {
  FunctionArg,
  LambdaExpression,
  ParsedExpression,
} from '../services/odata-query-parser.service';
import { ODataErrorCodes } from '../odata-error-codes';

export interface LambdaPushdownBuildResult {
  sql: string;
  params: unknown[];
  idProperty: string;
}

export interface LambdaPushdownCountBuildResult {
  sql: string;
  params: unknown[];
}

export interface LambdaPushdownDecline {
  declineReason: string;
}

class LambdaPushdownBuildError extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'LambdaPushdownBuildError';
    this.reason = reason;
  }
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
            `${columnExpr} ${comparator} ${placeholder(params, operand)} ESCAPE E'\\\\'`,
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
          const hasNull = operand.some((entry) => entry === null);
          const nonNull = operand.filter((entry) => entry !== null);
          const comparator = op === 'inq' ? 'IN' : 'NOT IN';
          const listSql = nonNull.length
            ? `${columnExpr} ${comparator} (${nonNull.map((entry) => placeholder(params, entry)).join(', ')})`
            : undefined;
          const nullSql = hasNull
            ? op === 'inq'
              ? `${columnExpr} IS NULL`
              : `${columnExpr} IS NOT NULL`
            : undefined;
          if (op === 'inq') {
            if (nullSql && listSql) opClauses.push(`(${nullSql} OR ${listSql})`);
            else if (nullSql) opClauses.push(nullSql);
            else if (listSql) opClauses.push(listSql);
            else opClauses.push('FALSE');
          } else {
            if (nullSql && listSql) opClauses.push(`(${nullSql} AND ${listSql})`);
            else if (nullSql) opClauses.push(nullSql);
            else if (listSql) opClauses.push(listSql);
            else opClauses.push('TRUE');
          }
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
  bindings: Record<string, { modelCtor: typeof Entity; tableAlias: string }>;
  defaultBinding?: { modelCtor: typeof Entity; tableAlias: string };
  metaCache: Map<typeof Entity, SqlMetadata>;
  nextAlias: () => string;
};

type SqlFragment = { sql: string; joinCount: number };

function resolvePredicateField(
  field: string,
  ctx: PredicateBuildContext,
): { sql: string } | undefined {
  if (!field) return undefined;
  const parts = String(field).split('/');
  if (!parts.length) return undefined;
  if (parts.length === 1) {
    const binding = ctx.defaultBinding;
    if (!binding) return undefined;
    const column = resolveColumn(binding.modelCtor, parts[0]!, ctx.dataSource, ctx.metaCache);
    if (!column) return undefined;
    return { sql: `${binding.tableAlias}.${column}` };
  }

  const [aliasToken, ...rest] = parts;
  if (!aliasToken || rest.length === 0) return undefined;
  const binding = ctx.bindings[aliasToken];
  if (!binding) return undefined;
  const raw = rest.join('/');
  const column = resolveColumn(binding.modelCtor, raw, ctx.dataSource, ctx.metaCache);
  if (!column) return undefined;
  return { sql: `${binding.tableAlias}.${column}` };
}

function translatePredicateExpression(
  expr: ParsedExpression,
  ctx: PredicateBuildContext,
  params: unknown[],
): SqlFragment | undefined {
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
        if (expr.comparator === 'eq') return { sql: `${resolved.sql} IS NULL`, joinCount: 0 };
        if (expr.comparator === 'neq') return { sql: `${resolved.sql} IS NOT NULL`, joinCount: 0 };
        return undefined;
      }
      return {
        sql: `${resolved.sql} ${comparator} ${placeholder(params, expr.value)}`,
        joinCount: 0,
      };
    }
    case 'transformcmp': {
      const resolved = resolvePredicateField(expr.field, ctx);
      if (!resolved) return undefined;
      const leftSql =
        expr.transform === 'tolower' ? `LOWER(${resolved.sql})` : `UPPER(${resolved.sql})`;

      if (expr.value === null) {
        if (expr.comparator === 'eq') return { sql: `${leftSql} IS NULL`, joinCount: 0 };
        if (expr.comparator === 'neq') return { sql: `${leftSql} IS NOT NULL`, joinCount: 0 };
        return undefined;
      }
      if (typeof expr.value !== 'string') return undefined;
      if (expr.comparator === 'eq') {
        return { sql: `${leftSql} = ${placeholder(params, expr.value)}`, joinCount: 0 };
      }
      if (expr.comparator === 'neq') {
        return { sql: `${leftSql} <> ${placeholder(params, expr.value)}`, joinCount: 0 };
      }
      return undefined;
    }
    case 'logical': {
      const start = params.length;
      const parts: string[] = [];
      let joinCount = 0;
      for (const child of expr.expressions) {
        const built = translatePredicateExpression(child, ctx, params);
        if (!built) {
          params.length = start;
          return undefined;
        }
        parts.push(built.sql);
        joinCount += built.joinCount;
      }
      if (!parts.length) {
        params.length = start;
        return undefined;
      }
      const joiner = expr.type === 'and' ? 'AND' : 'OR';
      return {
        sql: parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(` ${joiner} `),
        joinCount,
      };
    }
    case 'not': {
      const inner = translatePredicateExpression(expr.expr, ctx, params);
      if (!inner) return undefined;
      return { sql: `NOT (${inner.sql})`, joinCount: inner.joinCount };
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
      const transformed =
        (expr as AnyObject)?.transform === 'tolower'
          ? `LOWER(${resolved.sql})`
          : (expr as AnyObject)?.transform === 'toupper'
            ? `UPPER(${resolved.sql})`
            : resolved.sql;
      const comparator =
        transformed !== resolved.sql ? 'LIKE' : expr.caseInsensitive ? 'ILIKE' : 'LIKE';
      const negated = expr.negated === true ? 'NOT ' : '';
      return {
        sql: `${transformed} ${negated}${comparator} ${placeholder(params, pattern)} ESCAPE E'\\\\'`,
        joinCount: 0,
      };
    }
    case 'stringfncmp': {
      const value = typeof expr.value === 'string' ? expr.value : undefined;
      if (value === undefined) return undefined;
      if (!expr.args?.length) return undefined;

      const resolveArg = (arg: FunctionArg): string | undefined => {
        if (arg.kind === 'literal') {
          return placeholder(params, arg.value);
        }
        const resolved = resolvePredicateField(arg.name, ctx);
        if (!resolved) return undefined;
        if (arg.transform === 'tolower') return `LOWER(${resolved.sql})`;
        if (arg.transform === 'toupper') return `UPPER(${resolved.sql})`;
        return resolved.sql;
      };

      if (expr.name === 'trim') {
        if (expr.args.length !== 1) return undefined;
        const operand = resolveArg(expr.args[0]!);
        if (!operand) return undefined;
        const comparator =
          expr.comparator === 'eq' ? '=' : expr.comparator === 'neq' ? '<>' : undefined;
        if (!comparator) return undefined;
        return {
          sql: `btrim(${operand}) ${comparator} ${placeholder(params, value)}`,
          joinCount: 0,
        };
      }
      if (expr.name === 'concat') {
        if (expr.args.length < 2) return undefined;
        const argsSql = expr.args.map(resolveArg);
        if (argsSql.some((item) => !item)) return undefined;
        const comparator =
          expr.comparator === 'eq' ? '=' : expr.comparator === 'neq' ? '<>' : undefined;
        if (!comparator) return undefined;
        return {
          sql: `concat(${(argsSql as string[]).join(', ')}) ${comparator} ${placeholder(params, value)}`,
          joinCount: 0,
        };
      }
      return undefined;
    }
    case 'datepart': {
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
      if (!Number.isFinite(expr.value)) return undefined;
      const partMap: Record<string, string> = {
        month: 'MONTH',
        day: 'DAY',
        hour: 'HOUR',
        minute: 'MINUTE',
        second: 'SECOND',
      };
      const part = partMap[expr.part];
      if (!part) return undefined;
      const source = `timezone('UTC', ${resolved.sql})`;
      const extracted = `EXTRACT(${part} FROM ${source})`;
      return {
        sql: `${extracted} ${comparator} ${placeholder(params, expr.value)}`,
        joinCount: 0,
      };
    }
    case 'lengthcmp': {
      const resolved = resolvePredicateField(expr.field, ctx);
      if (!resolved) return undefined;
      const value = Number(expr.value);
      if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return undefined;
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
      return {
        sql: `char_length(${resolved.sql}) ${comparator} ${placeholder(params, value)}`,
        joinCount: 0,
      };
    }
    case 'lambda': {
      const start = params.length;
      const [sourceToken, ...pathRest] = expr.path;
      const nestedSourceBinding =
        sourceToken && pathRest.length ? ctx.bindings[sourceToken] : undefined;
      const isNested = Boolean(nestedSourceBinding);
      const sourceBinding = isNested ? nestedSourceBinding : ctx.defaultBinding;
      if (!sourceBinding) return undefined;
      const path = isNested ? pathRest : expr.path;
      if (!path.length) return undefined;
      let clause: SqlFragment | undefined;
      try {
        clause = buildLambdaExistsClause({
          source: sourceBinding,
          path,
          lambdaType: expr.lambdaType,
          aliasToken: expr.alias,
          predicate: expr.predicate,
          dataSource: ctx.dataSource,
          metaCache: ctx.metaCache,
          params,
          nextAlias: ctx.nextAlias,
          outerBindings: ctx.bindings,
        });
      } catch (error) {
        params.length = start;
        if (error instanceof LambdaPushdownBuildError) {
          throw error;
        }
        return undefined;
      }
      if (!clause) {
        params.length = start;
        return undefined;
      }
      return clause;
    }
    default:
      return undefined;
  }
}

export interface FilterPushdownBuildResult {
  sql: string;
  params: unknown[];
  idProperty: string;
}

export interface FilterPushdownCountBuildResult {
  sql: string;
  params: unknown[];
}

export interface FilterPushdownDecline {
  declineReason: string;
}

function normalizeMaxJoinCount(maxJoinCount: unknown): number {
  const n = Number(maxJoinCount);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 8;
}

function normalizeOrder(order?: string | string[]): string[] {
  if (!order) return [];
  if (Array.isArray(order)) return order;
  return [order];
}

export function buildPostgresFilterIdQuery(options: {
  dataSource: juggler.DataSource;
  modelCtor: typeof Entity;
  expression: ParsedExpression;
  where?: Where<AnyObject>;
  order?: string | string[];
  offset?: number;
  limit?: number;
  maxJoinCount?: number;
}): FilterPushdownBuildResult | FilterPushdownDecline {
  if (!supportsPostgresLambdaPushdown(options.dataSource)) {
    return { declineReason: 'non-postgres' };
  }

  const idProperty = getSingleIdProperty(options.modelCtor);
  if (!idProperty) {
    return { declineReason: 'composite-or-missing-id' };
  }

  const metaCache = new Map<typeof Entity, SqlMetadata>();
  const baseMetaRaw = inferSqlMetadata(options.modelCtor, options.dataSource);
  if (!baseMetaRaw?.tableName) {
    return { declineReason: 'missing-sql-metadata' };
  }
  metaCache.set(options.modelCtor, {
    tableName: baseMetaRaw.tableName,
    schema: baseMetaRaw.schema,
    columnMap: baseMetaRaw.columnMap ?? {},
  });

  const rootAlias = 'r';
  const idColumn = resolveColumn(options.modelCtor, idProperty, options.dataSource, metaCache);
  if (!idColumn) {
    return { declineReason: 'id-column-resolution' };
  }

  const params: unknown[] = [];
  const whereCtx: WhereBuildContext = {
    dataSource: options.dataSource,
    modelCtor: options.modelCtor,
    tableAlias: rootAlias,
    metaCache,
  };
  const baseWhereSql = options.where ? translateWhere(options.where, whereCtx, params) : undefined;
  if (options.where && !baseWhereSql) {
    return { declineReason: 'unsupported-root-where' };
  }

  const start = params.length;
  const maxJoinCount = normalizeMaxJoinCount(options.maxJoinCount);
  let aliasCounter = 0;
  const nextAlias = () => `t${++aliasCounter}`;
  let built: SqlFragment | undefined;
  try {
    built = translatePredicateExpression(
      options.expression,
      {
        dataSource: options.dataSource,
        metaCache,
        nextAlias,
        bindings: {},
        defaultBinding: { modelCtor: options.modelCtor, tableAlias: rootAlias },
      },
      params,
    );
  } catch {
    params.length = start;
    return { declineReason: 'unsupported-filter' };
  }
  if (!built) {
    params.length = start;
    return { declineReason: 'unsupported-filter' };
  }
  if (built.joinCount > maxJoinCount) {
    params.length = start;
    return { declineReason: ODataErrorCodes.PushdownJoinCountExceeded };
  }

  const whereParts = [baseWhereSql, built.sql].filter(Boolean) as string[];
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

export function buildPostgresFilterCountQuery(options: {
  dataSource: juggler.DataSource;
  modelCtor: typeof Entity;
  expression: ParsedExpression;
  where?: Where<AnyObject>;
  maxJoinCount?: number;
}): FilterPushdownCountBuildResult | FilterPushdownDecline {
  if (!supportsPostgresLambdaPushdown(options.dataSource)) {
    return { declineReason: 'non-postgres' };
  }

  const metaCache = new Map<typeof Entity, SqlMetadata>();
  const baseMetaRaw = inferSqlMetadata(options.modelCtor, options.dataSource);
  if (!baseMetaRaw?.tableName) {
    return { declineReason: 'missing-sql-metadata' };
  }
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
  if (options.where && !baseWhereSql) {
    return { declineReason: 'unsupported-root-where' };
  }

  const start = params.length;
  const maxJoinCount = normalizeMaxJoinCount(options.maxJoinCount);
  let aliasCounter = 0;
  const nextAlias = () => `t${++aliasCounter}`;
  const built = translatePredicateExpression(
    options.expression,
    {
      dataSource: options.dataSource,
      metaCache,
      nextAlias,
      bindings: {},
      defaultBinding: { modelCtor: options.modelCtor, tableAlias: rootAlias },
    },
    params,
  );
  if (!built) {
    params.length = start;
    return { declineReason: 'unsupported-filter' };
  }
  if (built.joinCount > maxJoinCount) {
    params.length = start;
    return { declineReason: ODataErrorCodes.PushdownJoinCountExceeded };
  }

  const whereParts = [baseWhereSql, built.sql].filter(Boolean) as string[];
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

function buildLambdaExistsClause(options: {
  source: { modelCtor: typeof Entity; tableAlias: string };
  path: string[];
  lambdaType: 'any' | 'all';
  aliasToken: string;
  predicate: ParsedExpression;
  dataSource: juggler.DataSource;
  metaCache: Map<typeof Entity, SqlMetadata>;
  params: unknown[];
  nextAlias: () => string;
  outerBindings: Record<string, { modelCtor: typeof Entity; tableAlias: string }>;
}): SqlFragment | undefined {
  const start = options.params.length;
  const path = options.path.join('/');
  let resolved: ResolvedNavigationPath;
  try {
    resolved = resolveNavigationPath(options.source.modelCtor, path, {
      maxDepth: 5,
      allowThrough: true,
    });
  } catch (err) {
    options.params.length = start;
    if (err instanceof NavigationPathError) {
      if (err.code) {
        throw new LambdaPushdownBuildError(err.code);
      }
      return undefined;
    }
    return undefined;
  }

  if (!resolved.joins.length) {
    options.params.length = start;
    return undefined;
  }
  if (resolved.propertyPath) {
    options.params.length = start;
    return undefined;
  }

  const joinSegments = resolved.joins;
  const lastJoin = joinSegments[joinSegments.length - 1];
  const lambdaModel = lastJoin?.targetModel;
  if (!lambdaModel) {
    options.params.length = start;
    return undefined;
  }

  const lambdaTableMetaRaw = inferSqlMetadata(lambdaModel, options.dataSource);
  if (!lambdaTableMetaRaw?.tableName) {
    options.params.length = start;
    return undefined;
  }
  const lambdaTableMeta: SqlMetadata = {
    tableName: lambdaTableMetaRaw.tableName,
    schema: lambdaTableMetaRaw.schema,
    columnMap: lambdaTableMetaRaw.columnMap ?? {},
  };
  options.metaCache.set(lambdaModel, lambdaTableMeta);

  const aliases = joinSegments.map(() => options.nextAlias());
  const lastAlias = aliases[aliases.length - 1]!;

  const joinClauses: string[] = [];
  const whereClauses: string[] = [];

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
  const firstFrom = `${buildTableRef({
    tableName: firstTableMetaRaw.tableName,
    schema: firstTableMetaRaw.schema,
    columnMap: firstTableMetaRaw.columnMap ?? {},
  })} AS ${firstAlias}`;

  const sourceKeyColumn = resolveColumn(
    first.sourceModel,
    first.sourceKey,
    options.dataSource,
    options.metaCache,
  );
  const firstTargetColumn = resolveColumn(
    first.targetModel,
    first.targetKey,
    options.dataSource,
    options.metaCache,
  );
  if (!sourceKeyColumn || !firstTargetColumn) {
    options.params.length = start;
    return undefined;
  }

  if (first.relationType === 'belongsTo') {
    whereClauses.push(
      `${options.source.tableAlias}.${sourceKeyColumn} = ${firstAlias}.${firstTargetColumn}`,
    );
  } else {
    whereClauses.push(
      `${firstAlias}.${firstTargetColumn} = ${options.source.tableAlias}.${sourceKeyColumn}`,
    );
  }

  for (let i = 1; i < joinSegments.length; i++) {
    const segment = joinSegments[i]!;
    const sourceAlias = aliases[i - 1]!;
    const targetAlias = aliases[i]!;

    const targetMetaRaw = inferSqlMetadata(segment.targetModel, options.dataSource);
    if (!targetMetaRaw?.tableName) {
      options.params.length = start;
      return undefined;
    }
    options.metaCache.set(segment.targetModel, {
      tableName: targetMetaRaw.tableName,
      schema: targetMetaRaw.schema,
      columnMap: targetMetaRaw.columnMap ?? {},
    });
    const sourceKeyColumn = resolveColumn(
      segment.sourceModel,
      segment.sourceKey,
      options.dataSource,
      options.metaCache,
    );
    const targetKeyColumn = resolveColumn(
      segment.targetModel,
      segment.targetKey,
      options.dataSource,
      options.metaCache,
    );
    if (!sourceKeyColumn || !targetKeyColumn) {
      options.params.length = start;
      return undefined;
    }

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
    dataSource: options.dataSource,
    metaCache: options.metaCache,
    nextAlias: options.nextAlias,
    bindings: {
      ...options.outerBindings,
      [options.aliasToken]: { modelCtor: lambdaModel, tableAlias: lastAlias },
    },
  };

  const predicateSql = translatePredicateExpression(
    options.predicate,
    predicateCtx,
    options.params,
  );
  if (!predicateSql) {
    options.params.length = start;
    return undefined;
  }

  const joinCount = Math.max(0, joinSegments.length - 1) + predicateSql.joinCount;

  if (options.lambdaType === 'any') {
    whereClauses.push(predicateSql.sql);
    const whereSql = whereClauses.length
      ? `WHERE ${whereClauses.map((c) => `(${c})`).join(' AND ')}`
      : '';
    return {
      sql: `EXISTS (SELECT 1 FROM ${firstFrom} ${joinClauses.join(' ')} ${whereSql})`,
      joinCount,
    };
  }

  // all: NOT EXISTS (... WHERE predicate IS NOT TRUE)
  whereClauses.push(`(${predicateSql.sql}) IS NOT TRUE`);
  const whereSql = whereClauses.length
    ? `WHERE ${whereClauses.map((c) => `(${c})`).join(' AND ')}`
    : '';
  return {
    sql: `NOT EXISTS (SELECT 1 FROM ${firstFrom} ${joinClauses.join(' ')} ${whereSql})`,
    joinCount,
  };
}

export function buildPostgresLambdaIdQuery(
  options: {
    dataSource: juggler.DataSource;
    modelCtor: typeof Entity;
    where?: Where<AnyObject>;
    order?: string | string[];
    offset?: number;
    limit?: number;
    maxJoinCount?: number;
  } & (
    | {
        lambdas: LambdaExpression[];
        expression?: undefined;
      }
    | {
        expression: ParsedExpression;
        lambdas?: undefined;
      }
  ),
): LambdaPushdownBuildResult | LambdaPushdownDecline {
  const { dataSource, modelCtor } = options;
  if (!supportsPostgresLambdaPushdown(dataSource)) {
    return { declineReason: 'non-postgres' };
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

  const maxJoinCount =
    typeof options.maxJoinCount === 'number' &&
    Number.isFinite(options.maxJoinCount) &&
    (options.maxJoinCount as number) > 0
      ? Math.floor(options.maxJoinCount as number)
      : 8;

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

  let aliasCounter = 0;
  const nextAlias = () => `t${++aliasCounter}`;
  const rootBinding = { modelCtor, tableAlias: rootAlias };

  let joinCount = 0;
  const predicateClauses: string[] = [];
  const expression = (options as { expression?: ParsedExpression }).expression;
  if (expression) {
    if (!containsLambdaExpression(expression)) {
      return { declineReason: 'no-lambdas' };
    }
    const start = params.length;
    let built: SqlFragment | undefined;
    try {
      built = translatePredicateExpression(
        expression,
        {
          dataSource,
          metaCache,
          nextAlias,
          bindings: {},
          defaultBinding: rootBinding,
        },
        params,
      );
    } catch (error) {
      params.length = start;
      if (error instanceof LambdaPushdownBuildError) {
        return { declineReason: error.reason };
      }
      return { declineReason: 'unsupported-lambda' };
    }
    if (!built) {
      params.length = start;
      return { declineReason: 'unsupported-lambda' };
    }
    joinCount += built.joinCount;
    if (joinCount > maxJoinCount) {
      params.length = start;
      return { declineReason: ODataErrorCodes.PushdownJoinCountExceeded };
    }
    predicateClauses.push(built.sql);
  } else {
    const lambdas = (options as { lambdas: LambdaExpression[] }).lambdas;
    if (!lambdas.length) {
      return { declineReason: 'no-lambdas' };
    }
    for (const lambda of lambdas) {
      const start = params.length;
      let clause: SqlFragment | undefined;
      try {
        clause = buildLambdaExistsClause({
          source: rootBinding,
          path: lambda.path,
          lambdaType: lambda.type,
          aliasToken: lambda.alias,
          predicate: lambda.predicate,
          dataSource,
          metaCache,
          params,
          nextAlias,
          outerBindings: {},
        });
      } catch (error) {
        params.length = start;
        if (error instanceof LambdaPushdownBuildError) {
          return { declineReason: error.reason };
        }
        return { declineReason: 'unsupported-lambda' };
      }
      if (!clause) {
        params.length = start;
        return { declineReason: 'unsupported-lambda' };
      }
      joinCount += clause.joinCount;
      if (joinCount > maxJoinCount) {
        params.length = start;
        return { declineReason: ODataErrorCodes.PushdownJoinCountExceeded };
      }
      predicateClauses.push(clause.sql);
    }
  }

  const whereParts = [baseWhereSql, ...predicateClauses].filter(Boolean) as string[];
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

export function buildPostgresLambdaCountQuery(
  options: {
    dataSource: juggler.DataSource;
    modelCtor: typeof Entity;
    where?: Where<AnyObject>;
    maxJoinCount?: number;
  } & (
    | {
        lambdas: LambdaExpression[];
        expression?: undefined;
      }
    | {
        expression: ParsedExpression;
        lambdas?: undefined;
      }
  ),
): LambdaPushdownCountBuildResult | LambdaPushdownDecline {
  const { dataSource, modelCtor } = options;
  if (!supportsPostgresLambdaPushdown(dataSource)) {
    return { declineReason: 'non-postgres' };
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
  const maxJoinCount =
    typeof options.maxJoinCount === 'number' &&
    Number.isFinite(options.maxJoinCount) &&
    (options.maxJoinCount as number) > 0
      ? Math.floor(options.maxJoinCount as number)
      : 8;

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

  const predicateClauses: string[] = [];
  let joinCount = 0;
  let aliasCounter = 0;
  const nextAlias = () => `t${++aliasCounter}`;
  const rootBinding = { modelCtor, tableAlias: rootAlias };

  const expression = (options as { expression?: ParsedExpression }).expression;
  if (expression) {
    if (!containsLambdaExpression(expression)) {
      return { declineReason: 'no-lambdas' };
    }
    const start = params.length;
    let built: SqlFragment | undefined;
    try {
      built = translatePredicateExpression(
        expression,
        {
          dataSource,
          metaCache,
          nextAlias,
          bindings: {},
          defaultBinding: rootBinding,
        },
        params,
      );
    } catch (error) {
      params.length = start;
      if (error instanceof LambdaPushdownBuildError) {
        return { declineReason: error.reason };
      }
      return { declineReason: 'unsupported-lambda' };
    }
    if (!built) {
      params.length = start;
      return { declineReason: 'unsupported-lambda' };
    }
    joinCount += built.joinCount;
    if (joinCount > maxJoinCount) {
      params.length = start;
      return { declineReason: ODataErrorCodes.PushdownJoinCountExceeded };
    }
    predicateClauses.push(built.sql);
  } else {
    const lambdas = (options as { lambdas: LambdaExpression[] }).lambdas;
    if (!lambdas.length) {
      return { declineReason: 'no-lambdas' };
    }
    for (const lambda of lambdas) {
      const start = params.length;
      let clause: SqlFragment | undefined;
      try {
        clause = buildLambdaExistsClause({
          source: rootBinding,
          path: lambda.path,
          lambdaType: lambda.type,
          aliasToken: lambda.alias,
          predicate: lambda.predicate,
          dataSource,
          metaCache,
          params,
          nextAlias,
          outerBindings: {},
        });
      } catch (error) {
        params.length = start;
        if (error instanceof LambdaPushdownBuildError) {
          return { declineReason: error.reason };
        }
        return { declineReason: 'unsupported-lambda' };
      }
      if (!clause) {
        params.length = start;
        return { declineReason: 'unsupported-lambda' };
      }
      joinCount += clause.joinCount;
      if (joinCount > maxJoinCount) {
        params.length = start;
        return { declineReason: ODataErrorCodes.PushdownJoinCountExceeded };
      }
      predicateClauses.push(clause.sql);
    }
  }

  const whereParts = [baseWhereSql, ...predicateClauses].filter(Boolean) as string[];
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

function containsLambdaExpression(expr: ParsedExpression): boolean {
  switch (expr.operator) {
    case 'lambda':
      return true;
    case 'logical':
      return expr.expressions.some((child) => containsLambdaExpression(child));
    case 'not':
      return containsLambdaExpression(expr.expr);
    default:
      return false;
  }
}

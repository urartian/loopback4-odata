import { AnyObject, Entity, ModelDefinition, Where, juggler } from '@loopback/repository';
import { escapeLikeLiteral } from './like-escaping';
import { inferSqlMetadata } from './sql-metadata';
import {
  resolveNavigationPath,
  NavigationPathError,
  ResolvedNavigationPath,
} from './navigation-path';
import { ParsedExpression, FunctionArg } from '../services/odata-query-parser.service';
import { supportsPostgresLambdaPushdown } from './postgres-lambda-pushdown';
import { ODataErrorCodes } from '../odata-error-codes';

export interface MixedFilterPushdownBuildResult {
  sql: string;
  params: unknown[];
  idProperty: string;
}

export interface MixedFilterPushdownCountBuildResult {
  sql: string;
  params: unknown[];
}

export interface MixedFilterPushdownDecline {
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
      typeof ops.options === 'string' ? ops.options.toLowerCase() === 'i' : false;

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
          if (operand === undefined) return undefined;
          if (operand === null) return undefined;
          const likeKeyword = caseInsensitive ? 'ILIKE' : 'LIKE';
          const not = op === 'nlike' ? 'NOT ' : '';
          opClauses.push(
            `${columnExpr} ${not}${likeKeyword} ${placeholder(params, operand)} ESCAPE E'\\\\'`,
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
            // nin: logical negation of the inq semantics above
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

type SqlFragment = { sql: string; joinCount: number; joinKeys: Set<string> };

function normalizeOrder(order?: string | string[]): string[] {
  if (!order) return [];
  if (Array.isArray(order)) return order;
  return [order];
}

function normalizeMaxJoinCount(maxJoinCount: unknown): number {
  const n = Number(maxJoinCount);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 8;
}

function normalizeMaxDepth(maxDepth: unknown): number {
  const n = Number(maxDepth);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 5;
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

const EMPTY_JOIN_KEYS = new Set<string>();

function unionJoinKeys(left: Set<string>, right: Set<string>): Set<string> {
  if (!left.size) return right;
  if (!right.size) return left;
  return new Set<string>([...left, ...right]);
}

function joinKeysForSegments(
  segments: ResolvedNavigationPath['joins'],
  dataSource: juggler.DataSource,
  metaCache: Map<typeof Entity, SqlMetadata>,
): Set<string> {
  const keys = new Set<string>();
  for (const seg of segments) {
    const sourceMeta =
      metaCache.get(seg.sourceModel) ?? inferSqlMetadata(seg.sourceModel, dataSource);
    const targetMeta =
      metaCache.get(seg.targetModel) ?? inferSqlMetadata(seg.targetModel, dataSource);
    const sourceId = sourceMeta?.tableName
      ? `${sourceMeta.schema ? `${sourceMeta.schema}.` : ''}${sourceMeta.tableName}`
      : ((seg.sourceModel as any)?.name ?? 'Unknown');
    const targetId = targetMeta?.tableName
      ? `${targetMeta.schema ? `${targetMeta.schema}.` : ''}${targetMeta.tableName}`
      : ((seg.targetModel as any)?.name ?? 'Unknown');
    keys.add(`${sourceId}.${seg.sourceKey}->${targetId}.${seg.targetKey}`);
  }
  return keys;
}

function translateRootComparison(
  options: {
    modelCtor: typeof Entity;
    tableAlias: string;
    dataSource: juggler.DataSource;
    metaCache: Map<typeof Entity, SqlMetadata>;
    params: unknown[];
  },
  expr: Extract<ParsedExpression, { operator: 'comparison' }>,
): SqlFragment | undefined {
  if (expr.field.includes('/')) return undefined;
  const column = resolveColumn(
    options.modelCtor,
    expr.field,
    options.dataSource,
    options.metaCache,
  );
  if (!column) return undefined;
  const columnExpr = `${options.tableAlias}.${column}`;

  const comparatorMap: Record<string, string> = {
    eq: '=',
    neq: '<>',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  };

  if (expr.comparator === 'inq' || expr.comparator === 'nin') {
    if (!Array.isArray(expr.value)) return undefined;
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
      if (nullSql && listSql)
        return { sql: `(${nullSql} OR ${listSql})`, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
      if (nullSql) return { sql: nullSql, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
      if (listSql) return { sql: listSql, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
      return { sql: 'FALSE', joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
    }
    if (nullSql && listSql)
      return { sql: `(${nullSql} AND ${listSql})`, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
    if (nullSql) return { sql: nullSql, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
    if (listSql) return { sql: listSql, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
    return { sql: 'TRUE', joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
  }

  if (expr.value === null) {
    if (expr.comparator === 'eq')
      return { sql: `${columnExpr} IS NULL`, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
    if (expr.comparator === 'neq')
      return { sql: `${columnExpr} IS NOT NULL`, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
    return undefined;
  }

  const comparator = comparatorMap[expr.comparator];
  if (!comparator) return undefined;
  return {
    sql: `${columnExpr} ${comparator} ${placeholder(options.params, expr.value)}`,
    joinCount: 0,
    joinKeys: EMPTY_JOIN_KEYS,
  };
}

function translateRootTransformComparison(
  options: {
    modelCtor: typeof Entity;
    tableAlias: string;
    dataSource: juggler.DataSource;
    metaCache: Map<typeof Entity, SqlMetadata>;
    params: unknown[];
  },
  expr: Extract<ParsedExpression, { operator: 'transformcmp' }>,
): SqlFragment | undefined {
  if (expr.field.includes('/')) return undefined;
  const column = resolveColumn(
    options.modelCtor,
    expr.field,
    options.dataSource,
    options.metaCache,
  );
  if (!column) return undefined;
  const columnExpr = `${options.tableAlias}.${column}`;
  const leftSql = expr.transform === 'tolower' ? `LOWER(${columnExpr})` : `UPPER(${columnExpr})`;

  if (expr.value === null) {
    if (expr.comparator === 'eq')
      return { sql: `${leftSql} IS NULL`, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
    if (expr.comparator === 'neq')
      return { sql: `${leftSql} IS NOT NULL`, joinCount: 0, joinKeys: EMPTY_JOIN_KEYS };
    return undefined;
  }
  if (typeof expr.value !== 'string') return undefined;
  if (expr.comparator === 'eq') {
    return {
      sql: `${leftSql} = ${placeholder(options.params, expr.value)}`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  if (expr.comparator === 'neq') {
    return {
      sql: `${leftSql} <> ${placeholder(options.params, expr.value)}`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  return undefined;
}

function translateRootFunction(
  options: {
    modelCtor: typeof Entity;
    tableAlias: string;
    dataSource: juggler.DataSource;
    metaCache: Map<typeof Entity, SqlMetadata>;
    params: unknown[];
  },
  expr: Extract<ParsedExpression, { operator: 'function' }>,
): SqlFragment | undefined {
  if (expr.name !== 'contains' && expr.name !== 'startswith' && expr.name !== 'endswith') {
    return undefined;
  }
  if (expr.field.includes('/')) return undefined;
  const column = resolveColumn(
    options.modelCtor,
    expr.field,
    options.dataSource,
    options.metaCache,
  );
  if (!column) return undefined;
  const columnExpr = `${options.tableAlias}.${column}`;
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
      ? `LOWER(${columnExpr})`
      : (expr as AnyObject)?.transform === 'toupper'
        ? `UPPER(${columnExpr})`
        : columnExpr;
  const comparator = transformed !== columnExpr ? 'LIKE' : expr.caseInsensitive ? 'ILIKE' : 'LIKE';
  const negated = expr.negated === true ? 'NOT ' : '';
  return {
    sql: `${transformed} ${negated}${comparator} ${placeholder(options.params, pattern)} ESCAPE E'\\\\'`,
    joinCount: 0,
    joinKeys: EMPTY_JOIN_KEYS,
  };
}

function translateRootStringFunction(
  options: {
    modelCtor: typeof Entity;
    tableAlias: string;
    dataSource: juggler.DataSource;
    metaCache: Map<typeof Entity, SqlMetadata>;
    params: unknown[];
  },
  expr: Extract<ParsedExpression, { operator: 'stringfncmp' }>,
): SqlFragment | undefined {
  const value = typeof expr.value === 'string' ? expr.value : undefined;
  if (value === undefined) return undefined;
  if (!expr.args?.length) return undefined;

  const resolveArg = (arg: FunctionArg): string | undefined => {
    if (arg.kind === 'literal') {
      return placeholder(options.params, arg.value);
    }
    const name = arg.name;
    if (typeof name !== 'string' || name.includes('/')) return undefined;
    const column = resolveColumn(options.modelCtor, name, options.dataSource, options.metaCache);
    if (!column) return undefined;
    return `${options.tableAlias}.${column}`;
  };

  if (expr.name === 'trim') {
    if (expr.args.length !== 1) return undefined;
    const target = resolveArg(expr.args[0]!);
    if (!target) return undefined;
    const op = expr.comparator === 'eq' ? '=' : '<>';
    return {
      sql: `btrim(${target}) ${op} ${placeholder(options.params, value)}`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }

  if (expr.name === 'concat') {
    if (expr.args.length < 2) return undefined;
    const parts: string[] = [];
    for (const arg of expr.args) {
      const resolved = resolveArg(arg);
      if (!resolved) return undefined;
      parts.push(resolved);
    }
    const op = expr.comparator === 'eq' ? '=' : '<>';
    return {
      sql: `concat(${parts.join(', ')}) ${op} ${placeholder(options.params, value)}`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }

  return undefined;
}

function translateRootDatePart(
  options: {
    modelCtor: typeof Entity;
    tableAlias: string;
    dataSource: juggler.DataSource;
    metaCache: Map<typeof Entity, SqlMetadata>;
    params: unknown[];
  },
  expr: Extract<ParsedExpression, { operator: 'datepart' }>,
): SqlFragment | undefined {
  if (expr.field.includes('/')) return undefined;
  const column = resolveColumn(
    options.modelCtor,
    expr.field,
    options.dataSource,
    options.metaCache,
  );
  if (!column) return undefined;
  const columnExpr = `${options.tableAlias}.${column}`;
  const part = expr.part.toUpperCase();
  const lhs = `EXTRACT(${part} FROM timezone('UTC', ${columnExpr}))`;

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
    sql: `${lhs} ${comparator} ${placeholder(options.params, expr.value)}`,
    joinCount: 0,
    joinKeys: EMPTY_JOIN_KEYS,
  };
}

function translateRootIndexOf(
  options: {
    modelCtor: typeof Entity;
    tableAlias: string;
    dataSource: juggler.DataSource;
    metaCache: Map<typeof Entity, SqlMetadata>;
    params: unknown[];
  },
  expr: Extract<ParsedExpression, { operator: 'indexofcmp' }>,
): SqlFragment | undefined {
  if (expr.field.includes('/')) return undefined;
  const column = resolveColumn(
    options.modelCtor,
    expr.field,
    options.dataSource,
    options.metaCache,
  );
  if (!column) return undefined;
  const columnExpr = `${options.tableAlias}.${column}`;
  const escaped = escapeLikeLiteral(expr.needle);
  if (
    (expr.comparator === 'gte' && expr.value >= 0) ||
    (expr.comparator === 'gt' && expr.value > -1)
  ) {
    return {
      sql: `${columnExpr} ILIKE ${placeholder(options.params, `%${escaped}%`)} ESCAPE E'\\\\'`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  if (expr.comparator === 'eq' && expr.value === -1) {
    return {
      sql: `${columnExpr} NOT ILIKE ${placeholder(options.params, `%${escaped}%`)} ESCAPE E'\\\\'`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  return undefined;
}

function translateRootSubstring(
  options: {
    modelCtor: typeof Entity;
    tableAlias: string;
    dataSource: juggler.DataSource;
    metaCache: Map<typeof Entity, SqlMetadata>;
    params: unknown[];
  },
  expr: Extract<ParsedExpression, { operator: 'substrcmp' }>,
): SqlFragment | undefined {
  if (expr.field.includes('/')) return undefined;
  const column = resolveColumn(
    options.modelCtor,
    expr.field,
    options.dataSource,
    options.metaCache,
  );
  if (!column) return undefined;
  const columnExpr = `${options.tableAlias}.${column}`;
  const underscores = '_'.repeat(Math.max(0, expr.start));
  const escaped = escapeLikeLiteral(expr.literal);
  const pattern =
    expr.length !== undefined ? `${underscores}${escaped}%` : `${underscores}${escaped}`;
  const op = expr.comparator === 'eq' ? 'LIKE' : 'NOT LIKE';
  return {
    sql: `${columnExpr} ${op} ${placeholder(options.params, pattern)} ESCAPE E'\\\\'`,
    joinCount: 0,
    joinKeys: EMPTY_JOIN_KEYS,
  };
}

function translateRootLength(
  options: {
    modelCtor: typeof Entity;
    tableAlias: string;
    dataSource: juggler.DataSource;
    metaCache: Map<typeof Entity, SqlMetadata>;
    params: unknown[];
  },
  expr: Extract<ParsedExpression, { operator: 'lengthcmp' }>,
): SqlFragment | undefined {
  if (expr.field.includes('/')) return undefined;
  const column = resolveColumn(
    options.modelCtor,
    expr.field,
    options.dataSource,
    options.metaCache,
  );
  if (!column) return undefined;
  const columnExpr = `${options.tableAlias}.${column}`;
  const value = expr.value;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return undefined;
  const underscores = (n: number) => '_'.repeat(n);

  if (expr.comparator === 'eq') {
    if (value === 0) {
      return {
        sql: `${columnExpr} = ${placeholder(options.params, '')}`,
        joinCount: 0,
        joinKeys: EMPTY_JOIN_KEYS,
      };
    }
    return {
      sql: `${columnExpr} LIKE ${placeholder(options.params, underscores(value))} ESCAPE E'\\\\'`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  if (expr.comparator === 'neq') {
    if (value === 0) {
      return {
        sql: `${columnExpr} <> ${placeholder(options.params, '')}`,
        joinCount: 0,
        joinKeys: EMPTY_JOIN_KEYS,
      };
    }
    return {
      sql: `${columnExpr} NOT LIKE ${placeholder(options.params, underscores(value))} ESCAPE E'\\\\'`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  if (expr.comparator === 'gt') {
    if (value === 0) {
      return {
        sql: `${columnExpr} <> ${placeholder(options.params, '')}`,
        joinCount: 0,
        joinKeys: EMPTY_JOIN_KEYS,
      };
    }
    return {
      sql: `${columnExpr} LIKE ${placeholder(options.params, `${underscores(value + 1)}%`)} ESCAPE E'\\\\'`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  if (expr.comparator === 'gte') {
    if (value <= 0) {
      return {
        sql: `${columnExpr} LIKE ${placeholder(options.params, '%')} ESCAPE E'\\\\'`,
        joinCount: 0,
        joinKeys: EMPTY_JOIN_KEYS,
      };
    }
    return {
      sql: `${columnExpr} LIKE ${placeholder(options.params, `${underscores(value)}%`)} ESCAPE E'\\\\'`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  if (expr.comparator === 'lt') {
    return {
      sql: `${columnExpr} NOT LIKE ${placeholder(options.params, `${underscores(value)}%`)} ESCAPE E'\\\\'`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }
  if (expr.comparator === 'lte') {
    if (value === 0) {
      return {
        sql: `${columnExpr} = ${placeholder(options.params, '')}`,
        joinCount: 0,
        joinKeys: EMPTY_JOIN_KEYS,
      };
    }
    return {
      sql: `${columnExpr} NOT LIKE ${placeholder(options.params, `${underscores(value + 1)}%`)} ESCAPE E'\\\\'`,
      joinCount: 0,
      joinKeys: EMPTY_JOIN_KEYS,
    };
  }

  return undefined;
}

function translateNavLeaf(options: {
  modelCtor: typeof Entity;
  expr:
    | Extract<ParsedExpression, { operator: 'comparison' }>
    | Extract<ParsedExpression, { operator: 'transformcmp' }>
    | Extract<ParsedExpression, { operator: 'function' }>;
  dataSource: juggler.DataSource;
  metaCache: Map<typeof Entity, SqlMetadata>;
  params: unknown[];
  rootAlias: string;
  maxDepth: number;
}): SqlFragment | undefined {
  const field = (options.expr as AnyObject).field as string;
  if (!field || typeof field !== 'string' || !field.includes('/')) return undefined;

  const start = options.params.length;
  let resolved: ResolvedNavigationPath;
  try {
    resolved = resolveNavigationPath(options.modelCtor, field, { maxDepth: options.maxDepth });
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
  const joinKeys = joinKeysForSegments(joinSegments, options.dataSource, options.metaCache);
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
  const rawColumnExpr = `${lastAlias}.${propertyColumn}`;

  const whereClauses: string[] = [];
  whereClauses.push(`${firstAlias}.${rootTargetColumn} = ${options.rootAlias}.${rootSourceColumn}`);

  if (options.expr.operator === 'comparison') {
    const comparatorMap: Record<string, string> = {
      eq: '=',
      neq: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
    };
    const expr = options.expr;
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
            ? `${rawColumnExpr} IS NULL`
            : undefined
          : hasNull
            ? `${rawColumnExpr} IS NOT NULL`
            : undefined;
      const listSql = nonNull.length
        ? `${rawColumnExpr} ${op} (${nonNull.map((v) => placeholder(options.params, v)).join(', ')})`
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
      if (expr.comparator === 'eq') whereClauses.push(`${rawColumnExpr} IS NULL`);
      else if (expr.comparator === 'neq') whereClauses.push(`${rawColumnExpr} IS NOT NULL`);
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
      whereClauses.push(
        `${rawColumnExpr} ${comparator} ${placeholder(options.params, expr.value)}`,
      );
    }
  } else if (options.expr.operator === 'transformcmp') {
    const expr = options.expr;
    const colExpr =
      expr.transform === 'tolower' ? `LOWER(${rawColumnExpr})` : `UPPER(${rawColumnExpr})`;
    if (expr.value === null) {
      if (expr.comparator === 'eq') whereClauses.push(`${colExpr} IS NULL`);
      else if (expr.comparator === 'neq') whereClauses.push(`${colExpr} IS NOT NULL`);
      else {
        options.params.length = start;
        return undefined;
      }
    } else {
      if (typeof expr.value !== 'string') {
        options.params.length = start;
        return undefined;
      }
      if (expr.comparator === 'eq') {
        whereClauses.push(`${colExpr} = ${placeholder(options.params, expr.value)}`);
      } else if (expr.comparator === 'neq') {
        whereClauses.push(`${colExpr} <> ${placeholder(options.params, expr.value)}`);
      } else {
        options.params.length = start;
        return undefined;
      }
    }
  } else if (options.expr.operator === 'function') {
    const expr = options.expr;
    if (expr.name !== 'contains' && expr.name !== 'startswith' && expr.name !== 'endswith') {
      options.params.length = start;
      return undefined;
    }
    const value = expr.args?.[0];
    if (typeof value !== 'string') {
      options.params.length = start;
      return undefined;
    }
    const escaped = escapeLikeLiteral(value);
    const pattern =
      expr.name === 'contains'
        ? `%${escaped}%`
        : expr.name === 'startswith'
          ? `${escaped}%`
          : `%${escaped}`;
    const transformed =
      expr.transform === 'tolower'
        ? `LOWER(${rawColumnExpr})`
        : expr.transform === 'toupper'
          ? `UPPER(${rawColumnExpr})`
          : rawColumnExpr;
    const comparator =
      transformed !== rawColumnExpr ? 'LIKE' : expr.caseInsensitive ? 'ILIKE' : 'LIKE';
    const negated = expr.negated === true ? 'NOT ' : '';
    whereClauses.push(
      `${transformed} ${negated}${comparator} ${placeholder(options.params, pattern)} ESCAPE E'\\\\'`,
    );
  }

  const whereSql = whereClauses.length
    ? `WHERE ${whereClauses.map((c) => `(${c})`).join(' AND ')}`
    : '';
  return {
    sql: `EXISTS (SELECT 1 FROM ${from} ${joinClauses.join(' ')} ${whereSql})`,
    joinCount: joinKeys.size,
    joinKeys,
  };
}

function translateMixedPredicateExpression(options: {
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
    case 'logical': {
      const start = options.params.length;
      const parts: string[] = [];
      let joinKeys = EMPTY_JOIN_KEYS;
      for (const child of expr.expressions) {
        const built = translateMixedPredicateExpression({ ...options, expr: child });
        if (!built) {
          options.params.length = start;
          return undefined;
        }
        parts.push(built.sql);
        joinKeys = unionJoinKeys(joinKeys, built.joinKeys);
      }
      if (!parts.length) {
        options.params.length = start;
        return undefined;
      }
      const joiner = expr.type === 'and' ? 'AND' : 'OR';
      return {
        sql: parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(` ${joiner} `),
        joinCount: joinKeys.size,
        joinKeys,
      };
    }
    case 'not': {
      const inner = translateMixedPredicateExpression({ ...options, expr: expr.expr });
      if (!inner) return undefined;
      return { sql: `NOT (${inner.sql})`, joinCount: inner.joinCount, joinKeys: inner.joinKeys };
    }
    case 'comparison': {
      if (expr.field.includes('/')) {
        return translateNavLeaf({ ...options, expr });
      }
      return translateRootComparison(
        {
          modelCtor: options.modelCtor,
          tableAlias: options.rootAlias,
          dataSource: options.dataSource,
          metaCache: options.metaCache,
          params: options.params,
        },
        expr,
      );
    }
    case 'transformcmp': {
      if (expr.field.includes('/')) {
        return translateNavLeaf({ ...options, expr });
      }
      return translateRootTransformComparison(
        {
          modelCtor: options.modelCtor,
          tableAlias: options.rootAlias,
          dataSource: options.dataSource,
          metaCache: options.metaCache,
          params: options.params,
        },
        expr,
      );
    }
    case 'function': {
      if (expr.field.includes('/')) {
        return translateNavLeaf({ ...options, expr });
      }
      return translateRootFunction(
        {
          modelCtor: options.modelCtor,
          tableAlias: options.rootAlias,
          dataSource: options.dataSource,
          metaCache: options.metaCache,
          params: options.params,
        },
        expr,
      );
    }
    case 'stringfncmp':
      return translateRootStringFunction(
        {
          modelCtor: options.modelCtor,
          tableAlias: options.rootAlias,
          dataSource: options.dataSource,
          metaCache: options.metaCache,
          params: options.params,
        },
        expr,
      );
    case 'datepart':
      return translateRootDatePart(
        {
          modelCtor: options.modelCtor,
          tableAlias: options.rootAlias,
          dataSource: options.dataSource,
          metaCache: options.metaCache,
          params: options.params,
        },
        expr,
      );
    case 'indexofcmp':
      return translateRootIndexOf(
        {
          modelCtor: options.modelCtor,
          tableAlias: options.rootAlias,
          dataSource: options.dataSource,
          metaCache: options.metaCache,
          params: options.params,
        },
        expr,
      );
    case 'substrcmp':
      return translateRootSubstring(
        {
          modelCtor: options.modelCtor,
          tableAlias: options.rootAlias,
          dataSource: options.dataSource,
          metaCache: options.metaCache,
          params: options.params,
        },
        expr,
      );
    case 'lengthcmp':
      return translateRootLength(
        {
          modelCtor: options.modelCtor,
          tableAlias: options.rootAlias,
          dataSource: options.dataSource,
          metaCache: options.metaCache,
          params: options.params,
        },
        expr,
      );
    case 'lambda':
      return undefined;
    default:
      return undefined;
  }
}

export function buildPostgresMixedFilterIdQuery(options: {
  dataSource: juggler.DataSource;
  modelCtor: typeof Entity;
  expression: ParsedExpression;
  where?: Where<AnyObject>;
  order?: string | string[];
  offset?: number;
  limit?: number;
  maxDepth?: number;
  maxJoinCount?: number;
}): MixedFilterPushdownBuildResult | MixedFilterPushdownDecline {
  if (!supportsPostgresLambdaPushdown(options.dataSource)) {
    return { declineReason: 'non-postgres' };
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
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  const maxJoinCount = normalizeMaxJoinCount(options.maxJoinCount);
  const predicateBuilt = translateMixedPredicateExpression({
    modelCtor: options.modelCtor,
    expr: options.expression,
    dataSource: options.dataSource,
    metaCache,
    params,
    rootAlias,
    maxDepth,
  });
  if (!predicateBuilt) {
    params.length = start;
    return { declineReason: 'unsupported-filter' };
  }
  if (predicateBuilt.joinCount > maxJoinCount) {
    params.length = start;
    return { declineReason: ODataErrorCodes.PushdownJoinCountExceeded };
  }

  const whereParts = [baseWhereSql, predicateBuilt.sql].filter(Boolean) as string[];
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

  const tableRef = buildTableRef({
    tableName: baseMetaRaw.tableName,
    schema: baseMetaRaw.schema,
    columnMap: baseMetaRaw.columnMap ?? {},
  });

  return {
    sql: `SELECT ${rootAlias}.${idColumn} AS ${quoteIdentifier(idProperty)} FROM ${tableRef} AS ${rootAlias} ${whereClause} ${orderClause} ${limitClause} ${offsetClause}`.trim(),
    params,
    idProperty,
  };
}

export function buildPostgresMixedFilterCountQuery(options: {
  dataSource: juggler.DataSource;
  modelCtor: typeof Entity;
  expression: ParsedExpression;
  where?: Where<AnyObject>;
  maxDepth?: number;
  maxJoinCount?: number;
}): MixedFilterPushdownCountBuildResult | MixedFilterPushdownDecline {
  if (!supportsPostgresLambdaPushdown(options.dataSource)) {
    return { declineReason: 'non-postgres' };
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
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  const maxJoinCount = normalizeMaxJoinCount(options.maxJoinCount);
  const predicateBuilt = translateMixedPredicateExpression({
    modelCtor: options.modelCtor,
    expr: options.expression,
    dataSource: options.dataSource,
    metaCache,
    params,
    rootAlias,
    maxDepth,
  });
  if (!predicateBuilt) {
    params.length = start;
    return { declineReason: 'unsupported-filter' };
  }
  if (predicateBuilt.joinCount > maxJoinCount) {
    params.length = start;
    return { declineReason: ODataErrorCodes.PushdownJoinCountExceeded };
  }

  const whereParts = [baseWhereSql, predicateBuilt.sql].filter(Boolean) as string[];
  const whereClause = whereParts.length
    ? `WHERE ${whereParts.map((p) => `(${p})`).join(' AND ')}`
    : '';

  const tableRef = buildTableRef({
    tableName: baseMetaRaw.tableName,
    schema: baseMetaRaw.schema,
    columnMap: baseMetaRaw.columnMap ?? {},
  });

  return {
    sql: `SELECT COUNT(*) AS count FROM ${tableRef} AS ${rootAlias} ${whereClause}`.trim(),
    params,
  };
}

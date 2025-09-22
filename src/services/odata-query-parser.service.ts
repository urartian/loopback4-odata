import {Filter, Where, AnyObject, InclusionFilter, RelationDefinitionMap} from '@loopback/repository';

const comparisonOperators: Record<string, string> = {
  eq: 'eq',
  ne: 'neq',
  gt: 'gt',
  ge: 'gte',
  lt: 'lt',
  le: 'lte',
};

type ParsedExpression =
  | {operator: 'comparison'; field: string; comparator: string; value: unknown}
  | {operator: 'logical'; type: 'and' | 'or'; expressions: ParsedExpression[]};

type QueryObject = Record<string, string | string[] | undefined>;

interface ParseOptions {
  relations?: RelationDefinitionMap;
}

function tokenize(filter: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < filter.length; i++) {
    const char = filter[i];

    if (char === "'") {
      inString = !inString;
      current += char;
      continue;
    }

    if (!inString && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);

  return tokens;
}

function parseComparison(tokens: string[], index: number): [ParsedExpression, number] {
  const field = tokens[index];
  const comparator = tokens[index + 1];
  const valueToken = tokens[index + 2];

  if (!field || !comparator || valueToken === undefined) {
    throw new Error('Invalid filter expression');
  }

  const normalizedComparator = comparator.toLowerCase();
  if (!(normalizedComparator in comparisonOperators)) {
    throw new Error(`Unsupported comparator: ${comparator}`);
  }

  const value = parseLiteral(valueToken);

  return [
    {
      operator: 'comparison',
      field,
      comparator: comparisonOperators[normalizedComparator],
      value,
    },
    index + 3,
  ];
}

function parseLiteral(token: string): unknown {
  if (!token) return token;

  if (token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1);
  }

  if (token === 'true') return true;
  if (token === 'false') return false;

  const numeric = Number(token);
  if (!Number.isNaN(numeric)) return numeric;

  return token;
}

function parseFilter(tokens: string[], startIndex = 0): [ParsedExpression, number] {
  let index = startIndex;
  const expressions: ParsedExpression[] = [];
  let currentLogical: 'and' | 'or' | null = null;

  while (index < tokens.length) {
    const token = tokens[index];
    const lower = token.toLowerCase();

    if (lower === 'and' || lower === 'or') {
      currentLogical = lower;
      index++;
      continue;
    }

    const [comparison, nextIndex] = parseComparison(tokens, index);
    expressions.push(comparison);
    index = nextIndex;

    if (currentLogical && expressions.length >= 2) {
      const right = expressions.pop()!;
      const left = expressions.pop()!;
      expressions.push({
        operator: 'logical',
        type: currentLogical,
        expressions: [left, right],
      });
      currentLogical = null;
    }
  }

  if (expressions.length === 0) {
    throw new Error('Empty filter expression');
  }

  return [expressions[0], index];
}

function buildWhere(expr: ParsedExpression): Where<AnyObject> {
  if (expr.operator === 'comparison') {
    const {field, comparator, value} = expr;
    if (comparator === 'eq') {
      return {[field]: value};
    }
    return {[field]: {[comparator]: value}};
  }

  const clauses = expr.expressions.map(buildWhere);
  return {[expr.type]: clauses} as Where<AnyObject>;
}

function parseOrder(order?: string): string[] | undefined {
  if (!order) return undefined;
  return order.split(',').map(part => {
    const [field, direction] = part.trim().split(/\s+/);
    if (!field) return '';
    const dir = direction?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    return `${field} ${dir}`.trim();
  }).filter(Boolean);
}

function parseSelect(select?: string): AnyObject | undefined {
  if (!select) return undefined;
  return select.split(',').reduce<AnyObject>((fields, field) => {
    const trimmed = field.trim();
    if (trimmed) fields[trimmed] = true;
    return fields;
  }, {});
}

function parseExpand(
  expand?: string | string[],
  relations?: RelationDefinitionMap,
): InclusionFilter[] | undefined {
  if (!expand) return undefined;

  const normalized = Array.isArray(expand) ? expand.join(',') : expand;
  const names = normalized
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  if (!names.length) return undefined;

  const includes: InclusionFilter[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name)) continue;

    if (relations && !relations[name]) {
      throw new Error(`Unknown expand relation: ${name}`);
    }

    includes.push({relation: name});
    seen.add(name);
  }

  return includes.length ? includes : undefined;
}

export interface ParsedODataQuery extends Filter<AnyObject> {
  inlineCount?: boolean;
}

export function parseODataQuery(query: QueryObject, options: ParseOptions = {}): ParsedODataQuery {
  const filter: ParsedODataQuery = {};
  const {relations} = options;

  const filterExpr = typeof query['$filter'] === 'string' ? query['$filter'] : undefined;
  if (filterExpr) {
    const tokens = tokenize(filterExpr);
    if (tokens.length) {
      const [expr] = parseFilter(tokens);
      filter.where = buildWhere(expr);
    }
  }

  const orderby = typeof query['$orderby'] === 'string' ? query['$orderby'] : undefined;
  if (orderby) {
    filter.order = parseOrder(orderby);
  }

  const top = typeof query['$top'] === 'string' ? Number(query['$top']) : undefined;
  if (Number.isFinite(top)) {
    filter.limit = Number(top);
  }

  const skip = typeof query['$skip'] === 'string' ? Number(query['$skip']) : undefined;
  if (Number.isFinite(skip)) {
    filter.offset = Number(skip);
  }

  const select = typeof query['$select'] === 'string' ? query['$select'] : undefined;
  if (select) {
    filter.fields = parseSelect(select);
  }

  const expand = query['$expand'];
  const include = parseExpand(expand, relations);
  if (include) {
    filter.include = include;
  }

  const inlineCount = typeof query['$count'] === 'string' && query['$count'].toLowerCase() === 'true';
  if (inlineCount) {
    filter.inlineCount = true;
  }

  return filter;
}

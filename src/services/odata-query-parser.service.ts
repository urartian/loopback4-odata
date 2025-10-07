import {
  Filter,
  Where,
  AnyObject,
  InclusionFilter,
  RelationDefinitionMap,
  Entity,
} from '@loopback/repository';

const comparisonOperators: Record<string, string> = {
  eq: 'eq',
  ne: 'neq',
  gt: 'gt',
  ge: 'gte',
  lt: 'lt',
  le: 'lte',
};

type FunctionExpression = {
  operator: 'function';
  name: 'contains' | 'startswith' | 'endswith';
  field: string;
  args: unknown[];
  caseInsensitive: boolean;
  negated?: boolean;
};

type OperandTransform = 'tolower' | 'toupper';

interface FieldOperand {
  kind: 'field';
  name: string;
  transform?: OperandTransform;
}

interface LiteralOperand {
  kind: 'literal';
  value: unknown;
  transform?: OperandTransform;
}

type Operand = FieldOperand | LiteralOperand;

type ParsedExpression =
  | {operator: 'comparison'; field: string; comparator: string; value: unknown}
  | {operator: 'logical'; type: 'and' | 'or'; expressions: ParsedExpression[]}
  | {operator: 'not'; expr: ParsedExpression}
  | FunctionExpression
  | {operator: 'fncmp'; name: 'round' | 'floor' | 'ceiling' | 'year'; field: string; comparator: string; value: number};

type QueryObject = Record<string, string | string[] | undefined>;

interface ParseOptions {
  relations?: RelationDefinitionMap;
  strict?: boolean;
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

    if (!inString) {
      if (char === '(' || char === ')' || char === ',') {
        if (current) {
          tokens.push(current);
          current = '';
        }
        tokens.push(char);
        continue;
      }
      if (/\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        continue;
      }
    }

    current += char;
  }

  if (current) tokens.push(current);

  return tokens;
}

function applyTransform(operand: Operand, transform: OperandTransform): Operand {
  if (operand.kind === 'field') {
    return {...operand, transform};
  }

  if (operand.kind === 'literal' && typeof operand.value === 'string') {
    const value = transform === 'tolower'
      ? operand.value.toLowerCase()
      : operand.value.toUpperCase();
    return {...operand, value, transform};
  }

  return {...operand, transform};
}

function parseOperand(tokens: string[], index: number): [Operand, number] {
  const token = tokens[index];
  if (token == null) {
    throw new Error('Unexpected end of function arguments.');
  }

  const lower = token.toLowerCase();
  if ((lower === 'tolower' || lower === 'toupper') && tokens[index + 1] === '(') {
    const [inner, nextIndex] = parseOperand(tokens, index + 2);
    if (tokens[nextIndex] !== ')') {
      throw new Error(`Malformed ${lower} invocation. Expected closing parenthesis.`);
    }
    return [applyTransform(inner, lower as OperandTransform), nextIndex + 1];
  }

  if (token === '(') {
    const [inner, nextIndex] = parseOperand(tokens, index + 1);
    if (tokens[nextIndex] !== ')') {
      throw new Error('Unmatched parenthesis in function argument.');
    }
    return [inner, nextIndex + 1];
  }

  if (token.startsWith("'") && token.endsWith("'")) {
    return [{kind: 'literal', value: token.slice(1, -1)}, index + 1];
  }

  if (token === 'null') {
    return [{kind: 'literal', value: null}, index + 1];
  }

  if (token === 'true' || token === 'false') {
    return [{kind: 'literal', value: token === 'true'}, index + 1];
  }

  const numeric = Number(token);
  if (!Number.isNaN(numeric)) {
    return [{kind: 'literal', value: numeric}, index + 1];
  }

  return [{kind: 'field', name: token}, index + 1];
}

function parseFunction(tokens: string[], index: number): [FunctionExpression, number] | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'contains' && name !== 'startswith' && name !== 'endswith') {
    return undefined;
  }

  if (tokens[index + 1] !== '(') {
    throw new Error(`Malformed ${name} invocation. Expected opening parenthesis.`);
  }

  const [fieldOperand, afterField] = parseOperand(tokens, index + 2);
  if (fieldOperand.kind !== 'field') {
    throw new Error(`${name} requires the first argument to be a field.`);
  }

  if (tokens[afterField] !== ',') {
    throw new Error(`${name} requires a value argument.`);
  }

  const [valueOperand, afterValue] = parseOperand(tokens, afterField + 1);
  if (valueOperand.kind !== 'literal') {
    throw new Error(`${name} requires the second argument to be a literal.`);
  }

  if (tokens[afterValue] !== ')') {
    throw new Error(`Malformed ${name} invocation. Expected closing parenthesis.`);
  }

  let value = valueOperand.value;
  if (typeof value === 'string') {
    if (fieldOperand.transform === 'tolower' || valueOperand.transform === 'tolower') {
      value = value.toLowerCase();
    } else if (fieldOperand.transform === 'toupper' || valueOperand.transform === 'toupper') {
      value = value.toUpperCase();
    }
  }

  return [
    {
      operator: 'function',
      name,
      field: fieldOperand.name,
      args: [value],
      caseInsensitive: true,
    },
    afterValue + 1,
  ];
}

function parseFieldFunctionComparison(tokens: string[], index: number): [{operator: 'fncmp'; name: 'round' | 'floor' | 'ceiling' | 'year'; field: string; comparator: string; value: number}, number] | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'round' && name !== 'floor' && name !== 'ceiling' && name !== 'year') return undefined;
  if (tokens[index + 1] !== '(') {
    throw new Error(`Malformed ${name} invocation. Expected opening parenthesis.`);
  }
  const [fieldOperand, afterField] = parseOperand(tokens, index + 2);
  if (fieldOperand.kind !== 'field') {
    throw new Error(`${name} requires the first argument to be a field.`);
  }
  if (tokens[afterField] !== ')') {
    throw new Error(`Malformed ${name} invocation. Expected closing parenthesis.`);
  }
  const comparator = tokens[afterField + 1]?.toLowerCase();
  const valueToken = tokens[afterField + 2];
  if (!comparator || valueToken == null) {
    throw new Error('Invalid filter expression');
  }
  if (!(comparator in comparisonOperators)) {
    throw new Error(`Unsupported comparator: ${comparator}`);
  }
  const numeric = Number(valueToken);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${name} requires a numeric literal comparator value.`);
  }
  return [{operator: 'fncmp', name: name as any, field: fieldOperand.name, comparator: comparisonOperators[comparator], value: numeric}, afterField + 3];
}

function parseComparison(tokens: string[], index: number): [ParsedExpression, number] {
  const fn = parseFunction(tokens, index);
  if (fn) {
    return [fn[0], fn[1]];
  }

  const fncmp = parseFieldFunctionComparison(tokens, index);
  if (fncmp) {
    return [fncmp[0], fncmp[1]];
  }

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

function parsePrimary(tokens: string[], index: number): [ParsedExpression, number] {
  const token = tokens[index];
  if (token?.toLowerCase() === 'not') {
    const [expr, nextIndex] = parsePrimary(tokens, index + 1);
    return [{operator: 'not', expr}, nextIndex];
  }
  if (token === '(') {
    const [expr, nextIndex] = parseExpression(tokens, index + 1);
    if (tokens[nextIndex] !== ')') {
      throw new Error('Unmatched parenthesis in filter expression.');
    }
    return [expr, nextIndex + 1];
  }

  return parseComparison(tokens, index);
}

function parseExpression(tokens: string[], index: number): [ParsedExpression, number] {
  let [left, nextIndex] = parsePrimary(tokens, index);

  while (nextIndex < tokens.length) {
    const logical = tokens[nextIndex]?.toLowerCase();
    if (logical !== 'and' && logical !== 'or') break;

    const [right, afterRight] = parsePrimary(tokens, nextIndex + 1);
    left = {
      operator: 'logical',
      type: logical,
      expressions: [left, right],
    };
    nextIndex = afterRight;
  }

  return [left, nextIndex];
}

function parseFilter(tokens: string[], startIndex = 0): [ParsedExpression, number] {
  if (startIndex >= tokens.length) {
    throw new Error('Empty filter expression');
  }

  return parseExpression(tokens, startIndex);
}

function buildWhere(expr: ParsedExpression): Where<AnyObject> {
  if (expr.operator === 'not') {
    const inner = expr.expr;
    if (inner.operator === 'comparison') {
      const inverse: Record<string, string> = {eq: 'neq', neq: 'eq', gt: 'lte', gte: 'lt', lt: 'gte', lte: 'gt'} as any;
      const comparator = inverse[inner.comparator] ?? 'neq';
      if (comparator === 'eq') {
        return {[inner.field]: inner.value as any};
      }
      return {[inner.field]: {[comparator]: inner.value} as AnyObject} as Where<AnyObject>;
    }
    if (inner.operator === 'function') {
      const clone: FunctionExpression = {...inner, negated: !inner.negated};
      return buildWhere(clone);
    }
    if (inner.operator === 'logical') {
      const inverted = inner.expressions.map(e => buildWhere({operator: 'not', expr: e}));
      const type = inner.type === 'and' ? 'or' : 'and';
      return {[type]: inverted} as Where<AnyObject>;
    }
    if (inner.operator === 'fncmp') {
      // Fallback to {not: ...} — connector support may vary
      return {not: buildWhere(inner)} as any;
    }
  }
  if (expr.operator === 'comparison') {
    const {field, comparator, value} = expr;
    if (comparator === 'eq') {
      return {[field]: value};
    }
    return {[field]: {[comparator]: value}};
  }

  if (expr.operator === 'function') {
    const value = expr.args[0];
    if (typeof value !== 'string') {
      throw new Error(`${expr.name} requires a string literal argument.`);
    }
    const escaped = value.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = expr.name === 'contains'
      ? `%${escaped}%`
      : expr.name === 'startswith'
        ? `${escaped}%`
        : `%${escaped}`;
    const clause: AnyObject = expr.negated
      ? {nlike: pattern, escape: '\\'}
      : {like: pattern, escape: '\\'};
    if (expr.caseInsensitive) clause.options = 'i';
    return {
      [expr.field]: clause,
    };
  }

  if (expr.operator === 'fncmp') {
    const {name, field, comparator, value} = expr;
    if (name === 'year') {
      if (comparator !== 'eq') {
        throw new Error('year() only supports eq comparator');
      }
      const start = new Date(Date.UTC(value, 0, 1, 0, 0, 0, 0));
      const end = new Date(Date.UTC(value + 1, 0, 1, 0, 0, 0, 0));
      return {
        and: [
          {[field]: {gte: start}},
          {[field]: {lt: end}},
        ],
      } as Where<AnyObject>;
    }
    if (name === 'floor') {
      if (comparator !== 'eq') throw new Error('floor() only supports eq comparator');
      return {and: [
        {[field]: {gte: value}},
        {[field]: {lt: value + 1}},
      ]} as Where<AnyObject>;
    }
    if (name === 'ceiling') {
      if (comparator !== 'eq') throw new Error('ceiling() only supports eq comparator');
      return {and: [
        {[field]: {gt: value - 1}},
        {[field]: {le: value}},
      ]} as Where<AnyObject>;
    }
    if (name === 'round') {
      if (comparator !== 'eq') throw new Error('round() only supports eq comparator');
      const lower = value - 0.5;
      const upper = value + 0.5;
      return {and: [
        {[field]: {gte: lower}},
        {[field]: {lt: upper}},
      ]} as Where<AnyObject>;
    }
  }

  if (expr.operator === 'logical') {
    const clauses = expr.expressions.map(buildWhere);
    return {[expr.type]: clauses} as Where<AnyObject>;
  }
  throw new Error('Unsupported filter expression');
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

function splitTopLevel(value: string, delimiter: string): string[] {
  const results: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (char === "'") {
      current += char;
      if (inString) {
        if (i + 1 < value.length && value[i + 1] === "'") {
          current += value[i + 1];
          i++;
        } else {
          inString = false;
        }
      } else {
        inString = true;
      }
      continue;
    }

    if (inString) {
      current += char;
      continue;
    }

    if (char === '(') {
      depth++;
      current += char;
      continue;
    }
    if (char === ')') {
      depth--;
      if (depth < 0) {
        throw new Error('Malformed expand expression: unmatched closing parenthesis.');
      }
      current += char;
      continue;
    }

    if (char === delimiter && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) results.push(trimmed);
      current = '';
      continue;
    }

    current += char;
  }

  if (inString) {
    throw new Error('Malformed expand expression: unterminated string literal.');
  }
  if (depth !== 0) {
    throw new Error('Malformed expand expression: unmatched parentheses.');
  }

  const trimmed = current.trim();
  if (trimmed) results.push(trimmed);
  return results;
}

function extractPathAndOptions(segment: string): {path: string; options?: string} {
  const trimmed = segment.trim();
  let start = -1;
  let depth = 0;
  let inString = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (char === "'") {
      if (inString) {
        if (i + 1 < trimmed.length && trimmed[i + 1] === "'") {
          i++;
        } else {
          inString = false;
        }
      } else {
        inString = true;
      }
      continue;
    }

    if (inString) continue;

    if (char === '(') {
      if (start === -1) start = i;
      depth++;
      continue;
    }

    if (char === ')') {
      depth--;
      if (depth < 0) {
        throw new Error('Malformed expand segment: unmatched closing parenthesis.');
      }
      if (depth === 0) {
        const options = trimmed.slice(start + 1, i).trim();
        const remainder = trimmed.slice(i + 1).trim();
        if (remainder) {
          throw new Error('Malformed expand segment: trailing characters after options.');
        }
        const path = trimmed.slice(0, start).trim();
        return options ? {path, options} : {path};
      }
      continue;
    }
  }

  if (depth !== 0) {
    throw new Error('Malformed expand segment: unmatched parentheses.');
  }

  return {path: trimmed};
}

function getTargetRelations(definition: unknown): RelationDefinitionMap | undefined {
  const resolver = (definition as {target?: () => typeof Entity} | undefined)?.target;
  if (typeof resolver !== 'function') return undefined;
  try {
    const target = resolver();
    const modelDef = (target as typeof Entity | undefined)?.definition as
      | {relations?: RelationDefinitionMap}
      | undefined;
    return modelDef?.relations as RelationDefinitionMap | undefined;
  } catch {
    return undefined;
  }
}

interface NormalizedInclude {
  relation: string;
  scope?: Filter<AnyObject>;
}

function normalizeInclude(include: InclusionFilter): NormalizedInclude {
  if (typeof include === 'string') {
    return {relation: include};
  }
  return {
    relation: include.relation,
    scope: include.scope as Filter<AnyObject> | undefined,
  };
}

function mergeInclusionList(
  existing: InclusionFilter[],
  additions: InclusionFilter[],
): InclusionFilter[] {
  const map = new Map<string, NormalizedInclude>();

  const upsert = (entry: InclusionFilter) => {
    const normalized = normalizeInclude(entry);
    const current = map.get(normalized.relation);
    if (current) {
      current.scope = mergeScopes(current.scope, normalized.scope);
    } else {
      map.set(normalized.relation, {
        relation: normalized.relation,
        scope: mergeScopes(undefined, normalized.scope),
      });
    }
  };

  existing.forEach(upsert);
  additions.forEach(upsert);

  return Array.from(map.values()).map(item =>
    item.scope ? {relation: item.relation, scope: item.scope} : {relation: item.relation},
  );
}

function projectRelationField(
  fields: Filter<AnyObject>['fields'] | undefined,
  relation: string,
): Filter<AnyObject>['fields'] | undefined {
  if (!fields) return fields;
  if (Array.isArray(fields)) {
    if (!fields.includes(relation)) fields.push(relation);
    return fields;
  }
  if (typeof fields === 'object') {
    fields[relation] = true;
    return fields;
  }
  if (typeof fields === 'string') {
    if (fields !== relation) {
      return [fields, relation];
    }
    return fields;
  }
  return fields;
}

function ensureFieldsIncludeRelations(
  target: Filter<AnyObject> | undefined,
  includes?: InclusionFilter[],
) {
  if (!target || !includes?.length) return;
  for (const include of includes) {
    const normalized = normalizeInclude(include);
    const nextFields = projectRelationField(target.fields, normalized.relation);
    if (nextFields !== undefined || target.fields !== undefined) {
      target.fields = nextFields;
    }
    if (normalized.scope) {
      ensureFieldsIncludeRelations(normalized.scope, normalized.scope.include as InclusionFilter[] | undefined);
    }
  }
}

function mergeScopes(
  target: Filter<AnyObject> | undefined,
  incoming?: Filter<AnyObject>,
): Filter<AnyObject> | undefined {
  if (!incoming) return target;
  const result = target ?? {};

  if (incoming.fields) {
    result.fields = {...(result.fields ?? {}), ...incoming.fields};
  }

  if (incoming.where) {
    if (result.where) {
      result.where = {
        and: [result.where, incoming.where],
      } as unknown as Filter<AnyObject>['where'];
    } else {
      result.where = incoming.where;
    }
  }

  if (incoming.order) {
    result.order = incoming.order;
  }

  if (incoming.limit !== undefined) {
    result.limit = incoming.limit;
  }

  if (incoming.offset !== undefined) {
    result.offset = incoming.offset;
  }

  if (incoming.include && incoming.include.length) {
    const existing = result.include ?? [];
    result.include = mergeInclusionList(existing, incoming.include);
    ensureFieldsIncludeRelations(result, result.include);
  }

  return result;
}

function parseExpandOptions(
  options: string,
  relations?: RelationDefinitionMap,
): {scope?: Filter<AnyObject>; includes?: InclusionFilter[]} {
  const tokens = splitTopLevel(options, ';');
  let scope: Filter<AnyObject> | undefined;
  let nestedIncludes: InclusionFilter[] | undefined;

  for (const token of tokens) {
    const entry = token.trim();
    if (!entry) continue;
    const eqIndex = entry.indexOf('=');
    if (eqIndex === -1) {
      throw new Error(`Invalid expand option: ${entry}`);
    }

    const key = entry.slice(0, eqIndex).trim().toLowerCase();
    const rawValue = entry.slice(eqIndex + 1).trim();
    if (!rawValue) {
      throw new Error(`Expand option ${key} requires a value.`);
    }

    switch (key) {
      case '$select': {
        const fields = parseSelect(rawValue);
        if (fields) {
          scope = mergeScopes(scope, {fields});
        }
        break;
      }
      case '$expand': {
        const includes = parseExpand(rawValue, relations);
        if (includes && includes.length) {
          nestedIncludes = nestedIncludes
            ? mergeInclusionList(nestedIncludes, includes)
            : includes;
        }
        break;
      }
      case '$filter': {
        const parsed = parseODataQuery({'$filter': rawValue}, {relations});
        if (parsed.where) {
          scope = mergeScopes(scope, {where: parsed.where});
        }
        break;
      }
      case '$orderby': {
        const order = parseOrder(rawValue);
        if (order && order.length) {
          scope = mergeScopes(scope, {order});
        }
        break;
      }
      case '$top': {
        const limit = Number(rawValue);
        if (!Number.isFinite(limit)) {
          throw new Error(`Invalid $top value: ${rawValue}`);
        }
        scope = mergeScopes(scope, {limit});
        break;
      }
      case '$skip': {
        const offset = Number(rawValue);
        if (!Number.isFinite(offset)) {
          throw new Error(`Invalid $skip value: ${rawValue}`);
        }
        scope = mergeScopes(scope, {offset});
        break;
      }
      case '$count': {
        // Nested $count is currently ignored; LoopBack filter does not surface inline counts for includes.
        break;
      }
      default:
        throw new Error(`Unsupported expand option: ${key}`);
    }
  }

  return {scope, includes: nestedIncludes};
}

function buildIncludeFromParts(
  parts: string[],
  options: string | undefined,
  relations?: RelationDefinitionMap,
): InclusionFilter {
  const [current, ...rest] = parts;
  if (!current) {
    throw new Error('Invalid $expand segment: missing relation name.');
  }

  const relationDef = relations?.[current];
  if (relations && !relationDef) {
    throw new Error(`Unknown expand relation: ${current}`);
  }

  const include: InclusionFilter = {relation: current};
  const nextRelations = getTargetRelations(relationDef);

  if (rest.length) {
    const child = buildIncludeFromParts(rest, options, nextRelations);
    include.scope = mergeScopes(include.scope, {include: [child]});
    return include;
  }

  if (options) {
    const {scope, includes} = parseExpandOptions(options, nextRelations);
    if (scope) {
      include.scope = mergeScopes(include.scope, scope);
    }
    if (includes && includes.length) {
      include.scope = mergeScopes(include.scope, {include: includes});
    }
  }

  return include;
}

function parseExpand(
  expand?: string | string[],
  relations?: RelationDefinitionMap,
): InclusionFilter[] | undefined {
  if (!expand) return undefined;

  const normalized = Array.isArray(expand) ? expand.join(',') : expand;
  const segments = splitTopLevel(normalized, ',');
  if (!segments.length) return undefined;

  const includeMap = new Map<string, NormalizedInclude>();

  for (const segment of segments) {
    const {path, options} = extractPathAndOptions(segment);
    const parts = path
      .split('/')
      .map(part => part.trim())
      .filter(Boolean);

    if (!parts.length) {
      throw new Error('Invalid $expand segment: missing relation name.');
    }

    const include = buildIncludeFromParts(parts, options, relations);
    const normalized = normalizeInclude(include);
    const existing = includeMap.get(normalized.relation);
    if (existing) {
      existing.scope = mergeScopes(existing.scope, normalized.scope);
    } else {
      includeMap.set(normalized.relation, {
        relation: normalized.relation,
        scope: mergeScopes(undefined, normalized.scope),
      });
    }
  }

  return includeMap.size
    ? Array.from(includeMap.values()).map(item =>
        item.scope ? {relation: item.relation, scope: item.scope} : {relation: item.relation},
      )
    : undefined;
}

export interface ParsedODataQuery extends Filter<AnyObject> {
  inlineCount?: boolean;
  search?: string;
}

export function parseODataQuery(query: QueryObject, options: ParseOptions = {}): ParsedODataQuery {
  const filter: ParsedODataQuery = {};
  const {relations} = options;

  if (options.strict) {
    const allowed = new Set(['$filter', '$orderby', '$top', '$skip', '$select', '$expand', '$count', '$search']);
    for (const key of Object.keys(query ?? {})) {
      if (key.startsWith('$') && !allowed.has(key)) {
        throw new Error(`Unsupported query option: ${key}`);
      }
    }
  }

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
    ensureFieldsIncludeRelations(filter, include);
  }

  const inlineCount = typeof query['$count'] === 'string' && query['$count'].toLowerCase() === 'true';
  if (inlineCount) {
    filter.inlineCount = true;
  }

  const search = typeof query['$search'] === 'string' ? query['$search'] : undefined;
  if (search) {
    filter.search = search;
  }

  return filter;
}

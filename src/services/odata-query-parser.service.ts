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

export type FunctionArg =
  | {kind: 'field'; name: string; transform?: OperandTransform}
  | {kind: 'literal'; value: unknown};

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

export type AggregationOperator = 'sum' | 'average' | 'min' | 'max' | 'count' | 'countdistinct';

export interface AggregationExpression {
  field?: string;
  operator: AggregationOperator;
  alias: string;
}

export interface AggregationSpec {
  groupBy: string[];
  aggregates: AggregationExpression[];
}

export interface ApplyPipeline {
  transformations: ApplyTransformation[];
}

export type ApplyTransformation =
  | ApplyFilterTransformation
  | ApplyGroupByTransformation
  | ApplyAggregateTransformation
  | ApplyOrderByTransformation
  | ApplySkipTransformation
  | ApplyTopTransformation
  | ApplyBottomTransformation
  | ApplyConcatTransformation;

export interface ApplyFilterTransformation {
  type: 'filter';
  expression: ParsedExpression;
}

export interface ApplyGroupByTransformation {
  type: 'groupby';
  keys: string[];
  aggregates: AggregationExpression[];
}

export interface ApplyAggregateTransformation {
  type: 'aggregate';
  expressions: AggregationExpression[];
}

export interface ApplyOrderByTransformation {
  type: 'orderby';
  items: Array<{field: string; direction: 'asc' | 'desc'}>;
}

export interface ApplySkipTransformation {
  type: 'skip';
  count: number;
}

export interface ApplyTopTransformation {
  type: 'top';
  count: number;
}

export interface ApplyBottomTransformation {
  type: 'bottom';
  count: number;
}

export interface ApplyConcatTransformation {
  type: 'concat';
  pipelines: ApplyPipeline[];
}

function isValidIdentifierSegment(segment: string): boolean {
  return /^[_A-Za-z][_A-Za-z0-9]*$/.test(segment);
}

function isValidPath(path: string): boolean {
  return path.split('/').every(segment => segment.length > 0 && isValidIdentifierSegment(segment));
}

interface LambdaExpressionNode {
  operator: 'lambda';
  lambdaType: 'any' | 'all';
  path: string[];
  alias: string;
  predicate: ParsedExpression;
}

export interface LambdaExpression {
  type: 'any' | 'all';
  path: string[];
  alias: string;
  predicate: ParsedExpression;
}

export type ComputeNode =
  | {type: 'path'; path: string[]}
  | {type: 'literal'; value: unknown}
  | {type: 'binary'; operator: 'add' | 'sub' | 'mul' | 'div' | 'mod'; left: ComputeNode; right: ComputeNode}
  | {type: 'function'; name: 'tolower' | 'toupper' | 'concat'; args: ComputeNode[]};

export interface ComputeExpression {
  alias: string;
  expression: ComputeNode;
}

export type ParsedExpression =
  | {operator: 'comparison'; field: string; comparator: string; value: unknown}
  | {operator: 'logical'; type: 'and' | 'or'; expressions: ParsedExpression[]}
  | {operator: 'not'; expr: ParsedExpression}
  | FunctionExpression
  | {operator: 'fncmp'; name: 'round' | 'floor' | 'ceiling' | 'year'; field: string; comparator: string; value: number}
  | {operator: 'stringfncmp'; name: 'trim' | 'concat'; args: FunctionArg[]; comparator: 'eq' | 'neq'; value: string}
  | {operator: 'datepart'; part: 'month' | 'day' | 'hour' | 'minute' | 'second'; field: string; comparator: string; value: number}
  | {operator: 'indexofcmp'; field: string; comparator: string; value: number; needle: string}
  | {operator: 'substrcmp'; field: string; start: number; length?: number; comparator: 'eq' | 'neq'; literal: string}
  | {operator: 'lengthcmp'; field: string; comparator: string; value: number}
  | LambdaExpressionNode;

type QueryObject = Record<string, string | string[] | undefined>;

interface ParseOptions {
  relations?: RelationDefinitionMap;
  strict?: boolean;
}

export class UnsupportedFilterError extends Error {
  functions: string[];

  constructor(functions: string[]) {
    const unique = Array.from(new Set(functions));
    super(`Unsupported filter functions: ${unique.join(', ')}`);
    this.name = 'UnsupportedFilterError';
    this.functions = unique;
  }
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

function operandToFunctionArg(operand: Operand): FunctionArg {
  if (operand.kind === 'field') {
    return {
      kind: 'field',
      name: operand.name,
      transform: operand.transform,
    };
  }
  return {
    kind: 'literal',
    value: operand.value,
  };
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

function parseStringFunctionComparison(tokens: string[], index: number): [{operator: 'stringfncmp'; name: 'trim' | 'concat'; args: FunctionArg[]; comparator: 'eq' | 'neq'; value: string}, number] | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'trim' && name !== 'concat') return undefined;
  if (tokens[index + 1] !== '(') {
    throw new Error(`Malformed ${name} invocation. Expected opening parenthesis.`);
  }

  const args: FunctionArg[] = [];
  let cursor = index + 2;
  while (cursor < tokens.length) {
    const [operand, next] = parseOperand(tokens, cursor);
    args.push(operandToFunctionArg(operand));
    cursor = next;
    if (tokens[cursor] === ',') {
      cursor += 1;
      continue;
    }
    break;
  }

  if (tokens[cursor] !== ')') {
    throw new Error(`Malformed ${name} invocation. Expected closing parenthesis.`);
  }

  if (name === 'trim' && args.length !== 1) {
    throw new Error('trim requires exactly one argument.');
  }
  if (name === 'concat' && args.length < 2) {
    throw new Error('concat requires at least two arguments.');
  }

  const comparatorToken = tokens[cursor + 1]?.toLowerCase();
  const valueToken = tokens[cursor + 2];
  if (!comparatorToken || valueToken == null) {
    throw new Error(`Invalid ${name} comparison.`);
  }
  if (comparatorToken !== 'eq' && comparatorToken !== 'ne') {
    throw new Error(`${name} comparison only supports eq/ne comparators.`);
  }

  const literal = parseLiteral(valueToken);
  if (typeof literal !== 'string') {
    throw new Error(`${name} comparison requires a string literal comparator value.`);
  }

  return [
    {
      operator: 'stringfncmp',
      name: name as 'trim' | 'concat',
      args,
      comparator: comparatorToken === 'eq' ? 'eq' : 'neq',
      value: literal,
    },
    cursor + 3,
  ];
}

function parseDatePartComparison(tokens: string[], index: number): [{operator: 'datepart'; part: 'month' | 'day' | 'hour' | 'minute' | 'second'; field: string; comparator: string; value: number}, number] | undefined {
  const name = tokens[index]?.toLowerCase();
  const supported: Record<string, 'month' | 'day' | 'hour' | 'minute' | 'second'> = {
    month: 'month',
    day: 'day',
    hour: 'hour',
    minute: 'minute',
    second: 'second',
  };
  const part = name ? supported[name] : undefined;
  if (!part) return undefined;
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
  const comparatorToken = tokens[afterField + 1]?.toLowerCase();
  const valueToken = tokens[afterField + 2];
  if (!comparatorToken || valueToken == null) {
    throw new Error(`Invalid ${name} comparison.`);
  }
  if (!(comparatorToken in comparisonOperators)) {
    throw new Error(`Unsupported comparator: ${comparatorToken}`);
  }
  const numeric = Number(valueToken);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${name} comparison requires a numeric literal comparator value.`);
  }
  return [
    {
      operator: 'datepart',
      part,
      field: fieldOperand.name,
      comparator: comparisonOperators[comparatorToken],
      value: numeric,
    },
    afterField + 3,
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

function parseIndexOfComparison(tokens: string[], index: number): [{operator: 'indexofcmp'; field: string; comparator: string; value: number; needle: string}, number] | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'indexof') return undefined;
  if (tokens[index + 1] !== '(') throw new Error('Malformed indexof invocation. Expected opening parenthesis.');
  const [fieldOperand, afterField] = parseOperand(tokens, index + 2);
  if (fieldOperand.kind !== 'field') throw new Error('indexof requires the first argument to be a field.');
  if (tokens[afterField] !== ',') throw new Error('indexof requires a search literal.');
  const [litOperand, afterLit] = parseOperand(tokens, afterField + 1);
  if (litOperand.kind !== 'literal' || typeof litOperand.value !== 'string') {
    throw new Error('indexof requires a string literal as second argument.');
  }
  if (tokens[afterLit] !== ')') throw new Error('Malformed indexof invocation. Expected closing parenthesis.');
  const comparator = tokens[afterLit + 1]?.toLowerCase();
  const valueToken = tokens[afterLit + 2];
  if (!comparator || valueToken == null) throw new Error('Invalid indexof comparison.');
  if (!(comparator in comparisonOperators)) throw new Error(`Unsupported comparator: ${comparator}`);
  const numeric = Number(valueToken);
  if (!Number.isFinite(numeric)) throw new Error('indexof comparison requires a numeric value.');
  return [{operator: 'indexofcmp', field: fieldOperand.name, comparator: comparisonOperators[comparator], value: numeric, needle: String(litOperand.value)}, afterLit + 3];
}

function parseSubstringComparison(tokens: string[], index: number): [{operator: 'substrcmp'; field: string; start: number; length?: number; comparator: 'eq' | 'neq'; literal: string}, number] | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'substring') return undefined;
  if (tokens[index + 1] !== '(') throw new Error('Malformed substring invocation. Expected opening parenthesis.');
  const [fieldOperand, afterField] = parseOperand(tokens, index + 2);
  if (fieldOperand.kind !== 'field') throw new Error('substring requires the first argument to be a field.');
  if (tokens[afterField] !== ',') throw new Error('substring requires a start argument.');
  const [startOperand, afterStart] = parseOperand(tokens, afterField + 1);
  if (startOperand.kind !== 'literal' || typeof startOperand.value !== 'number') {
    throw new Error('substring start must be a numeric literal.');
  }
  let length: number | undefined;
  let afterArgs = afterStart;
  if (tokens[afterStart] === ',') {
    const [lenOperand, afterLen] = parseOperand(tokens, afterStart + 1);
    if (lenOperand.kind !== 'literal' || typeof lenOperand.value !== 'number') {
      throw new Error('substring length must be a numeric literal.');
    }
    length = Number(lenOperand.value);
    afterArgs = afterLen;
  }
  if (tokens[afterArgs] !== ')') throw new Error('Malformed substring invocation. Expected closing parenthesis.');
  const comparator = tokens[afterArgs + 1]?.toLowerCase();
  const rhs = tokens[afterArgs + 2];
  if (!comparator || rhs == null) throw new Error('Invalid substring comparison.');
  if (comparator !== 'eq' && comparator !== 'ne') throw new Error(`Unsupported comparator for substring: ${comparator}`);
  const literal = parseLiteral(rhs);
  if (typeof literal !== 'string') throw new Error('substring comparison requires a string literal.');
  return [{operator: 'substrcmp', field: fieldOperand.name, start: Number(startOperand.value), length, comparator: comparator === 'eq' ? 'eq' : 'neq', literal}, afterArgs + 3];
}

function parseLengthComparison(tokens: string[], index: number): [{operator: 'lengthcmp'; field: string; comparator: string; value: number}, number] | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'length') return undefined;
  if (tokens[index + 1] !== '(') throw new Error('Malformed length invocation. Expected opening parenthesis.');
  const [fieldOperand, afterField] = parseOperand(tokens, index + 2);
  if (fieldOperand.kind !== 'field') throw new Error('length requires the first argument to be a field.');
  if (tokens[afterField] !== ')') throw new Error('Malformed length invocation. Expected closing parenthesis.');
  const comparator = tokens[afterField + 1]?.toLowerCase();
  const valueToken = tokens[afterField + 2];
  if (!comparator || valueToken == null) throw new Error('Invalid length comparison.');
  if (!(comparator in comparisonOperators)) throw new Error(`Unsupported comparator: ${comparator}`);
  const numeric = Number(valueToken);
  if (!Number.isFinite(numeric)) throw new Error('length comparison requires a numeric value.');
  return [{operator: 'lengthcmp', field: fieldOperand.name, comparator: comparisonOperators[comparator], value: numeric}, afterField + 3];
}

function parseComparison(tokens: string[], index: number): [ParsedExpression, number] {
  const lambda = tryParseLambda(tokens, index);
  if (lambda) return lambda;

  const stringFnCmp = parseStringFunctionComparison(tokens, index);
  if (stringFnCmp) {
    return [stringFnCmp[0], stringFnCmp[1]];
  }

  const datePartCmp = parseDatePartComparison(tokens, index);
  if (datePartCmp) {
    return [datePartCmp[0], datePartCmp[1]];
  }

  const fn = parseFunction(tokens, index);
  if (fn) {
    return [fn[0], fn[1]];
  }

  const idx = parseIndexOfComparison(tokens, index);
  if (idx) return [idx[0], idx[1]];

  const sub = parseSubstringComparison(tokens, index);
  if (sub) return [sub[0], sub[1]];

  const len = parseLengthComparison(tokens, index);
  if (len) return [len[0], len[1]];

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

function tryParseLambda(tokens: string[], index: number): [LambdaExpressionNode, number] | undefined {
  const token = tokens[index];
  const match = token?.match(/^([A-Za-z_][A-Za-z0-9_\/]*)\/(any|all)$/i);
  if (!match) return undefined;
  if (tokens[index + 1] !== '(') {
    throw new Error(`Malformed ${match[2].toLowerCase()} expression. Expected opening parenthesis.`);
  }

  let depth = 0;
  const innerTokens: string[] = [];
  let i = index + 1;
  for (; i < tokens.length; i++) {
    const current = tokens[i];
    if (current === '(') {
      depth++;
      if (depth > 1) innerTokens.push(current);
      continue;
    }
    if (current === ')') {
      depth--;
      if (depth < 0) {
        throw new Error('Malformed lambda expression: unmatched closing parenthesis.');
      }
      if (depth === 0) {
        break;
      }
      innerTokens.push(current);
      continue;
    }
    innerTokens.push(current);
  }
  if (depth !== 0) {
    throw new Error('Malformed lambda expression: unmatched parentheses.');
  }
  if (i >= tokens.length) {
    throw new Error('Malformed lambda expression.');
  }

  const aliasToken = innerTokens.shift();
  if (!aliasToken) {
    throw new Error('Lambda expressions require an alias before the predicate.');
  }
  const alias = aliasToken.endsWith(':') ? aliasToken.slice(0, -1) : aliasToken;
  if (!alias) {
    throw new Error('Lambda alias cannot be empty.');
  }

  if (!innerTokens.length) {
    throw new Error('Lambda predicate is required.');
  }

  const [predicate, consumed] = parseExpression(innerTokens, 0);
  if (consumed !== innerTokens.length) {
    throw new Error('Unable to parse lambda predicate.');
  }

  const pathSegments = match[1].split('/').filter(Boolean);
  if (!pathSegments.length) {
    throw new Error('Lambda expressions must reference a navigation property.');
  }

  return [
    {
      operator: 'lambda',
      lambdaType: match[2].toLowerCase() as 'any' | 'all',
      path: pathSegments,
      alias,
      predicate,
    },
    i + 1,
  ];
}

function parseLiteral(token: string): unknown {
  if (!token) return token;

  if (token.startsWith("'") && token.endsWith("'")) {
    const inner = token.slice(1, -1);
    return inner.replace(/''/g, "'");
  }

  const lower = token.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;

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

function containsLambda(expr: ParsedExpression): boolean {
  if (expr.operator === 'lambda') return true;
  if (expr.operator === 'logical') {
    return expr.expressions.some(containsLambda);
  }
  if (expr.operator === 'not') {
    return containsLambda(expr.expr);
  }
  return false;
}

function splitLambdaExpression(expr: ParsedExpression): {
  lambda?: LambdaExpressionNode;
  predicate?: ParsedExpression;
} {
  if (expr.operator === 'lambda') {
    return {lambda: expr};
  }

  if (expr.operator === 'logical') {
    if (expr.type !== 'and') {
      if (containsLambda(expr)) {
        throw new Error('Lambda expressions combined with OR are not supported yet.');
      }
      return {predicate: expr};
    }
    let lambda: LambdaExpressionNode | undefined;
    const others: ParsedExpression[] = [];
    for (const child of expr.expressions) {
      const result = splitLambdaExpression(child);
      if (result.lambda) {
        if (lambda) {
          throw new Error('Multiple lambda expressions are not supported yet.');
        }
        lambda = result.lambda;
      }
      if (result.predicate) {
        others.push(result.predicate);
      }
    }
    let predicate: ParsedExpression | undefined;
    if (others.length === 1) {
      predicate = others[0];
    } else if (others.length > 1) {
      predicate = {
        operator: 'logical',
        type: 'and',
        expressions: others,
      };
    }
    return {lambda, predicate};
  }

  if (expr.operator === 'not' && containsLambda(expr)) {
    throw new Error('Negated lambda expressions are not supported yet.');
  }

  return {predicate: expr};
}

type IndexOfExpression = Extract<ParsedExpression, {operator: 'indexofcmp'}>;
type SubstringExpression = Extract<ParsedExpression, {operator: 'substrcmp'}>;
type LengthExpression = Extract<ParsedExpression, {operator: 'lengthcmp'}>;

function negateIndexOfExpression(expr: IndexOfExpression): IndexOfExpression {
  const {comparator, value} = expr;
  if (comparator === 'eq' && value === -1) {
    return {...expr, comparator: 'gte', value: 0};
  }
  if (comparator === 'gte' && value >= 0) {
    return {...expr, comparator: 'eq', value: -1};
  }
  if (comparator === 'gt' && value > -1) {
    return {...expr, comparator: 'eq', value: -1};
  }
  throw new Error('Unsupported negated indexof comparison.');
}

function negateSubstringExpression(expr: SubstringExpression): SubstringExpression {
  const inverted = expr.comparator === 'eq' ? 'neq' : 'eq';
  return {...expr, comparator: inverted as SubstringExpression['comparator']};
}

function negateLengthExpression(expr: LengthExpression): LengthExpression {
  const inverse: Record<LengthExpression['comparator'], LengthExpression['comparator']> = {
    eq: 'neq',
    neq: 'eq',
    gt: 'lte',
    gte: 'lt',
    lt: 'gte',
    lte: 'gt',
  };
  const comparator = inverse[expr.comparator];
  if (!comparator) {
    throw new Error('Unsupported negated length comparison.');
  }
  return {...expr, comparator};
}

function underscorePattern(length: number): string {
  return '_'.repeat(Math.max(0, length));
}

function translateLengthComparison(expr: LengthExpression): Where<AnyObject> {
  const {field, comparator, value} = expr;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('length comparison requires a non-negative integer value.');
  }
  if (!Number.isInteger(value)) {
    throw new Error('length comparison requires an integer literal.');
  }
  if (comparator === 'eq') {
    if (value === 0) return {[field]: ''} as Where<AnyObject>;
    return {[field]: {like: underscorePattern(value), escape: '\\'}} as Where<AnyObject>;
  }
  if (comparator === 'neq') {
    if (value === 0) return {[field]: {neq: ''}} as Where<AnyObject>;
    return {[field]: {nlike: underscorePattern(value), escape: '\\'}} as Where<AnyObject>;
  }
  if (comparator === 'gt') {
    if (value === 0) {
      return {[field]: {neq: ''}} as Where<AnyObject>;
    }
    return {[field]: {like: `${underscorePattern(value + 1)}%`, escape: '\\'}} as Where<AnyObject>;
  }
  if (comparator === 'gte') {
    if (value <= 0) {
      return {[field]: {like: '%', escape: '\\'}} as Where<AnyObject>;
    }
    return {[field]: {like: `${underscorePattern(value)}%`, escape: '\\'}} as Where<AnyObject>;
  }
  if (comparator === 'lt') {
    return {[field]: {nlike: `${underscorePattern(value)}%`, escape: '\\'}} as Where<AnyObject>;
  }
  if (comparator === 'lte') {
    if (value === 0) return {[field]: ''} as Where<AnyObject>;
    return {[field]: {nlike: `${underscorePattern(value + 1)}%`, escape: '\\'}} as Where<AnyObject>;
  }
  throw new Error('Unsupported length comparison.');
}

export function buildWhereFromParsedExpression(expr: ParsedExpression): Where<AnyObject> {
  return buildWhere(expr);
}

function buildWhere(expr: ParsedExpression): Where<AnyObject> {
  if (expr.operator === 'stringfncmp') {
    throw new UnsupportedFilterError([expr.name]);
  }

  if (expr.operator === 'datepart') {
    throw new UnsupportedFilterError([expr.part]);
  }

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
      return {not: buildWhere(inner)} as any;
    }
    if (inner.operator === 'indexofcmp') {
      return buildWhere(negateIndexOfExpression(inner));
    }
    if (inner.operator === 'substrcmp') {
      return buildWhere(negateSubstringExpression(inner));
    }
    if (inner.operator === 'lengthcmp') {
      return buildWhere(negateLengthExpression(inner));
    }
    if (inner.operator === 'stringfncmp') {
      throw new UnsupportedFilterError([inner.name]);
    }
    if (inner.operator === 'datepart') {
      throw new UnsupportedFilterError([inner.part]);
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

  if (expr.operator === 'indexofcmp') {
    const {field, comparator, value, needle} = expr;
    if ((comparator === 'gte' && value >= 0) || (comparator === 'gt' && value > -1)) {
      const lit = needle.replace(/%/g, '\\%').replace(/_/g, '\\_');
      return {[field]: {like: `%${lit}%`, escape: '\\', options: 'i'}} as Where<AnyObject>;
    }
    if (comparator === 'eq' && value === -1) {
      const lit = needle.replace(/%/g, '\\%').replace(/_/g, '\\_');
      return {[field]: {nlike: `%${lit}%`, escape: '\\', options: 'i'}} as Where<AnyObject>;
    }
    throw new Error('Unsupported indexof comparison. Supported: ge 0, gt -1, eq -1.');
  }

  if (expr.operator === 'substrcmp') {
    const {field, start, length, comparator, literal} = expr;
    const lit = literal.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const underscores = '_'.repeat(Math.max(0, start));
    const pattern = length !== undefined ? `${underscores}${lit}%` : `${underscores}${lit}`;
    const clause: AnyObject = comparator === 'eq'
      ? {like: pattern, escape: '\\'}
      : {nlike: pattern, escape: '\\'};
    return {[field]: clause} as Where<AnyObject>;
  }

  if (expr.operator === 'lengthcmp') {
    return translateLengthComparison(expr);
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
    const clauses: Where<AnyObject>[] = [];
    const unsupported: string[] = [];
    for (const child of expr.expressions) {
      try {
        clauses.push(buildWhere(child));
      } catch (err) {
        if (err instanceof UnsupportedFilterError) {
          unsupported.push(...err.functions);
        } else {
          throw err;
        }
      }
    }
    if (unsupported.length) {
      throw new UnsupportedFilterError(unsupported);
    }
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

function parseCompute(compute: string): ComputeExpression[] {
  const segments = splitTopLevel(compute, ',');
  if (!segments.length) {
    throw new Error('Invalid $compute expression.');
  }
  const results: ComputeExpression[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const tokens = tokenize(trimmed);
    if (!tokens.length) {
      throw new Error(`Invalid $compute expression: ${trimmed}`);
    }
    const {expressionTokens, alias} = extractComputeAlias(tokens);
    if (!alias) {
      throw new Error('Invalid $compute expression: missing alias.');
    }
    const node = parseComputeExpressionTokens(expressionTokens);
    results.push({alias, expression: node});
  }
  if (!results.length) {
    throw new Error('Invalid $compute expression.');
  }
  return results;
}

function extractComputeAlias(tokens: string[]): {expressionTokens: string[]; alias: string | undefined} {
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '(') {
      depth++;
      continue;
    }
    if (token === ')') {
      depth = Math.max(depth - 1, 0);
      continue;
    }
    if (depth === 0 && token.toLowerCase() === 'as') {
      const expressionTokens = tokens.slice(0, index);
      const aliasTokens = tokens.slice(index + 1).filter(Boolean);
      if (!aliasTokens.length) {
        throw new Error('Invalid $compute expression: alias is required.');
      }
      if (aliasTokens.length > 1) {
        throw new Error('Invalid $compute alias. Use simple identifiers without spaces.');
      }
      const alias = aliasTokens[0];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
        throw new Error(`Invalid $compute alias: ${alias}`);
      }
      if (!expressionTokens.length) {
        throw new Error('Invalid $compute expression: expression segment is empty.');
      }
      return {expressionTokens, alias};
    }
  }
  return {expressionTokens: tokens, alias: undefined};
}

function parseComputeExpressionTokens(tokens: string[]): ComputeNode {
  const {node, index} = parseComputeAddSub(tokens, 0);
  if (index !== tokens.length) {
    throw new Error(`Invalid $compute expression: unexpected token "${tokens[index]}"`);
  }
  return node;
}

function parseComputeAddSub(tokens: string[], index: number): {node: ComputeNode; index: number} {
  let {node, index: current} = parseComputeMulDiv(tokens, index);
  while (current < tokens.length) {
    const token = tokens[current].toLowerCase();
    if (token !== 'add' && token !== 'sub') break;
    const operator = token === 'add' ? 'add' : 'sub';
    const rhs = parseComputeMulDiv(tokens, current + 1);
    node = {type: 'binary', operator, left: node, right: rhs.node};
    current = rhs.index;
  }
  return {node, index: current};
}

function parseComputeMulDiv(tokens: string[], index: number): {node: ComputeNode; index: number} {
  let {node, index: current} = parseComputePrimary(tokens, index);
  while (current < tokens.length) {
    const token = tokens[current].toLowerCase();
    if (token !== 'mul' && token !== 'div' && token !== 'mod') break;
    const operator = token as 'mul' | 'div' | 'mod';
    const rhs = parseComputePrimary(tokens, current + 1);
    node = {type: 'binary', operator, left: node, right: rhs.node};
    current = rhs.index;
  }
  return {node, index: current};
}

function parseComputePrimary(tokens: string[], index: number): {node: ComputeNode; index: number} {
  if (index >= tokens.length) {
    throw new Error('Invalid $compute expression.');
  }

  const token = tokens[index];
  if (token === '(') {
    const inner = parseComputeAddSub(tokens, index + 1);
    if (inner.index >= tokens.length || tokens[inner.index] !== ')') {
      throw new Error('Invalid $compute expression: unmatched parenthesis.');
    }
    return {node: inner.node, index: inner.index + 1};
  }

  const lower = token.toLowerCase();
  if (isComputeFunction(lower) && tokens[index + 1] === '(') {
    const args: ComputeNode[] = [];
    let cursor = index + 2;
    if (cursor >= tokens.length) {
      throw new Error(`Invalid $compute function: ${token}`);
    }
    if (tokens[cursor] === ')') {
      cursor++;
    } else {
      while (cursor < tokens.length) {
        const parsed = parseComputeAddSub(tokens, cursor);
        args.push(parsed.node);
        cursor = parsed.index;
        if (cursor >= tokens.length) {
          throw new Error(`Invalid $compute function: ${token}`);
        }
        const delimiter = tokens[cursor];
        if (delimiter === ',') {
          cursor++;
          continue;
        }
        if (delimiter === ')') {
          cursor++;
          break;
        }
        throw new Error(`Invalid $compute function arguments for ${token}.`);
      }
    }
    return {
      node: {type: 'function', name: lower as 'tolower' | 'toupper' | 'concat', args},
      index: cursor,
    };
  }

  if (token.startsWith("'") && token.endsWith("'")) {
    return {
      node: {type: 'literal', value: unescapeStringLiteral(token)},
      index: index + 1,
    };
  }

  if (lower === 'null') {
    return {
      node: {type: 'literal', value: null},
      index: index + 1,
    };
  }

  if (lower === 'true' || lower === 'false') {
    return {
      node: {type: 'literal', value: lower === 'true'},
      index: index + 1,
    };
  }

  if (isNumericToken(token)) {
    return {
      node: {type: 'literal', value: Number(token)},
      index: index + 1,
    };
  }

  const pathSegments = token.split('/').map(part => part.trim()).filter(Boolean);
  if (!pathSegments.length) {
    throw new Error(`Invalid $compute path: ${token}`);
  }
  return {
    node: {type: 'path', path: pathSegments},
    index: index + 1,
  };
}

function isComputeFunction(name: string): name is 'tolower' | 'toupper' | 'concat' {
  return name === 'tolower' || name === 'toupper' || name === 'concat';
}

function unescapeStringLiteral(token: string): string {
  const trimmed = token.slice(1, -1);
  return trimmed.replace(/''/g, "'");
}

function isNumericToken(token: string): boolean {
  if (!token) return false;
  const num = Number(token);
  return !Number.isNaN(num);
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

function findClosingParen(value: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < value.length; i++) {
    const char = value[i];
    if (char === "'") {
      if (inString) {
        if (i + 1 < value.length && value[i + 1] === "'") {
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
      depth++;
      continue;
    }
    if (char === ')') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) break;
    }
  }
  throw new Error('Malformed expression: unmatched parentheses.');
}

export function parseApplyPipeline(apply: string): ApplyPipeline {
  const trimmed = (apply ?? '').trim();
  if (!trimmed) {
    throw new Error('Empty $apply expression.');
  }
  const segments = splitTopLevel(trimmed, '/');
  if (!segments.length) {
    throw new Error('Empty $apply expression.');
  }
  const transformations = segments.map(segment => parseApplyTransformation(segment.trim()));
  return {transformations};
}

function parseApplyTransformation(segment: string): ApplyTransformation {
  const trimmed = segment.trim();
  if (!trimmed) {
    throw new Error('Empty $apply transformation.');
  }

  const openIndex = trimmed.indexOf('(');
  if (openIndex === -1) {
    throw new Error(`Invalid $apply transformation: ${segment}`);
  }

  const name = trimmed.substring(0, openIndex).trim().toLowerCase();
  const closeIndex = findClosingParen(trimmed, openIndex);
  if (closeIndex === -1) {
    throw new Error(`Unbalanced parentheses inside $apply transformation: ${segment}`);
  }

  const remainder = trimmed.substring(closeIndex + 1).trim();
  if (remainder) {
    throw new Error(`Invalid $apply transformation: unexpected content "${remainder}".`);
  }

  const inner = trimmed.substring(openIndex + 1, closeIndex).trim();
  switch (name) {
    case 'filter':
      return parseApplyFilter(inner);
    case 'groupby':
      return parseApplyGroupBy(inner);
    case 'aggregate':
      return parseApplyAggregate(inner);
    case 'orderby':
      return parseApplyOrderBy(inner);
    case 'skip':
      return parseApplySkip(inner);
    case 'top':
      return parseApplyTop(inner);
    case 'bottom':
      return parseApplyBottom(inner);
    case 'concat':
      return parseApplyConcat(inner);
    default:
      throw new Error(`Unsupported $apply transformation: ${name}`);
  }
}

function parseApplyFilter(body: string): ApplyFilterTransformation {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error('filter() requires an expression.');
  }
  const tokens = tokenize(trimmed);
  if (!tokens.length) {
    throw new Error('filter() requires an expression.');
  }
  const [expression, next] = parseFilter(tokens);
  if (next !== tokens.length) {
    throw new Error('Invalid filter() transformation.');
  }
  return {type: 'filter', expression};
}

function parseApplyGroupBy(body: string): ApplyGroupByTransformation {
  const trimmed = body.trim();
  if (!trimmed.startsWith('(')) {
    throw new Error('groupby requires a list of properties in double parentheses.');
  }
  const groupClose = findClosingParen(trimmed, 0);
  if (groupClose === -1) {
    throw new Error('Unbalanced parentheses inside groupby().');
  }
  const groupFieldsExpr = trimmed.substring(1, groupClose).trim();
  const remainder = trimmed.substring(groupClose + 1).trim();

  const groupFields = groupFieldsExpr
    ? groupFieldsExpr.split(',').map(p => p.trim()).filter(Boolean)
    : [];

  if (!groupFields.length) {
    throw new Error('groupby requires at least one property.');
  }
  groupFields.forEach(field => {
    if (!isValidPath(field)) {
      throw new Error(`Unsupported group-by property: ${field}`);
    }
  });

  if (!remainder) {
    throw new Error('aggregate(...) clause is required within groupby.');
  }

  const aggregateMatch = remainder.match(/^,?\s*aggregate\s*\((.*)\)\s*$/i);
  if (!aggregateMatch) {
    throw new Error('Unsupported $apply expression. Expected aggregate(...) after groupby.');
  }
  const aggregateBody = aggregateMatch[1];
  const aggregateTokens = splitTopLevel(aggregateBody, ',');
  if (!aggregateTokens.length) {
    throw new Error('aggregate(...) must specify at least one aggregation.');
  }

  const aggregates: AggregationExpression[] = aggregateTokens.map(token => parseAggregateExpression(token));

  return {
    type: 'groupby',
    keys: groupFields,
    aggregates,
  };
}

function parseApplyAggregate(body: string): ApplyAggregateTransformation {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error('aggregate() requires at least one expression.');
  }
  const aggregateTokens = splitTopLevel(trimmed, ',');
  if (!aggregateTokens.length) {
    throw new Error('aggregate() requires at least one expression.');
  }
  const expressions = aggregateTokens.map(token => parseAggregateExpression(token));
  return {type: 'aggregate', expressions};
}

function parseApplyOrderBy(body: string): ApplyOrderByTransformation {
  const orderStrings = parseOrder(body);
  if (!orderStrings || !orderStrings.length) {
    throw new Error('orderby() requires at least one property.');
  }
  const items = orderStrings.map(item => {
    const [field, directionToken] = item.split(/\s+/);
    const direction = directionToken?.toLowerCase() === 'desc' ? 'desc' : 'asc';
    return {field, direction: direction as 'asc' | 'desc'};
  });
  return {type: 'orderby', items};
}

function parseApplySkip(body: string): ApplySkipTransformation {
  const count = parseNonNegativeInteger(body, 'skip');
  return {type: 'skip', count};
}

function parseApplyTop(body: string): ApplyTopTransformation {
  const count = parseNonNegativeInteger(body, 'top');
  return {type: 'top', count};
}

function parseApplyBottom(body: string): ApplyBottomTransformation {
  const count = parseNonNegativeInteger(body, 'bottom');
  return {type: 'bottom', count};
}

function parseApplyConcat(body: string): ApplyConcatTransformation {
  const segments = splitTopLevel(body, ',');
  if (segments.length < 2) {
    throw new Error('concat() requires at least two pipeline arguments.');
  }
  const pipelines = segments.map(segment => parseApplyPipeline(segment));
  return {
    type: 'concat',
    pipelines,
  };
}

function parseNonNegativeInteger(value: string, transformation: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${transformation}() requires a numeric argument.`);
  }
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`${transformation}() requires an integer argument.`);
  }
  const num = Number(trimmed);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`${transformation}() requires a non-negative integer argument.`);
  }
  return num;
}

function parseApply(apply: string): AggregationSpec | undefined {
  const pipeline = parseApplyPipeline(apply);
  return deriveAggregationSpecFromPipeline(pipeline);
}

function deriveAggregationSpecFromPipeline(pipeline: ApplyPipeline): AggregationSpec | undefined {
  let groupByKeys: string[] | undefined;
  const aggregates: AggregationExpression[] = [];
  let hasGroupingStage = false;

  for (const transformation of pipeline.transformations) {
    if (transformation.type === 'groupby') {
      if (groupByKeys !== undefined) {
        throw new Error('Multiple groupby() transformations are not supported.');
      }
      groupByKeys = [...transformation.keys];
      aggregates.push(...transformation.aggregates);
      hasGroupingStage = true;
    } else if (transformation.type === 'aggregate') {
      aggregates.push(...transformation.expressions);
      hasGroupingStage = true;
    } else if (transformation.type === 'concat') {
      if (hasGroupingStage) {
        continue;
      }
      let selectedSpec: AggregationSpec | undefined;
      let selectedHasPaging = false;
      for (const branch of transformation.pipelines) {
        const branchSpec = deriveAggregationSpecFromPipeline(branch);
        if (!branchSpec) continue;
        const branchHasPaging = pipelineHasPaging(branch);
        if (!selectedSpec || (branchHasPaging && !selectedHasPaging)) {
          selectedSpec = branchSpec;
          selectedHasPaging = branchHasPaging;
        }
      }
      if (selectedSpec) {
        return selectedSpec;
      }
    }
  }

  if (!hasGroupingStage || !aggregates.length) return undefined;
  return {
    groupBy: groupByKeys ?? [],
    aggregates,
  };
}

function parseAggregateExpression(raw: string): AggregationExpression {
  const expr = raw.trim();
  if (!expr) {
    throw new Error('Empty aggregate expression.');
  }

  const countOnly = expr.match(/^\$count\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (countOnly) {
    const alias = countOnly[1];
    if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(alias)) {
      throw new Error(`Invalid aggregate alias: ${alias}`);
    }
    return {
      field: undefined,
      operator: 'count',
      alias,
    };
  }

  const match = expr.match(/^([^\s]+)\s+with\s+([A-Za-z]+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (!match) {
    throw new Error(`Invalid aggregate expression: ${expr}`);
  }

  const fieldToken = match[1];
  const operatorToken = match[2].toLowerCase();
  const alias = match[3];

  if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(alias)) {
    throw new Error(`Invalid aggregate alias: ${alias}`);
  }

  const operatorMap: Record<string, AggregationOperator> = {
    sum: 'sum',
    min: 'min',
    max: 'max',
    average: 'average',
    avg: 'average',
    count: 'count',
    countdistinct: 'countdistinct',
  };

  const operator = operatorMap[operatorToken];
  if (!operator) {
    throw new Error(`Unsupported aggregation operator: ${operatorToken}`);
  }

  if (fieldToken === '*' && operator !== 'count') {
    throw new Error('Only count(*) is supported for the wildcard aggregator.');
  }

  if (fieldToken !== '*' && !isValidPath(fieldToken)) {
    throw new Error(`Unsupported aggregate property: ${fieldToken}`);
  }

  return {
    field: fieldToken === '*' ? undefined : fieldToken,
    operator,
    alias,
  };
}

function pipelineHasPaging(pipeline: ApplyPipeline): boolean {
  for (const transformation of pipeline.transformations) {
    switch (transformation.type) {
      case 'top':
      case 'skip':
        return true;
      case 'concat':
        if (transformation.pipelines.some(branch => pipelineHasPaging(branch))) {
          return true;
        }
        break;
      default:
        break;
    }
  }
  return false;
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
): {scope?: Filter<AnyObject>; includes?: InclusionFilter[]; levels?: number} {
  const tokens = splitTopLevel(options, ';');
  let scope: Filter<AnyObject> | undefined;
  let nestedIncludes: InclusionFilter[] | undefined;
  let levels: number | undefined;

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
      case '$levels': {
        if (levels !== undefined) {
          throw new Error('Duplicate $levels option is not allowed.');
        }
        if (rawValue.toLowerCase() === 'max') {
          throw new Error('$levels=max is not supported. Specify a numeric depth.');
        }
        const parsedLevel = Number(rawValue);
        if (!Number.isInteger(parsedLevel) || parsedLevel < 1) {
          throw new Error(`Invalid $levels value: ${rawValue}`);
        }
        levels = parsedLevel;
        break;
      }
      default:
        throw new Error(`Unsupported expand option: ${key}`);
    }
  }

  return {scope, includes: nestedIncludes, levels};
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
    const {scope, includes, levels} = parseExpandOptions(options, nextRelations);
    if (scope) {
      include.scope = mergeScopes(include.scope, scope);
    }
    if (includes && includes.length) {
      include.scope = mergeScopes(include.scope, {include: includes});
    }
    if (levels && levels > 1) {
      expandLevels(include, current, levels, nextRelations);
    }
  }

  return include;
}

function cloneScope(scope?: Filter<AnyObject>): Filter<AnyObject> | undefined {
  if (!scope) return undefined;
  const clone: Filter<AnyObject> = {...scope};
  if (scope.include) {
    const includes = Array.isArray(scope.include) ? scope.include : [scope.include];
    clone.include = includes.map(entry => cloneInclusion(entry));
  }
  return clone;
}

function cloneInclusion(include: InclusionFilter | string): InclusionFilter {
  if (typeof include === 'string') {
    return {relation: include};
  }
  const cloned: InclusionFilter = {relation: include.relation};
  if (include.scope) {
    const scopeClone = cloneScope(include.scope as Filter<AnyObject>);
    if (scopeClone) {
      cloned.scope = scopeClone;
    }
  }
  return cloned;
}

function expandLevels(
  include: InclusionFilter,
  relation: string,
  levels: number,
  relations?: RelationDefinitionMap,
) {
  if (typeof include === 'string') return;
  let parent = include;
  let currentRelations = relations;
  const templateScope = cloneScope(include.scope as Filter<AnyObject> | undefined);
  for (let depth = 1; depth < levels; depth++) {
    const relationDef = currentRelations?.[relation];
    if (!relationDef) break;
    const childScope = cloneScope(templateScope);
    const child: InclusionFilter = childScope ? {relation, scope: childScope} : {relation};
    if (typeof parent === 'string') break;
    const scope = (parent.scope ?? {}) as Filter<AnyObject>;
    const existing = scope.include;
    if (!existing) {
      scope.include = [child];
    } else if (Array.isArray(existing)) {
      scope.include = [...existing, child];
    } else {
      scope.include = [existing, child];
    }
    parent.scope = scope;
    parent = child;
    currentRelations = getTargetRelations(relationDef);
  }
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
  applyPipeline?: ApplyPipeline;
  apply?: AggregationSpec;
  lambda?: LambdaExpression;
  postFilter?: ParsedExpression;
  unsupportedFunctions?: string[];
  skipToken?: string;
  deltaToken?: string;
  format?: string;
  compute?: ComputeExpression[];
}

export function parseODataQuery(query: QueryObject, options: ParseOptions = {}): ParsedODataQuery {
  const filter: ParsedODataQuery = {};
  const {relations} = options;

  if (options.strict) {
    const allowed = new Set(['$filter', '$orderby', '$top', '$skip', '$skiptoken', '$deltatoken', '$select', '$expand', '$count', '$search', '$apply', '$format', '$compute']);
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
      const {lambda, predicate} = splitLambdaExpression(expr);
      if (lambda) {
        filter.lambda = {
          type: lambda.lambdaType,
          path: lambda.path,
          alias: lambda.alias,
          predicate: lambda.predicate,
        };
      }
      if (predicate) {
        try {
          filter.where = buildWhere(predicate);
        } catch (err) {
          if (err instanceof UnsupportedFilterError) {
            filter.postFilter = predicate;
            filter.unsupportedFunctions = err.functions;
            delete filter.where;
          } else {
            throw err;
          }
        }
      }
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

  const skiptoken = typeof query['$skiptoken'] === 'string' ? query['$skiptoken'] : undefined;
  if (skiptoken) {
    filter.skipToken = skiptoken;
  }

  const delta = typeof query['$deltatoken'] === 'string' ? query['$deltatoken'] : undefined;
  if (delta) {
    filter.deltaToken = delta;
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

  const apply = typeof query['$apply'] === 'string' ? query['$apply'] : undefined;
  if (apply) {
    const pipeline = parseApplyPipeline(apply);
    filter.applyPipeline = pipeline;
    filter.apply = deriveAggregationSpecFromPipeline(pipeline);
  }

  const format = typeof query['$format'] === 'string' ? query['$format'] : undefined;
  if (format) {
    filter.format = format;
  }

  const computeRaw = typeof query['$compute'] === 'string' ? query['$compute'] : undefined;
  if (computeRaw) {
    filter.compute = parseCompute(computeRaw);
  }

  return filter;
}

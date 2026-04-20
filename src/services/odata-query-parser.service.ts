import {
  Filter,
  Where,
  AnyObject,
  InclusionFilter,
  RelationDefinitionMap,
  Entity,
} from '@loopback/repository';
import { HttpErrors } from '@loopback/rest';
import { escapeLikeLiteral } from '../util/like-escaping';
import { ODataErrorCodes } from '../odata-error-codes';
import { unwrapODataTypedLiteral } from '../util/odata-literals';

const comparisonOperators: Record<string, string> = {
  eq: 'eq',
  ne: 'neq',
  gt: 'gt',
  ge: 'gte',
  lt: 'lt',
  le: 'lte',
};

const DEFAULT_MAX_FILTER_PATTERN_LENGTH = 10_000;
const DEFAULT_MAX_SUBSTRING_START = 10_000;
const DEFAULT_MAX_SUBSTRING_LENGTH = 10_000;
const DEFAULT_MAX_FILTER_FIELD_NAME_LENGTH = 256;
const DEFAULT_MAX_IN_LIST_ITEMS = 100;
const FILTER_FIELD_NAME_PATTERN = /^[_A-Za-z][0-9A-Za-z_./]*$/;
const DANGEROUS_FIELD_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

type FunctionExpression = {
  operator: 'function';
  name: 'contains' | 'startswith' | 'endswith';
  field: string;
  args: unknown[];
  caseInsensitive: boolean;
  transform?: OperandTransform;
  negated?: boolean;
};

type OperandTransform = 'tolower' | 'toupper';

export type FunctionArg =
  | { kind: 'field'; name: string; transform?: OperandTransform }
  | { kind: 'literal'; value: unknown };

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
  expression?: ComputeNode;
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
  items: Array<{ field: string; direction: 'asc' | 'desc' }>;
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
  return path
    .split('/')
    .every((segment) => segment.length > 0 && isValidIdentifierSegment(segment));
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
  | { type: 'path'; path: string[] }
  | { type: 'literal'; value: unknown }
  | {
      type: 'binary';
      operator: 'add' | 'sub' | 'mul' | 'div' | 'mod';
      left: ComputeNode;
      right: ComputeNode;
    }
  | { type: 'function'; name: 'tolower' | 'toupper' | 'concat'; args: ComputeNode[] };

export interface ComputeExpression {
  alias: string;
  expression: ComputeNode;
}

export type ParsedExpression =
  | { operator: 'comparison'; field: string; comparator: string; value: unknown }
  | { operator: 'logical'; type: 'and' | 'or'; expressions: ParsedExpression[] }
  | { operator: 'not'; expr: ParsedExpression }
  | FunctionExpression
  | {
      operator: 'transformcmp';
      transform: 'tolower' | 'toupper';
      field: string;
      comparator: 'eq' | 'neq';
      value: string | null;
    }
  | {
      operator: 'fncmp';
      name: 'round' | 'floor' | 'ceiling' | 'year';
      field: string;
      comparator: string;
      value: number;
    }
  | {
      operator: 'stringfncmp';
      name: 'trim' | 'concat';
      args: FunctionArg[];
      comparator: 'eq' | 'neq';
      value: string;
    }
  | {
      operator: 'datepart';
      part: 'month' | 'day' | 'hour' | 'minute' | 'second';
      field: string;
      comparator: string;
      value: number;
    }
  | { operator: 'indexofcmp'; field: string; comparator: string; value: number; needle: string }
  | {
      operator: 'substrcmp';
      field: string;
      start: number;
      length?: number;
      comparator: 'eq' | 'neq';
      literal: string;
    }
  | { operator: 'lengthcmp'; field: string; comparator: string; value: number }
  | LambdaExpressionNode;

type QueryObject = Record<string, string | string[] | undefined>;

interface ParseOptions {
  relations?: RelationDefinitionMap;
  strict?: boolean;
  maxFilterPatternLength?: number;
  maxSubstringStart?: number;
  maxSubstringLength?: number;
  maxFilterFieldNameLength?: number;
  maxLambdaExistsDepth?: number;
  maxInListItems?: number;
}

type ParseContext = { strict: boolean };

function badRequestWithCode(message: string, code: string): HttpErrors.HttpError {
  const err = new HttpErrors.BadRequest(message);
  (err as AnyObject).code = code;
  return err;
}

function isInListLiteralToken(token: string): boolean {
  const raw = String(token ?? '').trim();
  if (!raw) return false;
  if (raw.startsWith("'") && raw.endsWith("'")) return true;

  const lower = raw.toLowerCase();
  if (lower === 'null' || lower === 'true' || lower === 'false') return true;

  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return true;
  if (/^-?\d+[lL]$/.test(raw)) return true;

  if (/^(datetimeoffset|date|guid|decimal|int64)'/i.test(raw) && raw.endsWith("'")) return true;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return true;
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|z|[+-]\d{2}(?::?\d{2})?)?$/.test(raw)
  ) {
    return true;
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return true;

  return false;
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

export class LambdaQueryRejectedError extends Error {
  reason: string;
  lambdasCount: number;
  paths: string[];

  constructor(message: string, info: { reason: string; paths: string[] }) {
    super(message);
    this.name = 'LambdaQueryRejectedError';
    this.reason = info.reason;
    this.paths = [...info.paths];
    this.lambdasCount = info.paths.length;
  }
}

function tokenize(filter: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < filter.length; i++) {
    const char = filter[i];

    if (char === "'") {
      if (inString && filter[i + 1] === "'") {
        // Escaped quote inside string literal (OData uses doubled quotes: '')
        current += "''";
        i++;
        continue;
      }
      inString = !inString;
      current += "'";
      continue;
    }

    if (!inString) {
      // Note: ':' is used by lambda aliases (e.g. nav/any(x: ...)), but it is also a
      // valid character inside DateTimeOffset literals (e.g. 2026-01-03T10:20:30Z).
      // We keep ':' as part of tokens unless it appears as a standalone token due to whitespace.
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
  if (inString) {
    throw new Error('Unterminated string literal in filter expression.');
  }

  return tokens;
}

function applyTransform(operand: Operand, transform: OperandTransform): Operand {
  if (operand.kind === 'field') {
    return { ...operand, transform };
  }

  if (operand.kind === 'literal' && typeof operand.value === 'string') {
    const value =
      transform === 'tolower' ? operand.value.toLowerCase() : operand.value.toUpperCase();
    return { ...operand, value, transform };
  }

  return { ...operand, transform };
}

function tryParseNumericToken(token: string): number | undefined {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) return undefined;

  // Preserve large/high-precision numerics as strings so controller-side coercion can decide
  // how to interpret them (e.g. decimal/int64), avoiding JS precision loss.
  const intMatch = /^-?\d+$/.test(trimmed);
  if (intMatch) {
    const digits = trimmed.replace(/^-?/, '');
    if (digits.length > 15) return undefined;
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric)) return undefined;
    return numeric;
  }

  const decimalOrExponent = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed);
  if (decimalOrExponent) {
    const [significand] = trimmed.split(/[eE]/);
    const fraction = significand.includes('.') ? (significand.split('.')[1] ?? '') : '';
    const significantDigits = significand
      .replace(/^-?/, '')
      .replace('.', '')
      .replace(/^0+/, '').length;
    if (fraction.length > 15) return undefined;
    if (significantDigits > 15) return undefined;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return undefined;
    return numeric;
  }

  return undefined;
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
    return [{ kind: 'literal', value: token.slice(1, -1).replace(/''/g, "'") }, index + 1];
  }

  if (token === 'null') {
    return [{ kind: 'literal', value: null }, index + 1];
  }

  if (token === 'true' || token === 'false') {
    return [{ kind: 'literal', value: token === 'true' }, index + 1];
  }

  const numeric = tryParseNumericToken(token);
  if (numeric !== undefined) return [{ kind: 'literal', value: numeric }, index + 1];

  return [{ kind: 'field', name: token }, index + 1];
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
      transform: fieldOperand.transform,
    },
    afterValue + 1,
  ];
}

function parseStringFunctionComparison(
  tokens: string[],
  index: number,
):
  | [
      {
        operator: 'stringfncmp';
        name: 'trim' | 'concat';
        args: FunctionArg[];
        comparator: 'eq' | 'neq';
        value: string;
      },
      number,
    ]
  | undefined {
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

function parseDatePartComparison(
  tokens: string[],
  index: number,
):
  | [
      {
        operator: 'datepart';
        part: 'month' | 'day' | 'hour' | 'minute' | 'second';
        field: string;
        comparator: string;
        value: number;
      },
      number,
    ]
  | undefined {
  const name = tokens[index]?.toLowerCase();
  const supported: Record<string, 'month' | 'day' | 'hour' | 'minute' | 'second'> = {
    month: 'month',
    day: 'day',
    hour: 'hour',
    minute: 'minute',
    second: 'second',
  };
  const part =
    name && Object.prototype.hasOwnProperty.call(supported, name) ? supported[name] : undefined;
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
  if (!Object.prototype.hasOwnProperty.call(comparisonOperators, comparatorToken)) {
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

function parseFieldFunctionComparison(
  tokens: string[],
  index: number,
):
  | [
      {
        operator: 'fncmp';
        name: 'round' | 'floor' | 'ceiling' | 'year';
        field: string;
        comparator: string;
        value: number;
      },
      number,
    ]
  | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'round' && name !== 'floor' && name !== 'ceiling' && name !== 'year')
    return undefined;
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
  if (!Object.prototype.hasOwnProperty.call(comparisonOperators, comparator)) {
    throw new Error(`Unsupported comparator: ${comparator}`);
  }
  const numeric = Number(valueToken);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${name} requires a numeric literal comparator value.`);
  }
  return [
    {
      operator: 'fncmp',
      name: name as any,
      field: fieldOperand.name,
      comparator: comparisonOperators[comparator],
      value: numeric,
    },
    afterField + 3,
  ];
}

function parseIndexOfComparison(
  tokens: string[],
  index: number,
):
  | [
      { operator: 'indexofcmp'; field: string; comparator: string; value: number; needle: string },
      number,
    ]
  | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'indexof') return undefined;
  if (tokens[index + 1] !== '(')
    throw new Error('Malformed indexof invocation. Expected opening parenthesis.');
  const [fieldOperand, afterField] = parseOperand(tokens, index + 2);
  if (fieldOperand.kind !== 'field')
    throw new Error('indexof requires the first argument to be a field.');
  if (tokens[afterField] !== ',') throw new Error('indexof requires a search literal.');
  const [litOperand, afterLit] = parseOperand(tokens, afterField + 1);
  if (litOperand.kind !== 'literal' || typeof litOperand.value !== 'string') {
    throw new Error('indexof requires a string literal as second argument.');
  }
  if (tokens[afterLit] !== ')')
    throw new Error('Malformed indexof invocation. Expected closing parenthesis.');
  const comparator = tokens[afterLit + 1]?.toLowerCase();
  const valueToken = tokens[afterLit + 2];
  if (!comparator || valueToken == null) throw new Error('Invalid indexof comparison.');
  if (!Object.prototype.hasOwnProperty.call(comparisonOperators, comparator))
    throw new Error(`Unsupported comparator: ${comparator}`);
  const numeric = Number(valueToken);
  if (!Number.isFinite(numeric)) throw new Error('indexof comparison requires a numeric value.');
  return [
    {
      operator: 'indexofcmp',
      field: fieldOperand.name,
      comparator: comparisonOperators[comparator],
      value: numeric,
      needle: String(litOperand.value),
    },
    afterLit + 3,
  ];
}

function parseSubstringComparison(
  tokens: string[],
  index: number,
):
  | [
      {
        operator: 'substrcmp';
        field: string;
        start: number;
        length?: number;
        comparator: 'eq' | 'neq';
        literal: string;
      },
      number,
    ]
  | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'substring') return undefined;
  if (tokens[index + 1] !== '(')
    throw new Error('Malformed substring invocation. Expected opening parenthesis.');
  const [fieldOperand, afterField] = parseOperand(tokens, index + 2);
  if (fieldOperand.kind !== 'field')
    throw new Error('substring requires the first argument to be a field.');
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
  if (tokens[afterArgs] !== ')')
    throw new Error('Malformed substring invocation. Expected closing parenthesis.');
  const comparator = tokens[afterArgs + 1]?.toLowerCase();
  const rhs = tokens[afterArgs + 2];
  if (!comparator || rhs == null) throw new Error('Invalid substring comparison.');
  if (comparator !== 'eq' && comparator !== 'ne')
    throw new Error(`Unsupported comparator for substring: ${comparator}`);
  const literal = parseLiteral(rhs);
  if (typeof literal !== 'string')
    throw new Error('substring comparison requires a string literal.');
  return [
    {
      operator: 'substrcmp',
      field: fieldOperand.name,
      start: Number(startOperand.value),
      length,
      comparator: comparator === 'eq' ? 'eq' : 'neq',
      literal,
    },
    afterArgs + 3,
  ];
}

function parseLengthComparison(
  tokens: string[],
  index: number,
):
  | [{ operator: 'lengthcmp'; field: string; comparator: string; value: number }, number]
  | undefined {
  const name = tokens[index]?.toLowerCase();
  if (name !== 'length') return undefined;
  if (tokens[index + 1] !== '(')
    throw new Error('Malformed length invocation. Expected opening parenthesis.');
  const [fieldOperand, afterField] = parseOperand(tokens, index + 2);
  if (fieldOperand.kind !== 'field')
    throw new Error('length requires the first argument to be a field.');
  if (tokens[afterField] !== ')')
    throw new Error('Malformed length invocation. Expected closing parenthesis.');
  const comparator = tokens[afterField + 1]?.toLowerCase();
  const valueToken = tokens[afterField + 2];
  if (!comparator || valueToken == null) throw new Error('Invalid length comparison.');
  if (!Object.prototype.hasOwnProperty.call(comparisonOperators, comparator))
    throw new Error(`Unsupported comparator: ${comparator}`);
  const numeric = Number(valueToken);
  if (!Number.isFinite(numeric)) throw new Error('length comparison requires a numeric value.');
  return [
    {
      operator: 'lengthcmp',
      field: fieldOperand.name,
      comparator: comparisonOperators[comparator],
      value: numeric,
    },
    afterField + 3,
  ];
}

function parseInComparison(
  tokens: string[],
  index: number,
  ctx: ParseContext,
): [ParsedExpression, number] | undefined {
  const field = tokens[index];
  const comparator = tokens[index + 1]?.toLowerCase();
  if (!field || comparator !== 'in') return undefined;
  if (tokens[index + 2] !== '(') {
    throw new Error('Malformed in expression. Expected opening parenthesis.');
  }

  const values: unknown[] = [];
  let cursor = index + 3;
  let expectValue = true;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === ')') {
      if (expectValue && values.length) {
        throw new Error('Malformed in expression. Expected list item.');
      }
      break;
    }
    if (expectValue) {
      if (token === ',') {
        throw new Error('Malformed in expression. Expected list item.');
      }
      if (ctx.strict && !isInListLiteralToken(token)) {
        throw badRequestWithCode(
          'in operator requires literal list items.',
          ODataErrorCodes.InOperatorRequiresLiteralListItems,
        );
      }
      values.push(parseLiteral(token));
      cursor += 1;
      expectValue = false;
      continue;
    }

    if (token !== ',') {
      throw new Error('Malformed in expression. Expected comma between list items.');
    }
    cursor += 1;
    expectValue = true;
  }

  if (tokens[cursor] !== ')') {
    throw new Error('Malformed in expression. Expected closing parenthesis.');
  }
  if (!values.length) {
    throw badRequestWithCode(
      'in operator requires at least one list item.',
      ODataErrorCodes.InOperatorRequiresNonEmptyList,
    );
  }

  return [
    {
      operator: 'comparison',
      field,
      comparator: 'inq',
      value: values,
    },
    cursor + 1,
  ];
}

function parseComparison(
  tokens: string[],
  index: number,
  ctx: ParseContext,
): [ParsedExpression, number] {
  const lambda = tryParseLambda(tokens, index, ctx);
  if (lambda) return lambda;

  const transformCmp = parseTransformComparison(tokens, index);
  if (transformCmp) return transformCmp;

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

  const inCmp = parseInComparison(tokens, index, ctx);
  if (inCmp) return inCmp;

  const field = tokens[index];
  const comparator = tokens[index + 1];
  const valueToken = tokens[index + 2];

  if (!field || !comparator || valueToken === undefined) {
    throw new Error('Invalid filter expression');
  }

  const normalizedComparator = comparator.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(comparisonOperators, normalizedComparator)) {
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

function parseTransformComparison(
  tokens: string[],
  index: number,
):
  | [
      {
        operator: 'transformcmp';
        transform: 'tolower' | 'toupper';
        field: string;
        comparator: 'eq' | 'neq';
        value: string | null;
      },
      number,
    ]
  | undefined {
  const transformToken = tokens[index]?.toLowerCase();
  if (transformToken !== 'tolower' && transformToken !== 'toupper') return undefined;
  if (tokens[index + 1] !== '(') return undefined;

  const field = tokens[index + 2];
  const closing = tokens[index + 3];
  if (!field || closing !== ')') {
    throw new Error(`${transformToken} requires a single field argument.`);
  }
  if (
    field.startsWith("'") ||
    field.endsWith("'") ||
    field === '(' ||
    field === ')' ||
    field === ',' ||
    field.toLowerCase() === 'null' ||
    field.toLowerCase() === 'true' ||
    field.toLowerCase() === 'false' ||
    /^-?\d/.test(field) ||
    /^(datetimeoffset|date|guid|decimal|int64)'/i.test(field)
  ) {
    throw new Error(`${transformToken} requires a single field argument.`);
  }

  const comparatorToken = tokens[index + 4]?.toLowerCase();
  if (comparatorToken !== 'eq' && comparatorToken !== 'ne') {
    throw new Error(`${transformToken} comparisons support only eq/ne.`);
  }

  const valueToken = tokens[index + 5];
  if (valueToken == null) {
    throw new Error(`${transformToken} comparisons require a string or null literal.`);
  }

  const rawLower = valueToken.toLowerCase();
  const isNull = rawLower === 'null';
  const isStringLiteral = valueToken.startsWith("'") && valueToken.endsWith("'");
  if (!isNull && !isStringLiteral) {
    throw new Error(`${transformToken} comparisons require a string or null literal.`);
  }

  const value = parseLiteral(valueToken);
  if (value !== null && typeof value !== 'string') {
    throw new Error(`${transformToken} comparisons require a string or null literal.`);
  }

  return [
    {
      operator: 'transformcmp',
      transform: transformToken as 'tolower' | 'toupper',
      field,
      comparator: comparatorToken === 'eq' ? 'eq' : 'neq',
      value,
    },
    index + 6,
  ];
}

function tryParseLambda(
  tokens: string[],
  index: number,
  ctx: ParseContext,
): [LambdaExpressionNode, number] | undefined {
  const token = tokens[index];
  const match = token?.match(/^([A-Za-z_][A-Za-z0-9_\/]*)\/(any|all)$/i);
  if (!match) return undefined;
  if (tokens[index + 1] !== '(') {
    throw new Error(
      `Malformed ${match[2].toLowerCase()} expression. Expected opening parenthesis.`,
    );
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
  let alias = aliasToken;
  if (alias.endsWith(':')) {
    alias = alias.slice(0, -1);
  } else if (innerTokens[0] === ':') {
    innerTokens.shift();
  } else if (alias.includes(':')) {
    const idx = alias.indexOf(':');
    const before = alias.slice(0, idx);
    const after = alias.slice(idx + 1);
    if (!before) {
      throw new Error('Malformed lambda expression: expected alias before ":".');
    }
    alias = before;
    if (after) {
      innerTokens.unshift(after);
    }
  } else {
    throw new Error('Malformed lambda expression: expected ":" after alias.');
  }
  if (!alias) {
    throw new Error('Lambda alias cannot be empty.');
  }

  if (!innerTokens.length) {
    throw new Error('Lambda predicate is required.');
  }

  const [predicate, consumed] = parseExpression(innerTokens, 0, ctx);
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

  // Handle OData typed literals like guid'...', datetimeoffset'...', etc.
  if (/^(datetimeoffset|date|guid|decimal|int64)'/i.test(token) && token.endsWith("'")) {
    const lower = token.toLowerCase();
    if (lower.startsWith("guid'")) {
      const guidValue = unwrapODataTypedLiteral(token, 'guid');
      if (guidValue !== undefined) return guidValue;
    } else if (lower.startsWith("datetimeoffset'")) {
      const dtValue = unwrapODataTypedLiteral(token, 'datetimeoffset');
      if (dtValue !== undefined) return dtValue;
    } else if (lower.startsWith("date'")) {
      const dateValue = unwrapODataTypedLiteral(token, 'date');
      if (dateValue !== undefined) return dateValue;
    } else if (lower.startsWith("decimal'")) {
      const decimalValue = unwrapODataTypedLiteral(token, 'decimal');
      if (decimalValue !== undefined) return decimalValue;
    } else if (lower.startsWith("int64'")) {
      const int64Value = unwrapODataTypedLiteral(token, 'int64');
      if (int64Value !== undefined) return int64Value;
    }
    // If unwrapODataTypedLiteral returns undefined, fall through to return the original token
  }

  if (token.startsWith("'") && token.endsWith("'")) {
    const inner = token.slice(1, -1);
    return inner.replace(/''/g, "'");
  }

  const lower = token.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;

  const numeric = tryParseNumericToken(token);
  if (numeric !== undefined) return numeric;

  return token;
}

function parsePrimary(
  tokens: string[],
  index: number,
  ctx: ParseContext,
): [ParsedExpression, number] {
  const token = tokens[index];
  if (token === '(') {
    const [expr, nextIndex] = parseExpression(tokens, index + 1, ctx);
    if (tokens[nextIndex] !== ')') {
      throw new Error('Unmatched parenthesis in filter expression.');
    }
    return [expr, nextIndex + 1];
  }

  return parseComparison(tokens, index, ctx);
}

function parseExpression(
  tokens: string[],
  index: number,
  ctx: ParseContext,
): [ParsedExpression, number] {
  return parseOr(tokens, index, ctx);
}

function parseOr(tokens: string[], index: number, ctx: ParseContext): [ParsedExpression, number] {
  let [left, nextIndex] = parseAnd(tokens, index, ctx);
  while (nextIndex < tokens.length) {
    const token = tokens[nextIndex]?.toLowerCase();
    if (token !== 'or') break;
    const [right, afterRight] = parseAnd(tokens, nextIndex + 1, ctx);
    left = { operator: 'logical', type: 'or', expressions: [left, right] };
    nextIndex = afterRight;
  }
  return [left, nextIndex];
}

function parseAnd(tokens: string[], index: number, ctx: ParseContext): [ParsedExpression, number] {
  let [left, nextIndex] = parseUnary(tokens, index, ctx);
  while (nextIndex < tokens.length) {
    const token = tokens[nextIndex]?.toLowerCase();
    if (token !== 'and') break;
    const [right, afterRight] = parseUnary(tokens, nextIndex + 1, ctx);
    left = { operator: 'logical', type: 'and', expressions: [left, right] };
    nextIndex = afterRight;
  }
  return [left, nextIndex];
}

function parseUnary(
  tokens: string[],
  index: number,
  ctx: ParseContext,
): [ParsedExpression, number] {
  const token = tokens[index]?.toLowerCase();
  if (token === 'not') {
    const [expr, nextIndex] = parseUnary(tokens, index + 1, ctx);
    return [{ operator: 'not', expr }, nextIndex];
  }
  return parsePrimary(tokens, index, ctx);
}

function parseFilter(
  tokens: string[],
  startIndex = 0,
  ctx: ParseContext,
): [ParsedExpression, number] {
  if (startIndex >= tokens.length) {
    throw new Error('Empty filter expression');
  }

  return parseExpression(tokens, startIndex, ctx);
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

const DEFAULT_MAX_LAMBDA_EXISTS_DEPTH = 2;

function normalizeMaxLambdaDepth(options?: ParseOptions): number {
  const configured = options?.maxLambdaExistsDepth;
  if (configured === undefined || configured === null) return DEFAULT_MAX_LAMBDA_EXISTS_DEPTH;
  const value = Number(configured);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_LAMBDA_EXISTS_DEPTH;
  return Math.floor(value);
}

function listLambdaPaths(expr: ParsedExpression): string[] {
  const paths: string[] = [];
  const visit = (node: ParsedExpression) => {
    if (node.operator === 'lambda') {
      paths.push(node.path.join('/'));
      visit(node.predicate);
      return;
    }
    if (node.operator === 'logical') {
      node.expressions.forEach(visit);
      return;
    }
    if (node.operator === 'not') {
      visit(node.expr);
      return;
    }
  };
  visit(expr);
  return paths;
}

function assertAliasedField(field: string, aliasesInScope: string[], lambdaPaths: string[]): void {
  if (!aliasesInScope.length) return;
  const [token, ...rest] = String(field).split('/');
  if (!token || rest.length === 0 || !aliasesInScope.includes(token)) {
    throw new LambdaQueryRejectedError(
      'Fields inside lambda predicates must be prefixed with the lambda alias (lambda-alias-prefix-required).',
      { reason: ODataErrorCodes.LambdaAliasPrefixRequired, paths: lambdaPaths },
    );
  }
}

function validateLambdaExpressionTree(expr: ParsedExpression, options?: ParseOptions): void {
  if (!containsLambda(expr)) return;
  const maxDepth = normalizeMaxLambdaDepth(options);
  const lambdaPaths = listLambdaPaths(expr);

  const visit = (node: ParsedExpression, aliasesInScope: string[], depth: number) => {
    switch (node.operator) {
      case 'lambda': {
        const nextDepth = depth + 1;
        if (nextDepth > maxDepth) {
          throw new LambdaQueryRejectedError(
            `Nested lambda expressions exceed the maximum supported depth of ${maxDepth} (nested-lambda-depth-exceeded).`,
            { reason: ODataErrorCodes.NestedLambdaDepthExceeded, paths: lambdaPaths },
          );
        }

        if (aliasesInScope.length) {
          const sourceAlias = node.path[0];
          if (!sourceAlias || !aliasesInScope.includes(sourceAlias) || node.path.length < 2) {
            throw new LambdaQueryRejectedError(
              'Nested lambda paths inside lambda predicates must start with an in-scope lambda alias (lambda-alias-prefix-required).',
              { reason: ODataErrorCodes.LambdaAliasPrefixRequired, paths: lambdaPaths },
            );
          }
        }

        visit(node.predicate, [...aliasesInScope, node.alias], nextDepth);
        return;
      }
      case 'comparison':
        assertAliasedField(node.field, aliasesInScope, lambdaPaths);
        return;
      case 'transformcmp':
        assertAliasedField(node.field, aliasesInScope, lambdaPaths);
        return;
      case 'function':
        assertAliasedField(node.field, aliasesInScope, lambdaPaths);
        return;
      case 'fncmp':
        assertAliasedField(node.field, aliasesInScope, lambdaPaths);
        return;
      case 'stringfncmp': {
        for (const arg of node.args) {
          if (arg.kind === 'field') {
            assertAliasedField(arg.name, aliasesInScope, lambdaPaths);
          }
        }
        return;
      }
      case 'datepart':
        assertAliasedField(node.field, aliasesInScope, lambdaPaths);
        return;
      case 'indexofcmp':
        assertAliasedField(node.field, aliasesInScope, lambdaPaths);
        return;
      case 'substrcmp':
        assertAliasedField(node.field, aliasesInScope, lambdaPaths);
        return;
      case 'lengthcmp':
        assertAliasedField(node.field, aliasesInScope, lambdaPaths);
        return;
      case 'logical': {
        if (
          aliasesInScope.length &&
          node.type === 'or' &&
          node.expressions.some((child) => containsLambda(child))
        ) {
          throw new LambdaQueryRejectedError(
            'Lambda expressions combined with OR inside lambda predicates are not supported (lambda-or-unsupported).',
            { reason: ODataErrorCodes.LambdaOrUnsupported, paths: lambdaPaths },
          );
        }
        for (const child of node.expressions) {
          visit(child, aliasesInScope, depth);
        }
        return;
      }
      case 'not':
        visit(node.expr, aliasesInScope, depth);
        return;
      default:
        return;
    }
  };

  visit(expr, [], 0);
}

function rewriteNegatedLambdas(expr: ParsedExpression): ParsedExpression {
  if (expr.operator === 'lambda') return expr;

  if (expr.operator === 'logical') {
    return {
      ...expr,
      expressions: expr.expressions.map((child) => rewriteNegatedLambdas(child)),
    };
  }

  if (expr.operator === 'not') {
    const inner = rewriteNegatedLambdas(expr.expr);
    if (inner.operator === 'not') {
      return rewriteNegatedLambdas(inner.expr);
    }
    if (inner.operator === 'lambda') {
      const lambdaType = inner.lambdaType === 'any' ? 'all' : 'any';
      return {
        ...inner,
        lambdaType,
        predicate: { operator: 'not', expr: inner.predicate },
      };
    }
    return { operator: 'not', expr: inner };
  }

  return expr;
}

function collectAndTerms(expr: ParsedExpression, output: ParsedExpression[]): void {
  if (expr.operator === 'logical' && expr.type === 'and') {
    for (const child of expr.expressions) {
      collectAndTerms(child, output);
    }
    return;
  }
  output.push(expr);
}

function splitLambdaExpressions(expr: ParsedExpression): {
  lambdas?: LambdaExpressionNode[];
  predicate?: ParsedExpression;
  lambdaExpression?: ParsedExpression;
} {
  if (expr.operator === 'lambda') {
    return { lambdas: [expr] };
  }

  if (expr.operator === 'logical' && expr.type === 'or') {
    if (containsLambda(expr)) {
      return { lambdaExpression: expr };
    }
    return { predicate: expr };
  }

  if (expr.operator === 'logical' && expr.type === 'and') {
    const terms: ParsedExpression[] = [];
    collectAndTerms(expr, terms);

    const lambdas: LambdaExpressionNode[] = [];
    const others: ParsedExpression[] = [];

    for (const term of terms) {
      if (term.operator === 'lambda') {
        lambdas.push(term);
        continue;
      }

      if (term.operator === 'logical' && term.type === 'or' && containsLambda(term)) {
        return { lambdaExpression: expr };
      }

      if (term.operator === 'not' && containsLambda(term)) {
        throw new Error(
          'Negated lambda expressions are only supported as "not <collection>/any(...)" or "not <collection>/all(...)".',
        );
      }

      if (containsLambda(term)) {
        return { lambdaExpression: expr };
      }

      others.push(term);
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

    return { lambdas: lambdas.length ? lambdas : undefined, predicate };
  }

  if (expr.operator === 'not' && containsLambda(expr)) {
    throw new Error(
      'Negated lambda expressions are only supported as "not <collection>/any(...)" or "not <collection>/all(...)".',
    );
  }

  return { predicate: expr };
}

type IndexOfExpression = Extract<ParsedExpression, { operator: 'indexofcmp' }>;
type SubstringExpression = Extract<ParsedExpression, { operator: 'substrcmp' }>;
type LengthExpression = Extract<ParsedExpression, { operator: 'lengthcmp' }>;

function negateIndexOfExpression(expr: IndexOfExpression): IndexOfExpression {
  const { comparator, value } = expr;
  if (comparator === 'eq' && value === -1) {
    return { ...expr, comparator: 'gte', value: 0 };
  }
  if (comparator === 'gte' && value >= 0) {
    return { ...expr, comparator: 'eq', value: -1 };
  }
  if (comparator === 'gt' && value > -1) {
    return { ...expr, comparator: 'eq', value: -1 };
  }
  throw new Error('Unsupported negated indexof comparison.');
}

function negateSubstringExpression(expr: SubstringExpression): SubstringExpression {
  const inverted = expr.comparator === 'eq' ? 'neq' : 'eq';
  return { ...expr, comparator: inverted as SubstringExpression['comparator'] };
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
  return { ...expr, comparator };
}

function readPositiveLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function filterLimits(options?: ParseOptions) {
  return {
    maxFilterPatternLength: readPositiveLimit(
      options?.maxFilterPatternLength,
      DEFAULT_MAX_FILTER_PATTERN_LENGTH,
    ),
    maxSubstringStart: readPositiveLimit(options?.maxSubstringStart, DEFAULT_MAX_SUBSTRING_START),
    maxSubstringLength: readPositiveLimit(
      options?.maxSubstringLength,
      DEFAULT_MAX_SUBSTRING_LENGTH,
    ),
    maxFilterFieldNameLength: readPositiveLimit(
      options?.maxFilterFieldNameLength,
      DEFAULT_MAX_FILTER_FIELD_NAME_LENGTH,
    ),
    maxInListItems: readPositiveLimit(options?.maxInListItems, DEFAULT_MAX_IN_LIST_ITEMS),
  };
}

function assertSafeFilterFieldName(field: string, options?: ParseOptions): void {
  const limits = filterLimits(options);
  if (!field) {
    throw new Error('Filter field name is required.');
  }
  if (field.length > limits.maxFilterFieldNameLength) {
    throw new Error(
      `Filter field name exceeds maximum length of ${limits.maxFilterFieldNameLength}.`,
    );
  }
  if (DANGEROUS_FIELD_NAMES.has(field.toLowerCase())) {
    throw new Error('Filter field name is not allowed.');
  }
  if (!FILTER_FIELD_NAME_PATTERN.test(field)) {
    throw new Error('Filter field name contains unsupported characters.');
  }
}

function underscorePattern(length: number, options?: ParseOptions): string {
  const limits = filterLimits(options);
  if (!Number.isFinite(length) || length < 0 || !Number.isInteger(length)) {
    throw new Error('Filter pattern length must be a non-negative integer.');
  }
  if (length > limits.maxFilterPatternLength) {
    throw new Error(`Filter pattern length exceeds maximum of ${limits.maxFilterPatternLength}.`);
  }
  return '_'.repeat(length);
}

function translateLengthComparison(
  expr: LengthExpression,
  options?: ParseOptions,
): Where<AnyObject> {
  const { field, comparator, value } = expr;
  assertSafeFilterFieldName(field, options);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('length comparison requires a non-negative integer value.');
  }
  if (!Number.isInteger(value)) {
    throw new Error('length comparison requires an integer literal.');
  }
  if (comparator === 'eq') {
    if (value === 0) return { [field]: '' } as Where<AnyObject>;
    return { [field]: { like: underscorePattern(value, options) } } as Where<AnyObject>;
  }
  if (comparator === 'neq') {
    if (value === 0) return { [field]: { neq: '' } } as Where<AnyObject>;
    return { [field]: { nlike: underscorePattern(value, options) } } as Where<AnyObject>;
  }
  if (comparator === 'gt') {
    if (value === 0) {
      return { [field]: { neq: '' } } as Where<AnyObject>;
    }
    return {
      [field]: { like: `${underscorePattern(value + 1, options)}%` },
    } as Where<AnyObject>;
  }
  if (comparator === 'gte') {
    if (value <= 0) {
      return { [field]: { like: '%' } } as Where<AnyObject>;
    }
    return { [field]: { like: `${underscorePattern(value, options)}%` } } as Where<AnyObject>;
  }
  if (comparator === 'lt') {
    return { [field]: { nlike: `${underscorePattern(value, options)}%` } } as Where<AnyObject>;
  }
  if (comparator === 'lte') {
    if (value === 0) return { [field]: '' } as Where<AnyObject>;
    return {
      [field]: { nlike: `${underscorePattern(value + 1, options)}%` },
    } as Where<AnyObject>;
  }
  throw new Error('Unsupported length comparison.');
}

export function buildWhereFromParsedExpression(
  expr: ParsedExpression,
  options: ParseOptions = {},
): Where<AnyObject> {
  return buildWhere(expr, options);
}

function buildWhere(expr: ParsedExpression, options?: ParseOptions): Where<AnyObject> {
  if (expr.operator === 'stringfncmp') {
    throw new UnsupportedFilterError([expr.name]);
  }

  if (expr.operator === 'datepart') {
    throw new UnsupportedFilterError([expr.part]);
  }

  if (expr.operator === 'transformcmp') {
    throw new UnsupportedFilterError([expr.transform]);
  }

  if (expr.operator === 'not') {
    const inner = expr.expr;
    if (inner.operator === 'comparison') {
      const inverse: Record<string, string> = {
        eq: 'neq',
        neq: 'eq',
        gt: 'lte',
        gte: 'lt',
        lt: 'gte',
        lte: 'gt',
        inq: 'nin',
        nin: 'inq',
      } as any;
      const comparator = inverse[inner.comparator] ?? 'neq';
      if (comparator === 'eq') {
        assertSafeFilterFieldName(inner.field, options);
        return { [inner.field]: inner.value as any };
      }
      assertSafeFilterFieldName(inner.field, options);
      if (comparator === 'inq' || comparator === 'nin') {
        return buildWhere(
          { operator: 'comparison', field: inner.field, comparator, value: inner.value },
          options,
        );
      }
      return { [inner.field]: { [comparator]: inner.value } as AnyObject } as Where<AnyObject>;
    }
    if (inner.operator === 'function') {
      const clone: FunctionExpression = { ...inner, negated: !inner.negated };
      return buildWhere(clone, options);
    }
    if (inner.operator === 'logical') {
      const inverted = inner.expressions.map((e) =>
        buildWhere({ operator: 'not', expr: e }, options),
      );
      const type = inner.type === 'and' ? 'or' : 'and';
      return { [type]: inverted } as Where<AnyObject>;
    }
    if (inner.operator === 'fncmp') {
      return { not: buildWhere(inner, options) } as any;
    }
    if (inner.operator === 'indexofcmp') {
      return buildWhere(negateIndexOfExpression(inner), options);
    }
    if (inner.operator === 'substrcmp') {
      return buildWhere(negateSubstringExpression(inner), options);
    }
    if (inner.operator === 'lengthcmp') {
      return buildWhere(negateLengthExpression(inner), options);
    }
    if (inner.operator === 'stringfncmp') {
      throw new UnsupportedFilterError([inner.name]);
    }
    if (inner.operator === 'datepart') {
      throw new UnsupportedFilterError([inner.part]);
    }
    if (inner.operator === 'transformcmp') {
      throw new UnsupportedFilterError([inner.transform]);
    }
  }
  if (expr.operator === 'comparison') {
    const { field, comparator, value } = expr;
    assertSafeFilterFieldName(field, options);
    if (comparator === 'eq') {
      return { [field]: value };
    }
    if (comparator === 'inq' || comparator === 'nin') {
      if (!Array.isArray(value)) {
        throw badRequestWithCode(
          'in operator requires a list.',
          ODataErrorCodes.InOperatorRequiresList,
        );
      }
      const limits = filterLimits(options);
      if (value.length > limits.maxInListItems) {
        const err = new HttpErrors.BadRequest(
          `in list exceeds maximum of ${limits.maxInListItems} items.`,
        );
        (err as AnyObject).code = ODataErrorCodes.InListTooLarge;
        throw err;
      }

      const hasNull = value.some((entry) => entry === null);
      const nonNull = value.filter((entry) => entry !== null);

      if (comparator === 'inq') {
        if (hasNull && nonNull.length) {
          return { or: [{ [field]: null }, { [field]: { inq: nonNull } }] } as Where<AnyObject>;
        }
        if (hasNull) return { [field]: null } as Where<AnyObject>;
        return { [field]: { inq: nonNull } } as Where<AnyObject>;
      }

      // nin: logical negation of the inq semantics above
      if (hasNull && nonNull.length) {
        return {
          and: [{ [field]: { neq: null } }, { [field]: { nin: nonNull } }],
        } as Where<AnyObject>;
      }
      if (hasNull) return { [field]: { neq: null } } as Where<AnyObject>;
      return { [field]: { nin: nonNull } } as Where<AnyObject>;
    }
    return { [field]: { [comparator]: value } };
  }

  if (expr.operator === 'function') {
    assertSafeFilterFieldName(expr.field, options);
    const value = expr.args[0];
    if (typeof value !== 'string') {
      throw new Error(`${expr.name} requires a string literal argument.`);
    }
    const escaped = escapeLikeLiteral(value);
    const pattern =
      expr.name === 'contains'
        ? `%${escaped}%`
        : expr.name === 'startswith'
          ? `${escaped}%`
          : `%${escaped}`;
    const clause: AnyObject = expr.negated ? { nlike: pattern } : { like: pattern };
    if (expr.caseInsensitive) clause.options = 'i';
    return {
      [expr.field]: clause,
    };
  }

  if (expr.operator === 'indexofcmp') {
    const { field, comparator, value, needle } = expr;
    assertSafeFilterFieldName(field, options);
    if ((comparator === 'gte' && value >= 0) || (comparator === 'gt' && value >= -1)) {
      const lit = escapeLikeLiteral(needle);
      return { [field]: { like: `%${lit}%`, options: 'i' } } as Where<AnyObject>;
    }
    if (comparator === 'eq' && value === -1) {
      const lit = escapeLikeLiteral(needle);
      return { [field]: { nlike: `%${lit}%`, options: 'i' } } as Where<AnyObject>;
    }
    throw new Error('Unsupported indexof comparison. Supported: ge 0, gt -1, eq -1.');
  }

  if (expr.operator === 'substrcmp') {
    const { field, start, length, comparator, literal } = expr;
    assertSafeFilterFieldName(field, options);
    const limits = filterLimits(options);
    if (!Number.isFinite(start) || start < 0 || !Number.isInteger(start)) {
      throw new Error('substring start must be a non-negative integer literal.');
    }
    if (start > limits.maxSubstringStart) {
      throw new Error(`substring start exceeds maximum of ${limits.maxSubstringStart}.`);
    }
    if (length !== undefined) {
      if (!Number.isFinite(length) || length < 0 || !Number.isInteger(length)) {
        throw new Error('substring length must be a non-negative integer literal.');
      }
      if (length > limits.maxSubstringLength) {
        throw new Error(`substring length exceeds maximum of ${limits.maxSubstringLength}.`);
      }
    }
    const lit = escapeLikeLiteral(literal);
    const underscores = '_'.repeat(start);
    const pattern = length !== undefined ? `${underscores}${lit}%` : `${underscores}${lit}`;
    const clause: AnyObject = comparator === 'eq' ? { like: pattern } : { nlike: pattern };
    return { [field]: clause } as Where<AnyObject>;
  }

  if (expr.operator === 'lengthcmp') {
    return translateLengthComparison(expr, options);
  }

  if (expr.operator === 'fncmp') {
    const { name, field, comparator, value } = expr;
    assertSafeFilterFieldName(field, options);
    if (name === 'year') {
      const start = new Date(Date.UTC(value, 0, 1, 0, 0, 0, 0));
      const end = new Date(Date.UTC(value + 1, 0, 1, 0, 0, 0, 0));
      if (comparator === 'eq') {
        return {
          and: [{ [field]: { gte: start } }, { [field]: { lt: end } }],
        } as Where<AnyObject>;
      } else if (comparator === 'gte') {
        return { [field]: { gte: start } } as Where<AnyObject>;
      } else if (comparator === 'gt') {
        return { [field]: { gte: end } } as Where<AnyObject>;
      } else if (comparator === 'lte') {
        return { [field]: { lt: end } } as Where<AnyObject>;
      } else if (comparator === 'lt') {
        return { [field]: { lt: start } } as Where<AnyObject>;
      } else {
        throw new Error(`year() does not support comparator: ${comparator}`);
      }
    }
    if (name === 'floor') {
      if (comparator === 'eq') {
        return {
          and: [{ [field]: { gte: value } }, { [field]: { lt: value + 1 } }],
        } as Where<AnyObject>;
      } else if (comparator === 'gte') {
        return { [field]: { gte: value } } as Where<AnyObject>;
      } else if (comparator === 'gt') {
        return { [field]: { gte: value + 1 } } as Where<AnyObject>;
      } else if (comparator === 'lte') {
        return { [field]: { lt: value + 1 } } as Where<AnyObject>;
      } else if (comparator === 'lt') {
        return { [field]: { lt: value } } as Where<AnyObject>;
      } else {
        throw new Error(`floor() does not support comparator: ${comparator}`);
      }
    }
    if (name === 'ceiling') {
      if (comparator === 'eq') {
        return {
          and: [{ [field]: { gt: value - 1 } }, { [field]: { le: value } }],
        } as Where<AnyObject>;
      } else if (comparator === 'gte') {
        return { [field]: { gt: value - 1 } } as Where<AnyObject>;
      } else if (comparator === 'gt') {
        return { [field]: { gte: value } } as Where<AnyObject>;
      } else if (comparator === 'lte') {
        return { [field]: { lt: value + 1 } } as Where<AnyObject>;
      } else if (comparator === 'lt') {
        return { [field]: { lt: value } } as Where<AnyObject>;
      } else {
        throw new Error(`ceiling() does not support comparator: ${comparator}`);
      }
    }
    if (name === 'round') {
      const lower = value - 0.5;
      const upper = value + 0.5;
      if (comparator === 'eq') {
        return {
          and: [{ [field]: { gte: lower } }, { [field]: { lt: upper } }],
        } as Where<AnyObject>;
      } else if (comparator === 'gte') {
        return { [field]: { gte: lower } } as Where<AnyObject>;
      } else if (comparator === 'gt') {
        return { [field]: { gte: upper } } as Where<AnyObject>;
      } else if (comparator === 'lte') {
        return { [field]: { lt: upper } } as Where<AnyObject>;
      } else if (comparator === 'lt') {
        return { [field]: { lt: lower } } as Where<AnyObject>;
      } else {
        throw new Error(`round() does not support comparator: ${comparator}`);
      }
    }
  }

  if (expr.operator === 'logical') {
    const clauses: Where<AnyObject>[] = [];
    const unsupported: string[] = [];
    for (const child of expr.expressions) {
      try {
        clauses.push(buildWhere(child, options));
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
    return { [expr.type]: clauses } as Where<AnyObject>;
  }
  throw new Error('Unsupported filter expression');
}

function parseOrder(order?: string): string[] | undefined {
  if (!order) return undefined;
  const parsed = order.split(',').map((part) => {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error('Invalid $orderby expression: empty property.');
    }
    const tokens = trimmed.split(/\s+/);
    if (tokens.length > 2) {
      throw new Error(`Invalid $orderby expression: ${trimmed}`);
    }
    const [field, direction] = tokens;
    const normalizedDirection = direction?.toLowerCase();
    if (
      normalizedDirection !== undefined &&
      normalizedDirection !== 'asc' &&
      normalizedDirection !== 'desc'
    ) {
      throw new Error(`Invalid $orderby direction: ${direction}`);
    }
    const dir = normalizedDirection === 'desc' ? 'DESC' : 'ASC';
    return `${field} ${dir}`;
  });
  return parsed.length ? parsed : undefined;
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
    const { expressionTokens, alias } = extractComputeAlias(tokens);
    if (!alias) {
      throw new Error('Invalid $compute expression: missing alias.');
    }
    const node = parseComputeExpressionTokens(expressionTokens);
    results.push({ alias, expression: node });
  }
  if (!results.length) {
    throw new Error('Invalid $compute expression.');
  }
  return results;
}

function extractComputeAlias(tokens: string[]): {
  expressionTokens: string[];
  alias: string | undefined;
} {
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
      return { expressionTokens, alias };
    }
  }
  return { expressionTokens: tokens, alias: undefined };
}

function parseComputeExpressionTokens(tokens: string[]): ComputeNode {
  const { node, index } = parseComputeAddSub(tokens, 0);
  if (index !== tokens.length) {
    throw new Error(`Invalid $compute expression: unexpected token "${tokens[index]}"`);
  }
  return node;
}

function parseComputeAddSub(tokens: string[], index: number): { node: ComputeNode; index: number } {
  let { node, index: current } = parseComputeMulDiv(tokens, index);
  while (current < tokens.length) {
    const token = tokens[current].toLowerCase();
    if (token !== 'add' && token !== 'sub') break;
    const operator = token === 'add' ? 'add' : 'sub';
    const rhs = parseComputeMulDiv(tokens, current + 1);
    node = { type: 'binary', operator, left: node, right: rhs.node };
    current = rhs.index;
  }
  return { node, index: current };
}

function parseComputeMulDiv(tokens: string[], index: number): { node: ComputeNode; index: number } {
  let { node, index: current } = parseComputePrimary(tokens, index);
  while (current < tokens.length) {
    const token = tokens[current].toLowerCase();
    if (token !== 'mul' && token !== 'div' && token !== 'mod') break;
    const operator = token as 'mul' | 'div' | 'mod';
    const rhs = parseComputePrimary(tokens, current + 1);
    node = { type: 'binary', operator, left: node, right: rhs.node };
    current = rhs.index;
  }
  return { node, index: current };
}

function parseComputePrimary(
  tokens: string[],
  index: number,
): { node: ComputeNode; index: number } {
  if (index >= tokens.length) {
    throw new Error('Invalid $compute expression.');
  }

  const token = tokens[index];
  if (token === '(') {
    const inner = parseComputeAddSub(tokens, index + 1);
    if (inner.index >= tokens.length || tokens[inner.index] !== ')') {
      throw new Error('Invalid $compute expression: unmatched parenthesis.');
    }
    return { node: inner.node, index: inner.index + 1 };
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
      node: { type: 'function', name: lower as 'tolower' | 'toupper' | 'concat', args },
      index: cursor,
    };
  }

  if (token.startsWith("'") && token.endsWith("'")) {
    return {
      node: { type: 'literal', value: unescapeStringLiteral(token) },
      index: index + 1,
    };
  }

  if (lower === 'null') {
    return {
      node: { type: 'literal', value: null },
      index: index + 1,
    };
  }

  if (lower === 'true' || lower === 'false') {
    return {
      node: { type: 'literal', value: lower === 'true' },
      index: index + 1,
    };
  }

  if (isNumericToken(token)) {
    return {
      node: { type: 'literal', value: Number(token) },
      index: index + 1,
    };
  }

  const pathSegments = token
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!pathSegments.length) {
    throw new Error(`Invalid $compute path: ${token}`);
  }
  return {
    node: { type: 'path', path: pathSegments },
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
  const transformations = segments.map((segment) => parseApplyTransformation(segment.trim()));
  return { transformations };
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
  const [expression, next] = parseFilter(tokens, 0, { strict: false });
  if (next !== tokens.length) {
    throw new Error('Invalid filter() transformation.');
  }
  return { type: 'filter', expression };
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
    ? groupFieldsExpr
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  if (!groupFields.length) {
    throw new Error('groupby requires at least one property.');
  }
  groupFields.forEach((field) => {
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

  const aggregates: AggregationExpression[] = aggregateTokens.map((token) =>
    parseAggregateExpression(token),
  );

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
  const expressions = aggregateTokens.map((token) => parseAggregateExpression(token));
  return { type: 'aggregate', expressions };
}

function parseApplyOrderBy(body: string): ApplyOrderByTransformation {
  const orderStrings = parseOrder(body);
  if (!orderStrings?.length) {
    throw new Error('orderby() requires at least one property.');
  }
  const items = orderStrings.map((item) => {
    const [field, directionToken] = item.split(/\s+/);
    const direction = directionToken?.toLowerCase() === 'desc' ? 'desc' : 'asc';
    return { field, direction: direction as 'asc' | 'desc' };
  });
  return { type: 'orderby', items };
}

function parseApplySkip(body: string): ApplySkipTransformation {
  const count = parseNonNegativeInteger(body, 'skip');
  return { type: 'skip', count };
}

function parseApplyTop(body: string): ApplyTopTransformation {
  const count = parseNonNegativeInteger(body, 'top');
  return { type: 'top', count };
}

function parseApplyBottom(body: string): ApplyBottomTransformation {
  const count = parseNonNegativeInteger(body, 'bottom');
  return { type: 'bottom', count };
}

function parseApplyConcat(body: string): ApplyConcatTransformation {
  const segments = splitTopLevel(body, ',');
  if (segments.length < 2) {
    throw new Error('concat() requires at least two pipeline arguments.');
  }
  const pipelines = segments.map((segment) => parseApplyPipeline(segment));
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

function parseQueryNonNegativeInteger(value: string, option: '$top' | '$skip'): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${option} value: ${value}`);
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Invalid ${option} value: ${value}`);
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
  let normalized = expr.replace(/%24/gi, '$');
  // Best-effort URL decoding for encoded operands inside aggregate(), e.g. %24count
  try {
    // Replace '+' with space before decoding (common in querystrings)
    const plusFixed = normalized.replace(/\+/g, ' ');
    normalized = decodeURIComponent(plusFixed);
  } catch {
    // ignore decoding errors and continue with the best available string
  }
  if (!expr) {
    throw new Error('Empty aggregate expression.');
  }

  const countOnly = normalized.match(/^\$count\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
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

  const match = normalized.match(/^(.+)\s+with\s+([A-Za-z]+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (!match) {
    throw new Error(`Invalid aggregate expression: ${expr}`);
  }

  const rawOperand = match[1].trim();
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

  if (rawOperand === '*' && operator !== 'count') {
    throw new Error('Only count(*) is supported for the wildcard aggregator.');
  }

  let field: string | undefined;
  let expression: ComputeNode | undefined;

  if (rawOperand === '*') {
    field = undefined;
  } else if (isValidPath(rawOperand)) {
    field = rawOperand;
  } else {
    const tokens = tokenize(rawOperand);
    if (!tokens.length) {
      throw new Error(`Unsupported aggregate operand: ${rawOperand}`);
    }
    try {
      expression = parseComputeExpressionTokens(tokens);
    } catch (err) {
      throw new Error(`Unsupported aggregate operand: ${rawOperand}`);
    }
  }

  if (!field && !expression && operator !== 'count') {
    throw new Error(`Invalid aggregate operand for ${operatorToken}.`);
  }

  return {
    field,
    expression,
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
        if (transformation.pipelines.some((branch) => pipelineHasPaging(branch))) {
          return true;
        }
        break;
      default:
        break;
    }
  }
  return false;
}

function extractPathAndOptions(segment: string): { path: string; options?: string } {
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
        return options ? { path, options } : { path };
      }
      continue;
    }
  }

  if (depth !== 0) {
    throw new Error('Malformed expand segment: unmatched parentheses.');
  }

  return { path: trimmed };
}

function getTargetRelations(definition: unknown): RelationDefinitionMap | undefined {
  const resolver = (definition as { target?: () => typeof Entity } | undefined)?.target;
  if (typeof resolver !== 'function') return undefined;
  try {
    const target = resolver();
    const modelDef = (target as typeof Entity | undefined)?.definition as
      | { relations?: RelationDefinitionMap }
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
    return { relation: include };
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

  return Array.from(map.values()).map((item) =>
    item.scope ? { relation: item.relation, scope: item.scope } : { relation: item.relation },
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
      ensureFieldsIncludeRelations(
        normalized.scope,
        normalized.scope.include as InclusionFilter[] | undefined,
      );
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
    result.fields = { ...(result.fields ?? {}), ...incoming.fields };
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

  if (incoming.include?.length) {
    const existing = result.include ?? [];
    result.include = mergeInclusionList(existing, incoming.include);
    ensureFieldsIncludeRelations(result, result.include);
  }

  return result;
}

function parseExpandOptions(
  options: string,
  relations?: RelationDefinitionMap,
  parseOptions?: ParseOptions,
): { scope?: Filter<AnyObject>; includes?: InclusionFilter[]; levels?: number } {
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
          scope = mergeScopes(scope, { fields });
        }
        break;
      }
      case '$expand': {
        const includes = parseExpand(rawValue, relations, parseOptions);
        if (includes?.length) {
          nestedIncludes = nestedIncludes ? mergeInclusionList(nestedIncludes, includes) : includes;
        }
        break;
      }
      case '$filter': {
        const parsed = parseODataQuery({ $filter: rawValue }, { ...parseOptions, relations });
        const unsupported = collectUnsupportedExpandFilterFeatures(parsed);
        if (unsupported.length) {
          throw new Error(
            `$expand $filter requires unsupported relation post-filter evaluation: ${unsupported.join(', ')}.`,
          );
        }
        if (parsed.where) {
          scope = mergeScopes(scope, { where: parsed.where });
        }
        break;
      }
      case '$orderby': {
        const order = parseOrder(rawValue);
        if (order?.length) {
          scope = mergeScopes(scope, { order });
        }
        break;
      }
      case '$top': {
        const limit = parseQueryNonNegativeInteger(rawValue, '$top');
        scope = mergeScopes(scope, { limit });
        break;
      }
      case '$skip': {
        const offset = parseQueryNonNegativeInteger(rawValue, '$skip');
        scope = mergeScopes(scope, { offset });
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

  return { scope, includes: nestedIncludes, levels };
}

function collectUnsupportedExpandFilterFeatures(parsed: ParsedODataQuery): string[] {
  const unsupported: string[] = [];

  if (parsed.postFilter) {
    unsupported.push(...(parsed.unsupportedFunctions?.length ? parsed.unsupportedFunctions : ['post-filter']));
  }
  if (parsed.lambdas?.length || parsed.lambdaExpression) {
    unsupported.push('lambda');
  }

  const visit = (expr: ParsedExpression | undefined) => {
    if (!expr) return;
    if (expr.operator === 'function' && expr.transform) {
      unsupported.push(expr.transform);
      return;
    }
    if (expr.operator === 'logical') {
      expr.expressions.forEach(visit);
      return;
    }
    if (expr.operator === 'not') {
      visit(expr.expr);
      return;
    }
    if (expr.operator === 'lambda') {
      unsupported.push('lambda');
      visit(expr.predicate);
    }
  };

  visit(parsed.whereExpression);
  return Array.from(new Set(unsupported));
}

function buildIncludeFromParts(
  parts: string[],
  options: string | undefined,
  relations?: RelationDefinitionMap,
  parseOptions?: ParseOptions,
): InclusionFilter {
  const [current, ...rest] = parts;
  if (!current) {
    throw new Error('Invalid $expand segment: missing relation name.');
  }

  const relationDef = relations?.[current];
  if (relations && !relationDef) {
    throw new Error(`Unknown expand relation: ${current}`);
  }

  const include: InclusionFilter = { relation: current };
  const nextRelations = getTargetRelations(relationDef);

  if (rest.length) {
    const child = buildIncludeFromParts(rest, options, nextRelations, parseOptions);
    include.scope = mergeScopes(include.scope, { include: [child] });
    return include;
  }

  if (options) {
    const { scope, includes, levels } = parseExpandOptions(options, nextRelations, parseOptions);
    if (scope) {
      include.scope = mergeScopes(include.scope, scope);
    }
    if (includes?.length) {
      include.scope = mergeScopes(include.scope, { include: includes });
    }
    if (levels && levels > 1) {
      expandLevels(include, current, levels, nextRelations);
    }
  }

  return include;
}

function cloneScope(scope?: Filter<AnyObject>): Filter<AnyObject> | undefined {
  if (!scope) return undefined;
  const clone: Filter<AnyObject> = { ...scope };
  if (scope.include) {
    const includes = Array.isArray(scope.include) ? scope.include : [scope.include];
    clone.include = includes.map((entry) => cloneInclusion(entry));
  }
  return clone;
}

function cloneInclusion(include: InclusionFilter | string): InclusionFilter {
  if (typeof include === 'string') {
    return { relation: include };
  }
  const cloned: InclusionFilter = { relation: include.relation };
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
    const child: InclusionFilter = childScope ? { relation, scope: childScope } : { relation };
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
  parseOptions?: ParseOptions,
): InclusionFilter[] | undefined {
  if (!expand) return undefined;

  const normalized = Array.isArray(expand) ? expand.join(',') : expand;
  const segments = splitTopLevel(normalized, ',');
  if (!segments.length) return undefined;

  const includeMap = new Map<string, NormalizedInclude>();

  for (const segment of segments) {
    const { path, options } = extractPathAndOptions(segment);
    const parts = path
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);

    if (!parts.length) {
      throw new Error('Invalid $expand segment: missing relation name.');
    }

    const include = buildIncludeFromParts(parts, options, relations, parseOptions);
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
    ? Array.from(includeMap.values()).map((item) =>
        item.scope ? { relation: item.relation, scope: item.scope } : { relation: item.relation },
      )
    : undefined;
}

export interface ParsedODataQuery extends Filter<AnyObject> {
  inlineCount?: boolean;
  search?: string;
  applyPipeline?: ApplyPipeline;
  apply?: AggregationSpec;
  lambdas?: LambdaExpression[];
  lambdaExpression?: ParsedExpression;
  postFilter?: ParsedExpression;
  whereExpression?: ParsedExpression;
  unsupportedFunctions?: string[];
  skipToken?: string;
  deltaToken?: string;
  format?: string;
  compute?: ComputeExpression[];
}

function singleQueryValue(query: QueryObject, key: string): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) {
    throw new Error(`Duplicate query option is not allowed: ${key}`);
  }
  return typeof value === 'string' ? value : undefined;
}

export function parseODataQuery(query: QueryObject, options: ParseOptions = {}): ParsedODataQuery {
  const filter: ParsedODataQuery = {};
  const { relations } = options;
  const ctx: ParseContext = { strict: Boolean(options.strict) };

  if (options.strict) {
    const allowed = new Set([
      '$filter',
      '$orderby',
      '$top',
      '$skip',
      '$skiptoken',
      '$deltatoken',
      '$select',
      '$expand',
      '$count',
      '$search',
      '$apply',
      '$format',
      '$compute',
    ]);
    for (const key of Object.keys(query ?? {})) {
      if (key.startsWith('$') && !allowed.has(key)) {
        throw new Error(`Unsupported query option: ${key}`);
      }
    }
  }

  const filterExpr = singleQueryValue(query, '$filter');
  if (filterExpr) {
    const tokens = tokenize(filterExpr);
    if (tokens.length) {
      const [expr, nextIndex] = parseFilter(tokens, 0, ctx);
      if (nextIndex !== tokens.length) {
        throw new Error(`Invalid $filter expression near "${tokens[nextIndex]}".`);
      }
      const rewritten = rewriteNegatedLambdas(expr);
      validateLambdaExpressionTree(rewritten, options);
      const { lambdas, predicate, lambdaExpression } = splitLambdaExpressions(rewritten);
      if (lambdas?.length) {
        filter.lambdas = lambdas.map((lambda) => ({
          type: lambda.lambdaType,
          path: lambda.path,
          alias: lambda.alias,
          predicate: lambda.predicate,
        }));
      }
      if (lambdaExpression) {
        filter.lambdaExpression = lambdaExpression;
      }
      if (predicate) {
        filter.whereExpression = predicate;
        try {
          filter.where = buildWhere(predicate, options);
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

  const orderby = singleQueryValue(query, '$orderby');
  if (orderby) {
    filter.order = parseOrder(orderby);
  }

  const top = singleQueryValue(query, '$top');
  if (top !== undefined) {
    filter.limit = parseQueryNonNegativeInteger(top, '$top');
  }

  const skip = singleQueryValue(query, '$skip');
  if (skip !== undefined) {
    filter.offset = parseQueryNonNegativeInteger(skip, '$skip');
  }

  const skiptoken = singleQueryValue(query, '$skiptoken');
  if (skiptoken) {
    filter.skipToken = skiptoken;
  }

  const delta = singleQueryValue(query, '$deltatoken');
  if (delta) {
    filter.deltaToken = delta;
  }

  const select = singleQueryValue(query, '$select');
  if (select) {
    filter.fields = parseSelect(select);
  }

  const expand = query['$expand'];
  const include = parseExpand(expand, relations, options);
  if (include) {
    filter.include = include;
    ensureFieldsIncludeRelations(filter, include);
  }

  const count = singleQueryValue(query, '$count');
  if (count !== undefined) {
    const normalized = count.trim().toLowerCase();
    if (normalized === 'true') {
      filter.inlineCount = true;
    } else if (normalized !== 'false') {
      throw new Error(`Invalid $count value: ${count}`);
    }
  }

  const search = singleQueryValue(query, '$search');
  if (search) {
    filter.search = search;
  }

  const apply = singleQueryValue(query, '$apply');
  if (apply) {
    const pipeline = parseApplyPipeline(apply);
    filter.applyPipeline = pipeline;
    filter.apply = deriveAggregationSpecFromPipeline(pipeline);
  }

  const format = singleQueryValue(query, '$format');
  if (format) {
    filter.format = format;
  }

  const computeRaw = singleQueryValue(query, '$compute');
  if (computeRaw) {
    filter.compute = parseCompute(computeRaw);
  }

  return filter;
}

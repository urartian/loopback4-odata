import {AnyObject, Where} from '@loopback/repository';
import {
  ApplyPipeline,
  ApplyTransformation,
  ApplyFilterTransformation,
  ApplyGroupByTransformation,
  ApplyOrderByTransformation,
  ApplySkipTransformation,
  ApplyTopTransformation,
  AggregationExpression,
  ParsedExpression,
  UnsupportedFilterError,
  buildWhereFromParsedExpression,
} from './odata-query-parser.service';

export interface ApplyExecutionPlan {
  readonly pushdownWhere?: Where<AnyObject>;
  readonly postFilters: ParsedExpression[];
  readonly groupBy?: {
    keys: string[];
    aggregates: AggregationExpression[];
  };
  readonly orderBy?: Array<{field: string; direction: 'asc' | 'desc'}>;
  readonly top?: number;
  readonly skip?: number;
}

export interface ApplyPlannerOptions {
  strict?: boolean;
}

export function buildApplyExecutionPlan(
  pipeline: ApplyPipeline,
  options: ApplyPlannerOptions = {},
): ApplyExecutionPlan {
  if (!pipeline.transformations.length) {
    throw new Error('Empty $apply pipeline.');
  }

  let pushdownWhere: Where<AnyObject> | undefined;
  const postFilters: ParsedExpression[] = [];
  let orderBy: ApplyExecutionPlan['orderBy'];
  let top: number | undefined;
  let skip: number | undefined;
  let encounteredAggregationStage = false;
  let groupKeys: string[] | undefined;
  const aggregateExpressions: AggregationExpression[] = [];

  pipeline.transformations.forEach((transformation, index) => {
    switch (transformation.type) {
      case 'filter': {
        if (encounteredAggregationStage) {
          throw new Error('filter() after groupby()/aggregate() is not supported yet.');
        }
        const whereCandidate = buildWhereCandidate(transformation.expression, options);
        if (whereCandidate) {
          pushdownWhere = mergeWhereClauses(pushdownWhere, whereCandidate);
        } else {
          postFilters.push(transformation.expression);
        }
        break;
      }
      case 'groupby': {
        if (groupKeys !== undefined) {
          throw new Error('Multiple groupby() transformations are not supported.');
        }
        encounteredAggregationStage = true;
        groupKeys = [...transformation.keys];
        aggregateExpressions.push(...transformation.aggregates);
        break;
      }
      case 'aggregate': {
        encounteredAggregationStage = true;
        aggregateExpressions.push(...transformation.expressions);
        break;
      }
      case 'orderby': {
        ensureAggregationSeen(encounteredAggregationStage, transformation, index);
        if (orderBy && orderBy.length) {
          throw new Error('Multiple orderby() transformations are not supported.');
        }
        orderBy = transformation.items.map(item => ({
          field: item.field,
          direction: item.direction,
        }));
        break;
      }
      case 'skip': {
        ensureAggregationSeen(encounteredAggregationStage, transformation, index);
        if (skip !== undefined) {
          throw new Error('Only one skip() transformation is supported.');
        }
        skip = transformation.count;
        break;
      }
      case 'top': {
        ensureAggregationSeen(encounteredAggregationStage, transformation, index);
        if (top !== undefined) {
          throw new Error('Only one top() transformation is supported.');
        }
        top = transformation.count;
        break;
      }
      case 'bottom': {
        throw new Error('bottom() transformation is not supported yet.');
      }
      default:
        throw new Error(`Unsupported $apply transformation: ${(transformation as ApplyTransformation).type}`);
    }
  });

  if (!encounteredAggregationStage || !aggregateExpressions.length) {
    throw new Error('groupby() or aggregate() transformation is required in the $apply pipeline.');
  }

  return {
    pushdownWhere,
    postFilters,
    groupBy: {
      keys: groupKeys ?? [],
      aggregates: aggregateExpressions,
    },
    orderBy,
    top,
    skip,
  };
}

function buildWhereCandidate(
  expression: ParsedExpression,
  options: ApplyPlannerOptions,
): Where<AnyObject> | undefined {
  try {
    return buildWhereFromParsedExpression(expression);
  } catch (err) {
    if (err instanceof UnsupportedFilterError) {
      if (options.strict) {
        throw new Error(`Unsupported filter() transformation in strict mode: ${err.message}`);
      }
      return undefined;
    }
    throw err;
  }
}

function mergeWhereClauses(
  target: Where<AnyObject> | undefined,
  candidate: Where<AnyObject>,
): Where<AnyObject> {
  if (!target) return candidate;
  return {and: [target, candidate]};
}

function ensureAggregationSeen(
  seen: boolean,
  transformation: ApplyTransformation,
  index: number,
): void {
  if (!seen) {
    throw new Error(
      `${transformation.type}() transformation at position ${index + 1} requires a preceding groupby().`,
    );
  }
}

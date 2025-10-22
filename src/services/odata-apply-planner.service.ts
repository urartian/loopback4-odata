import {AnyObject, Where, Entity} from '@loopback/repository';
import {
  ApplyPipeline,
  ApplyTransformation,
  ApplyFilterTransformation,
  ApplyGroupByTransformation,
  ApplyOrderByTransformation,
  ApplySkipTransformation,
  ApplyTopTransformation,
  AggregationExpression,
  AggregationSpec,
  ParsedExpression,
  UnsupportedFilterError,
  buildWhereFromParsedExpression,
} from './odata-query-parser.service';
import {ResolvedNavigationPath, resolveNavigationPath, NavigationPathError} from '../util/navigation-path';

export interface ApplyAggregationStage {
  spec: AggregationSpec;
  postAggregationFilters: ParsedExpression[];
  orderBy?: Array<{field: string; direction: 'asc' | 'desc'}>;
  top?: number;
  skip?: number;
  navigationPaths: ResolvedNavigationPath[];
}

export interface ApplyExecutionPlan {
  readonly pushdownWhere?: Where<AnyObject>;
  readonly preAggregationFilters: ParsedExpression[];
  readonly stages: ApplyAggregationStage[];
  readonly concat?: ApplyExecutionPlan[];
  readonly postOrderBy?: Array<{field: string; direction: 'asc' | 'desc'}>;
  readonly postTop?: number;
  readonly postSkip?: number;
}

export interface ApplyPlannerOptions {
  strict?: boolean;
  modelCtor?: typeof Entity;
  maxNavigationDepth?: number;
}

const DEFAULT_MAX_NAVIGATION_DEPTH = 5;

export function buildApplyExecutionPlan(
  pipeline: ApplyPipeline,
  options: ApplyPlannerOptions = {},
  allowNonAggregate = false,
): ApplyExecutionPlan {
  if (!pipeline.transformations.length) {
    throw new Error('Empty $apply pipeline.');
  }

  let pushdownWhere: Where<AnyObject> | undefined;
  const preAggregationFilters: ParsedExpression[] = [];
  const stages: ApplyAggregationStage[] = [];
  const concatBranches: ApplyExecutionPlan[] = [];
  let planOrderBy: Array<{field: string; direction: 'asc' | 'desc'}> | undefined;
  let planTop: number | undefined;
  let planSkip: number | undefined;
  let currentStage: ApplyAggregationStage | undefined;

  const startStage = (spec: AggregationSpec) => {
    const stage: ApplyAggregationStage = {
      spec: {
        groupBy: [...spec.groupBy],
        aggregates: spec.aggregates.map(expr => ({...expr})),
      },
      postAggregationFilters: [],
      navigationPaths: [],
    };
    stages.push(stage);
    currentStage = stage;
  };

  pipeline.transformations.forEach((transformation, index) => {
    switch (transformation.type) {
      case 'filter': {
        if (currentStage) {
          currentStage.postAggregationFilters.push(transformation.expression);
        } else {
          const whereCandidate = buildWhereCandidate(transformation.expression, options);
          if (whereCandidate) {
            pushdownWhere = mergeWhereClauses(pushdownWhere, whereCandidate);
          } else {
            preAggregationFilters.push(transformation.expression);
          }
        }
        break;
      }
      case 'groupby': {
        startStage({
          groupBy: transformation.keys,
          aggregates: transformation.aggregates,
        });
        break;
      }
      case 'aggregate': {
        startStage({
          groupBy: [],
          aggregates: transformation.expressions,
        });
        break;
      }
      case 'orderby': {
        if (currentStage) {
          if (currentStage.orderBy && currentStage.orderBy.length) {
            throw new Error('Multiple orderby() transformations are not supported within the same stage.');
          }
          currentStage.orderBy = transformation.items.map(item => ({
            field: item.field,
            direction: item.direction,
          }));
        } else {
          if (!allowNonAggregate) {
            throw new Error('orderby() transformation requires a preceding groupby() or aggregate().');
          }
          if (planOrderBy && planOrderBy.length) {
            throw new Error('Multiple orderby() transformations are not supported for the same pipeline.');
          }
          planOrderBy = transformation.items.map(item => ({
            field: item.field,
            direction: item.direction,
          }));
        }
        break;
      }
      case 'skip': {
        if (currentStage) {
          if (currentStage.skip !== undefined) {
            throw new Error('Only one skip() transformation is supported per stage.');
          }
          currentStage.skip = transformation.count;
        } else {
          if (!allowNonAggregate) {
            throw new Error('skip() transformation requires a preceding groupby() or aggregate().');
          }
          if (planSkip !== undefined) {
            throw new Error('Only one skip() transformation is supported per pipeline.');
          }
          planSkip = transformation.count;
        }
        break;
      }
      case 'top': {
        if (currentStage) {
          if (currentStage.top !== undefined) {
            throw new Error('Only one top() transformation is supported per stage.');
          }
          currentStage.top = transformation.count;
        } else {
          if (!allowNonAggregate) {
            throw new Error('top() transformation requires a preceding groupby() or aggregate().');
          }
          if (planTop !== undefined) {
            throw new Error('Only one top() transformation is supported per pipeline.');
          }
          planTop = transformation.count;
        }
        break;
      }
      case 'bottom': {
        throw new Error('bottom() transformation is not supported yet.');
      }
      case 'concat': {
        if (index !== pipeline.transformations.length - 1) {
          throw new Error('concat() must be the final transformation in the $apply pipeline.');
        }
        const branches = transformation.pipelines.map(branch => buildApplyExecutionPlan(branch, options, true));
        concatBranches.push(...branches);
        currentStage = undefined;
        break;
      }
      default:
        throw new Error(`Unsupported $apply transformation: ${(transformation as ApplyTransformation).type}`);
    }
  });

  const hasAggregation = stages.length > 0 || concatBranches.some(planHasAggregation);
  if (!hasAggregation && !allowNonAggregate) {
    throw new Error('groupby() or aggregate() transformation is required in the $apply pipeline.');
  }

  const plan: ApplyExecutionPlan = {
    pushdownWhere,
    preAggregationFilters,
    stages,
    ...(concatBranches.length ? {concat: concatBranches} : {}),
    ...(planOrderBy && planOrderBy.length ? {postOrderBy: planOrderBy} : {}),
    ...(planTop !== undefined ? {postTop: planTop} : {}),
    ...(planSkip !== undefined ? {postSkip: planSkip} : {}),
  };

  if (options.modelCtor) {
    const maxDepth = options.maxNavigationDepth ?? DEFAULT_MAX_NAVIGATION_DEPTH;
    populatePlanNavigationPaths(plan, options.modelCtor, maxDepth);
  }

  return plan;
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

function planHasAggregation(plan: ApplyExecutionPlan): boolean {
  if (plan.stages.length > 0) return true;
  if (!plan.concat || !plan.concat.length) return false;
  return plan.concat.some(child => planHasAggregation(child));
}

function populatePlanNavigationPaths(
  plan: ApplyExecutionPlan,
  modelCtor: typeof Entity,
  maxDepth: number,
) {
  for (const stage of plan.stages) {
    stage.navigationPaths = collectNavigationPaths(modelCtor, stage.spec, maxDepth);
  }
  if (plan.concat) {
    for (const branch of plan.concat) {
      populatePlanNavigationPaths(branch, modelCtor, maxDepth);
    }
  }
}

function ensureStageExists(
  stage: ApplyAggregationStage | undefined,
  transformation: ApplyTransformation,
  index: number,
): asserts stage is ApplyAggregationStage {
  if (!stage) {
    throw new Error(
      `${transformation.type}() transformation at position ${index + 1} requires a preceding groupby() or aggregate().`,
    );
  }
}

function collectNavigationPaths(
  modelCtor: typeof Entity,
  spec: AggregationSpec,
  maxDepth: number,
): ResolvedNavigationPath[] {
  const seen = new Map<string, ResolvedNavigationPath>();
  const collect = (raw?: string) => {
    if (!raw || !raw.includes('/')) return;
    if (seen.has(raw)) return;
    try {
      const resolved = resolveNavigationPath(modelCtor, raw, {maxDepth});
      seen.set(raw, resolved);
    } catch (err) {
      if (err instanceof NavigationPathError) {
        throw new Error(`Unsupported navigation path "${raw}": ${err.message}`);
      }
      throw err;
    }
  };

  spec.groupBy.forEach(collect);
  for (const aggregate of spec.aggregates) {
    collect(aggregate.field);
  }

  return Array.from(seen.values());
}

export function collectNavigationPathsForStage(
  modelCtor: typeof Entity,
  spec: AggregationSpec,
  maxDepth: number = DEFAULT_MAX_NAVIGATION_DEPTH,
): ResolvedNavigationPath[] {
  return collectNavigationPaths(modelCtor, spec, maxDepth);
}

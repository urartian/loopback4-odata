import { BindingScope, injectable } from '@loopback/core';
import { AnyObject, DefaultCrudRepository, Filter, Options, juggler } from '@loopback/repository';
import { EntitySetDef } from '../registry/entityset-registry';
import { ApplyExecutionPlan } from './odata-apply-planner.service';
import { AggregationSpec, ApplyPipeline } from './odata-query-parser.service';

/** Telemetry payload emitted by datastore-backed `$apply` executors. */
export interface ApplyExecutorTelemetryPayload {
  durationMs?: number;
  rows?: number;
  joinCount?: number;
  executorId?: string;
  reason?: string;
}

/** Sort descriptor used when executors need to preserve pipeline ordering. */
export interface ApplyOrderDescriptor {
  field: string;
  direction: 'ASC' | 'DESC';
}

/** Paging information supplied to executors for stage and external pagination. */
export interface ApplyPagingOptions {
  order: ApplyOrderDescriptor[];
  skipTokenValues?: string[];
  pageSize?: number;
  stageTop?: number;
  stageSkip?: number;
}

/** Full execution context passed to a registered `$apply` pushdown executor. */
export interface ODataApplyExecutorContext {
  /** @internal Internal resolved entity-set definition for the current request. */
  entitySet: EntitySetDef;
  repository: DefaultCrudRepository<any, unknown>;
  /** @internal Internal planner output describing the current `$apply` stage. */
  plan: ApplyExecutionPlan;
  /** @internal Parsed `$apply` pipeline syntax tree. */
  pipeline: ApplyPipeline;
  /** @internal Aggregation metadata derived from the parsed pipeline. */
  aggregation: AggregationSpec;
  baseFilter: Filter<AnyObject>;
  fetchFilter: Filter<AnyObject>;
  options?: Options;
  requestedLimit?: number;
  requestedOffset?: number;
  stageIndex: number;
  stageCount: number;
  telemetry?: (payload: ApplyExecutorTelemetryPayload) => void;
  paging?: ApplyPagingOptions;
}

/** Result returned by an executor after pushdown succeeds. */
export interface ODataApplyExecutorResult {
  rows: AnyObject[];
  appliedOrder?: boolean;
  appliedPipelinePagination?: boolean;
  appliedExternalPagination?: boolean;
  appliedStageFilters?: boolean;
  nextSkipTokenValues?: string[];
}

/** Indicates the executor declined pushdown with a recorded reason. */
export interface ODataApplyExecutorDecline {
  declineReason: string;
}

/**
 * Advanced extension point for datastore-backed `$apply` execution.
 *
 * Implement this interface when a datasource can translate OData aggregation
 * pipelines into native query operations more efficiently than in-memory fallback.
 */
export interface ODataApplyExecutor {
  readonly id: string;
  readonly capabilities?: {
    navigation?: boolean;
    concat?: boolean;
  };
  /**
   * Quick guard invoked during boot to determine whether the executor can handle
   * the given datasource (for example, a PostgreSQL connector). Return `true`
   * to associate the executor with the datasource, otherwise `false`.
   */
  supports?(datasource: juggler.DataSource): boolean | Promise<boolean>;
  /**
   * Execute the $apply pipeline using pushdown semantics. Return `undefined`
   * to signal the caller to fall back to the in-memory implementation.
   */
  execute(
    ctx: ODataApplyExecutorContext,
  ): Promise<ODataApplyExecutorResult | ODataApplyExecutorDecline | undefined>;
}

/** Registry of available `$apply` executors keyed by executor id. */
@injectable({ scope: BindingScope.SINGLETON })
export class ODataApplyExecutorRegistry {
  private readonly executors: Map<string, ODataApplyExecutor> = new Map();
  private readonly ordered: ODataApplyExecutor[] = [];

  register(executor: ODataApplyExecutor): void {
    if (!executor?.id) {
      throw new Error('Invalid ODataApplyExecutor: missing identifier.');
    }
    if (this.executors.has(executor.id)) {
      throw new Error(`ODataApplyExecutor with id ${executor.id} is already registered.`);
    }
    this.executors.set(executor.id, executor);
    this.ordered.push(executor);
  }

  get(id: string): ODataApplyExecutor | undefined {
    return this.executors.get(id);
  }

  /**
   * Attempts to match a datasource to the first registered executor that claims support.
   */
  async findForDataSource(datasource: juggler.DataSource): Promise<ODataApplyExecutor | undefined> {
    for (const executor of this.ordered) {
      if (typeof executor.supports !== 'function') continue;
      try {
        const supported = await executor.supports(datasource);
        if (supported) {
          return executor;
        }
      } catch {
        // ignore and keep scanning
      }
    }
    return undefined;
  }
}

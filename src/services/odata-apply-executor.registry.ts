import { BindingScope, injectable } from '@loopback/core';
import { AnyObject, DefaultCrudRepository, Filter, Options, juggler } from '@loopback/repository';
import { EntitySetDef } from '../registry/entityset-registry';
import { ApplyExecutionPlan } from './odata-apply-planner.service';
import { AggregationSpec, ApplyPipeline } from './odata-query-parser.service';

export interface ApplyExecutorTelemetryPayload {
  durationMs?: number;
  rows?: number;
  joinCount?: number;
  executorId?: string;
}

export interface ApplyOrderDescriptor {
  field: string;
  direction: 'ASC' | 'DESC';
}

export interface ApplyPagingOptions {
  order: ApplyOrderDescriptor[];
  skipTokenValues?: string[];
  pageSize?: number;
  stageTop?: number;
  stageSkip?: number;
}

export interface ODataApplyExecutorContext {
  entitySet: EntitySetDef;
  repository: DefaultCrudRepository<any, unknown>;
  plan: ApplyExecutionPlan;
  pipeline: ApplyPipeline;
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

export interface ODataApplyExecutorResult {
  rows: AnyObject[];
  appliedOrder?: boolean;
  appliedPipelinePagination?: boolean;
  appliedExternalPagination?: boolean;
  appliedStageFilters?: boolean;
  nextSkipTokenValues?: string[];
}

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
  execute(ctx: ODataApplyExecutorContext): Promise<ODataApplyExecutorResult | undefined>;
}

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
   * Attempt to match a datasource to a registered executor.
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

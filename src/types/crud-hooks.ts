import { Request, Response } from '@loopback/rest';
import { AnyObject, Entity, Filter, FilterExcludingWhere, Options } from '@loopback/repository';
import type { EntitySetDef } from '../registry/entityset-registry';

export type CrudOperation =
  | 'READ'
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'LINK_NAVIGATION'
  | 'UNLINK_NAVIGATION';
export type CrudScope = 'collection' | 'entity' | 'count';

export const CRUD_OPERATIONS: ReadonlyArray<CrudOperation> = [
  'READ',
  'CREATE',
  'UPDATE',
  'DELETE',
  'LINK_NAVIGATION',
  'UNLINK_NAVIGATION',
];

export interface CrudHookContext {
  // Operation targeting
  operation: CrudOperation;
  scope?: CrudScope;

  // Request wiring
  entitySet?: EntitySetDef;
  repository?: unknown; // DefaultCrudRepository<Entity, unknown>
  options?: Options;
  request: Request;
  response: Response;

  // Common bag to share data across phases
  state: Record<string, unknown>;

  // Operation-specific fields (mutate as needed in hooks)
  id?: unknown;
  payload?: AnyObject;
  filter?: Filter<Entity> | FilterExcludingWhere<Entity>;
  relationName?: string;
  navigationTargetId?: unknown;
  navigationTargetKey?: string;
  navigationTargetUri?: string;
  navigationRelationRepository?: unknown;
  navigationTargetRepository?: unknown;
  navigationTargetEntity?: AnyObject | Entity | undefined;

  // Result of the operation (available in after phase)
  result?: unknown;
}

export interface CrudOnHelpers {
  entity(plain: AnyObject | undefined): AnyObject | undefined;
  collection(items: Array<AnyObject | Entity>, totalCount?: number): AnyObject;
  count(n: number): string;
  noContent(): void;
}

export interface CrudOnContext extends CrudHookContext {
  helpers: CrudOnHelpers;
}

export interface HookMeta {
  methodName: string;
  op: CrudOperation;
  phase: 'before' | 'after' | 'on';
  scope?: CrudScope;
}

export interface CrudHookBundle {
  before: HookMeta[];
  after: HookMeta[];
  on: HookMeta[];
}

import { Request, Response } from '@loopback/rest';
import { AnyObject, Entity, Filter, FilterExcludingWhere, Options } from '@loopback/repository';
import type { EntitySetDef } from '../registry/entityset-registry';

/** CRUD operations that can be intercepted by OData controller hooks. */
export type CrudOperation =
  | 'READ'
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'LINK_NAVIGATION'
  | 'UNLINK_NAVIGATION';
export type CrudScope = 'collection' | 'entity' | 'count';

/** All hookable CRUD operations in the order used by wildcard decorators. */
export const CRUD_OPERATIONS: ReadonlyArray<CrudOperation> = [
  'READ',
  'CREATE',
  'UPDATE',
  'DELETE',
  'LINK_NAVIGATION',
  'UNLINK_NAVIGATION',
];

/**
 * Shared hook context passed to `@odata.before()` and `@odata.after()` handlers.
 *
 * Hooks may inspect and mutate payload, filter, navigation metadata, and shared
 * `state` values as the request moves through the generated CRUD pipeline.
 */
export interface CrudHookContext {
  // Operation targeting
  operation: CrudOperation;
  scope?: CrudScope;

  // Request wiring
  /** @internal Internal resolved entity-set definition for the current request. */
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

/** Helper methods available to `@odata.on()` overrides. */
export interface CrudOnHelpers {
  entity(plain: AnyObject | undefined): AnyObject | undefined;
  collection(items: Array<AnyObject | Entity>, totalCount?: number): AnyObject;
  count(n: number): string;
  noContent(): void;
}

/** Context passed to `@odata.on()` overrides. */
export interface CrudOnContext extends CrudHookContext {
  helpers: CrudOnHelpers;
}

/** Stored metadata describing one decorated hook method. */
export interface HookMeta {
  methodName: string;
  op: CrudOperation;
  phase: 'before' | 'after' | 'on';
  scope?: CrudScope;
}

/** Aggregated hook metadata discovered on an OData controller. */
export interface CrudHookBundle {
  before: HookMeta[];
  after: HookMeta[];
  on: HookMeta[];
}

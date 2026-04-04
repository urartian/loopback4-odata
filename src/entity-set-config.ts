import { Entity } from '@loopback/repository';
import {
  ODataCapabilitiesConfig,
  ODataCompositionEntitySetConfig,
  ODataPaginationConfig,
  ODataSingletonConfig,
} from './types';

/** Maps auth scheme names to concrete method aliases exposed in metadata. */
export type ODataSecurityMethodAliases = Record<string, string | string[]>;

/**
 * Public entity-set registration shape for advanced registry-based overrides.
 *
 * This intentionally contains only user-supplied configuration knobs and omits
 * runtime-populated internal state from the registry implementation.
 */
export interface ODataEntitySetConfig<T extends Entity = Entity> {
  /** Public OData entity-set or singleton name, for example `Products`. */
  name: string;
  /** LoopBack model constructor exposed by this entity set. */
  modelCtor: typeof Entity & { prototype: T };
  /** Optional repository binding key override for custom registration flows. */
  repositoryBindingKey?: string;
  /** Optional metadata aliases for auth/security methods. */
  securityMethodAliases?: ODataSecurityMethodAliases;
  /** Singleton exposure settings when the model should be served as a singleton. */
  singleton?: ODataSingletonConfig;
  /** Properties used to compute entity ETags. */
  etagProperties?: string[];
  /** Capability annotations emitted for this entity set. */
  capabilities?: ODataCapabilitiesConfig;
  /** Per-entity-set composition overrides. */
  composition?: ODataCompositionEntitySetConfig;
  /** Per-entity-set pagination overrides. */
  pagination?: ODataPaginationConfig;
  /** Enables deep insert for this entity set regardless of the global default. */
  deepInsert?: boolean;
  /** Enables deep update for this entity set regardless of the global default. */
  deepUpdate?: boolean;
  /** Enables datastore-backed `$apply` pushdown for this entity set. */
  applyPushdown?: boolean;
  /** Enables delta link emission for this entity set. */
  deltaEnabled?: boolean;
  /** Property used to anchor delta change tracking. */
  deltaField?: string;
  /** Overrides whether this entity set appears in the generated OpenAPI document. */
  documentInOpenApi?: boolean;
  /** Marks the entity set as media-enabled. */
  hasStream?: boolean;
  /** Property name storing binary content for property-backed media handling. */
  mediaField?: string;
  /** Property name storing the media content type. */
  mediaContentTypeField?: string;
  /** Property name storing the media ETag/version. */
  mediaEtagField?: string;
  /** Property name storing the media content length. */
  mediaLengthField?: string;
  /** Binding key for a custom `ODataMediaHandler`. */
  mediaHandlerBindingKey?: string;
  /** Maximum upload payload accepted by the configured media handler. */
  mediaMaxPayloadBytes?: number;
}

/**
 * Public advanced registry API exposed through `ODATA_BINDINGS.ENTITY_SET_REGISTRY`.
 */
export interface ODataEntitySetRegistry {
  /** Registers or updates the public configuration for an entity set. */
  register(def: ODataEntitySetConfig): ODataEntitySetConfig;
  /** Associates a model with a repository binding key, optionally recording the repository ctor. */
  attachRepository(modelCtor: typeof Entity, bindingKey: string, repositoryCtor?: Function): void;
  /** Returns the registered config for the given model constructor. */
  get(modelCtor: typeof Entity): ODataEntitySetConfig | undefined;
  /** Lists every registered public entity-set config. */
  list(): ODataEntitySetConfig[];
  /** Finds a registered config by its exposed OData entity-set name. */
  findByName(name: string): ODataEntitySetConfig | undefined;
}

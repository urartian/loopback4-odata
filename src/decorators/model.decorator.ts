import 'reflect-metadata';
import { MetadataInspector } from '@loopback/core';
import { model as applyModel, Model, MODEL_KEY } from '@loopback/repository';
import { ODataCompositionEntitySetConfig, ODataSingletonConfig } from '../types';
import { registerODataModelCtor } from '../internal/odata-model-registry';
const ODATA_MODEL_KEY = 'odata:model';

export interface ODataModelOptions {
  /**
   * Passed through to LoopBack's `@model(definition)` decorator.
   */
  lbModel?: NonNullable<Parameters<typeof applyModel>[0]>;
  /** Overrides the exposed OData entity-set name for this model. */
  entitySetName?: string;
  /** Property or properties used to compute OData ETags for optimistic concurrency. */
  etag?: string | string[];
  /**
   * Declares a singleton entity for this model.
   *
   * The singleton is exposed under `/odata/<singleton.name>` and points to a single instance
   * backed by the same repository as the entity set.
   */
  singleton?: ODataSingletonConfig;
  /**
   * When true, the model is exposed as a singleton **only** (no collection/entity set CRUD routes).
   *
   * This is useful for “configuration-like” resources (for example `/odata/Settings` or `/odata/Me`)
   * where exposing `POST /odata/<EntitySet>` would be a footgun.
   *
   * Notes:
   * - `singletonOnly: true` requires `singleton` to be configured.
   * - When enabled, the service document and `$metadata` omit the `EntitySet` entry for this model.
   */
  singletonOnly?: boolean;
  /** Enables deep insert for this model regardless of the global default. */
  deepInsert?: boolean;
  /** Enables deep update for this model regardless of the global default. */
  deepUpdate?: boolean;
  /** Enables datastore-backed `$apply` pushdown for this model. */
  applyPushdown?: boolean;
  /** Overrides whether generated routes appear in the published OpenAPI document. */
  documentInOpenApi?: boolean;
  /** Per-model composition overrides for configured relations. */
  composition?: ODataCompositionEntitySetConfig;
  /** Marks the model as media-enabled and exposes `$value` endpoints. */
  hasStream?: boolean;
  /** Property name storing binary content for property-backed media handling. */
  mediaField?: string;
  /** Property name storing the media content type. */
  mediaContentTypeField?: string;
  /** Property name storing the media ETag/version. */
  mediaEtagField?: string;
  /** Property name storing the media content length. */
  mediaLengthField?: string;
  /** Custom IoC binding key used to resolve the media handler for this model. */
  mediaHandlerBindingKey?: string;
  /** Maximum accepted media upload payload for this model's handler. */
  mediaMaxPayloadBytes?: number;
  /** Delta link settings for this model. */
  delta?: {
    /** Enables delta links for this model. */
    enabled?: boolean;
    /** Property used as the change-tracking anchor for delta tokens. */
    field?: string;
  };
}

/**
 * Declares a LoopBack model as OData-enabled and stores the metadata needed to
 * generate routes, CSDL, OpenAPI visibility, media handling, and delta support.
 *
 * If the class does not already have LoopBack `@model()` metadata, this decorator
 * applies it automatically using `opts.lbModel` when provided.
 *
 * @example
 * ```ts
 * @odataModel({
 *   entitySetName: 'Products',
 *   etag: 'updatedAt',
 *   hasStream: true,
 * })
 * export class Product extends Entity {}
 * ```
 */
export function odataModel(opts: ODataModelOptions = {}) {
  return (target: Function) => {
    const hasLoopbackModel = MetadataInspector.getClassMetadata(MODEL_KEY, target) != null;

    if (hasLoopbackModel) {
      if (opts.lbModel != null) {
        throw new Error(
          '@odataModel({ lbModel: ... }) cannot be used on a class that already has @model() metadata. Remove @model() and configure model options via @odataModel({ lbModel: ... }).',
        );
      }
    } else {
      // LoopBack's @model() mutates the passed definition object (e.g., defaulting `name`).
      // Shallow-clone to avoid mutating user-supplied decorator options, which are stored as OData metadata.
      const definition = opts.lbModel ? { ...opts.lbModel } : undefined;
      applyModel(definition ?? {})(target as typeof Model);
    }
    Reflect.defineMetadata(ODATA_MODEL_KEY, opts, target);
    registerODataModelCtor(target as typeof Model);
  };
}

/** @internal Reads raw metadata emitted by `@odataModel()` during boot/runtime wiring. */
export function getODataModelMeta(target: Function): ODataModelOptions | undefined {
  return Reflect.getMetadata(ODATA_MODEL_KEY, target) as ODataModelOptions | undefined;
}

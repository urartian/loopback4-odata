import 'reflect-metadata';
import { MetadataInspector } from '@loopback/core';
import { model as applyModel, Model, MODEL_KEY } from '@loopback/repository';
import { ODataCompositionEntitySetConfig } from '../types';
import { registerODataModelCtor } from '../internal/odata-model-registry';
const ODATA_MODEL_KEY = 'odata:model';

export interface ODataModelOptions {
  /**
   * Passed through to LoopBack's `@model(definition)` decorator.
   */
  lbModel?: NonNullable<Parameters<typeof applyModel>[0]>;
  entitySetName?: string;
  etag?: string | string[];
  deepInsert?: boolean;
  deepUpdate?: boolean;
  applyPushdown?: boolean;
  documentInOpenApi?: boolean;
  composition?: ODataCompositionEntitySetConfig;
  hasStream?: boolean;
  mediaField?: string;
  mediaContentTypeField?: string;
  mediaEtagField?: string;
  mediaLengthField?: string;
  mediaHandlerBindingKey?: string;
  mediaMaxPayloadBytes?: number;
  delta?: {
    enabled?: boolean;
    field?: string;
  };
}

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

export function getODataModelMeta(target: Function): ODataModelOptions | undefined {
  return Reflect.getMetadata(ODATA_MODEL_KEY, target) as ODataModelOptions | undefined;
}

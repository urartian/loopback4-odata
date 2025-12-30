import 'reflect-metadata';
import { MetadataInspector } from '@loopback/core';
import { model as applyModel, Model, MODEL_KEY } from '@loopback/repository';
import { ODataCompositionEntitySetConfig } from '../types';
const ODATA_MODEL_KEY = 'odata:model';

export interface ODataModelOptions {
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
    if (!MetadataInspector.getClassMetadata(MODEL_KEY, target)) {
      applyModel()(target as typeof Model);
    }
    Reflect.defineMetadata(ODATA_MODEL_KEY, opts, target);
  };
}

export function getODataModelMeta(target: Function): ODataModelOptions | undefined {
  return Reflect.getMetadata(ODATA_MODEL_KEY, target) as ODataModelOptions | undefined;
}

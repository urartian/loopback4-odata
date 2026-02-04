import 'reflect-metadata';
import { Model } from '@loopback/repository';
import { isModelCtor } from '../util/model-helpers';

export type ODataBindingScope = 'collection' | 'entity' | 'unbound';

export type ODataTypeRef = string | typeof Model | (() => string | typeof Model);

export type ODataReturnType =
  | ODataTypeRef
  | {
      collection: true;
      type: ODataTypeRef;
    };

export function collectionOf(type: ODataTypeRef): ODataReturnType {
  return { collection: true, type };
}

export interface ODataOperationOptions {
  name?: string;
  binding?: ODataBindingScope;
  returnType?: ODataReturnType;
  rawResponse?: boolean;
}

const ACTION_METADATA_KEY = 'odata:controller:actions';
const FUNCTION_METADATA_KEY = 'odata:controller:functions';

export interface OperationMeta extends Required<Omit<ODataOperationOptions, 'returnType'>> {
  parameters?: OperationParameter[];
  returnType?: ODataReturnType;
  methodName: string;
}

export type OperationParameterType = string | typeof Model | (() => string | typeof Model);

export interface OperationParameter {
  name: string;
  type?: OperationParameterType;
  modelCtor?: typeof Model;
}

function pushMetadata(target: any, key: string, entry: OperationMeta) {
  const existing = (Reflect.getMetadata(key, target) as OperationMeta[] | undefined) ?? [];
  Reflect.defineMetadata(key, [...existing, entry], target);
}

export function odataAction(
  options: ODataOperationOptions & { params?: OperationParameter[] } = {},
) {
  return (target: object, methodName: string) => {
    pushMetadata(target, ACTION_METADATA_KEY, {
      methodName,
      name: options.name ?? methodName,
      binding: options.binding ?? 'entity',
      rawResponse: options.rawResponse ?? false,
      returnType: options.returnType,
      parameters: normalizeOperationParameters(options.params),
    });
  };
}

export function odataFunction(
  options: ODataOperationOptions & { params?: OperationParameter[] } = {},
) {
  return (target: object, methodName: string) => {
    pushMetadata(target, FUNCTION_METADATA_KEY, {
      methodName,
      name: options.name ?? methodName,
      binding: options.binding ?? 'entity',
      rawResponse: options.rawResponse ?? false,
      returnType: options.returnType,
      parameters: normalizeOperationParameters(options.params),
    });
  };
}

export function getODataActions(target: Function): OperationMeta[] {
  return (
    (Reflect.getMetadata(ACTION_METADATA_KEY, target.prototype) as OperationMeta[] | undefined) ??
    []
  );
}

export function getODataFunctions(target: Function): OperationMeta[] {
  return (
    (Reflect.getMetadata(FUNCTION_METADATA_KEY, target.prototype) as OperationMeta[] | undefined) ??
    []
  );
}

function normalizeOperationParameters(
  params?: OperationParameter[],
): OperationParameter[] | undefined {
  if (!params) return undefined;
  return params.map((param) => {
    const ctor = resolveOperationParameterCtor(param.type);
    if (!ctor) return { ...param };
    return { ...param, modelCtor: ctor };
  });
}

function resolveOperationParameterCtor(
  type: OperationParameterType | undefined,
): typeof Model | undefined {
  if (!type) return undefined;
  if (typeof type === 'function') {
    if (isModelConstructor(type)) {
      return type as typeof Model;
    }
    try {
      const resolved = (type as () => string | typeof Model)();
      if (isModelConstructor(resolved)) return resolved;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isModelConstructor(value: unknown): value is typeof Model {
  return isModelCtor(value);
}

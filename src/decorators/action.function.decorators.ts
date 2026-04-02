import 'reflect-metadata';
import { Model } from '@loopback/repository';
import { isModelCtor } from '../util/model-helpers';

export type ODataBindingScope = 'collection' | 'entity' | 'unbound';

/** Type reference accepted by OData action/function metadata. */
export type ODataTypeRef = string | typeof Model | (() => string | typeof Model);

/** Return type descriptor used for OData actions and functions. */
export type ODataReturnType =
  | ODataTypeRef
  | {
      collection: true;
      type: ODataTypeRef;
    };

/**
 * Marks an action/function return type as a collection of the referenced type.
 *
 * @example
 * ```ts
 * @odataFunction({binding: 'collection', returnType: collectionOf(Product)})
 * listFeatured() {
 *   return [];
 * }
 * ```
 */
export function collectionOf(type: ODataTypeRef): ODataReturnType {
  return { collection: true, type };
}

/** Shared options for OData actions and functions. */
export interface ODataOperationOptions {
  /** Public OData operation name. Defaults to the method name. */
  name?: string;
  /** Binding scope for the operation. Defaults to `'entity'`. */
  binding?: ODataBindingScope;
  /** Optional OData return type metadata. */
  returnType?: ODataReturnType;
  /** When true, the controller method is responsible for writing the raw HTTP response. */
  rawResponse?: boolean;
}

const ACTION_METADATA_KEY = 'odata:controller:actions';
const FUNCTION_METADATA_KEY = 'odata:controller:functions';

/** Normalized metadata stored for each declared OData action/function. */
export interface OperationMeta extends Required<Omit<ODataOperationOptions, 'returnType'>> {
  parameters?: OperationParameter[];
  returnType?: ODataReturnType;
  methodName: string;
}

/** Type reference accepted for action/function parameters. */
export type OperationParameterType = string | typeof Model | (() => string | typeof Model);

/** Declares one input parameter for an OData action or function. */
export interface OperationParameter {
  name: string;
  type?: OperationParameterType;
  modelCtor?: typeof Model;
}

function pushMetadata(target: any, key: string, entry: OperationMeta) {
  const existing = (Reflect.getMetadata(key, target) as OperationMeta[] | undefined) ?? [];
  Reflect.defineMetadata(key, [...existing, entry], target);
}

/**
 * Declares an OData action on an `@odataController()` class method.
 *
 * Actions may be bound to a single entity, a collection, or be unbound. They
 * may also declare typed parameters and raw-response handling.
 *
 * @example
 * ```ts
 * @odataAction({
 *   binding: 'entity',
 *   params: [{name: 'percent', type: 'Edm.Int32'}],
 * })
 * discount(percent: number) {
 *   return {applied: percent};
 * }
 * ```
 */
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

/**
 * Declares an OData function on an `@odataController()` class method.
 *
 * Functions are side-effect-free operations that can be invoked on an entity,
 * collection, or as unbound operations.
 *
 * @example
 * ```ts
 * @odataFunction({
 *   binding: 'collection',
 *   returnType: collectionOf(Product),
 * })
 * featured() {
 *   return [];
 * }
 * ```
 */
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

/** @internal Reads raw action metadata during controller bootstrapping. */
export function getODataActions(target: Function): OperationMeta[] {
  return (
    (Reflect.getMetadata(ACTION_METADATA_KEY, target.prototype) as OperationMeta[] | undefined) ??
    []
  );
}

/** @internal Reads raw function metadata during controller bootstrapping. */
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

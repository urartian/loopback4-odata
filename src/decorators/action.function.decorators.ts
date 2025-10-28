import 'reflect-metadata';

export type ODataBindingScope = 'collection' | 'entity' | 'unbound';

export interface ODataOperationOptions {
  name?: string;
  binding?: ODataBindingScope;
  returnType?: string;
  rawResponse?: boolean;
}

const ACTION_METADATA_KEY = 'odata:controller:actions';
const FUNCTION_METADATA_KEY = 'odata:controller:functions';

export interface OperationMeta extends Required<Omit<ODataOperationOptions, 'returnType'>> {
  parameters?: OperationParameter[];
  returnType?: string;
  methodName: string;
}

export interface OperationParameter {
  name: string;
  type?: string;
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
      parameters: options.params,
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
      parameters: options.params,
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

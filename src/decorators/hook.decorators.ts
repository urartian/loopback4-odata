import 'reflect-metadata';
import { CrudHookBundle, CrudOperation, CrudScope, CRUD_OPERATIONS } from '../types/crud-hooks';

const BEFORE_KEY = 'odata:controller:hooks:before';
const AFTER_KEY = 'odata:controller:hooks:after';
const ON_KEY = 'odata:controller:hooks:on';

function push(
  target: any,
  key: string,
  entry: { methodName: string; op: CrudOperation; scope?: CrudScope },
) {
  const existing = (Reflect.getMetadata(key, target) as Array<any> | undefined) ?? [];
  Reflect.defineMetadata(key, [...existing, entry], target);
}

type CrudOperationInput = CrudOperation | ReadonlyArray<CrudOperation> | '*';

function decoratorFactory(phase: 'before' | 'after' | 'on') {
  const key = phase === 'before' ? BEFORE_KEY : phase === 'after' ? AFTER_KEY : ON_KEY;
  return (input: CrudOperationInput, scope?: CrudScope) => (target: object, methodName: string) => {
    const ops = input === '*' ? CRUD_OPERATIONS : Array.isArray(input) ? input : [input];

    ops.forEach((op) => {
      push(target, key, { methodName, op, scope: op === 'READ' ? scope : undefined });
    });
  };
}

export const odata = {
  before: decoratorFactory('before'),
  after: decoratorFactory('after'),
  on: decoratorFactory('on'),
};

export function getODataHooks(ctor: Function): CrudHookBundle {
  const proto = ctor.prototype;
  const before = (Reflect.getMetadata(BEFORE_KEY, proto) as any[] | undefined) ?? [];
  const after = (Reflect.getMetadata(AFTER_KEY, proto) as any[] | undefined) ?? [];
  const on = (Reflect.getMetadata(ON_KEY, proto) as any[] | undefined) ?? [];
  return { before, after, on };
}

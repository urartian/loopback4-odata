import 'reflect-metadata';

const ODATA_CTRL_MODEL_KEY = 'odata:controller:model';

/**
 * Associates a controller with the LoopBack model it exposes through OData.
 *
 * The component uses this metadata during boot to bind the controller to the
 * corresponding entity set, actions/functions, hooks, and route generation.
 *
 * @example
 * ```ts
 * @odataController(Product)
 * export class ProductODataController {}
 * ```
 */
export function odataController(modelCtor: Function) {
  return (target: Function) => {
    Reflect.defineMetadata(ODATA_CTRL_MODEL_KEY, modelCtor, target);
  };
}

/** @internal Reads raw metadata emitted by `@odataController()` during boot/runtime wiring. */
export function getODataControllerModel(target: Function) {
  return Reflect.getMetadata(ODATA_CTRL_MODEL_KEY, target) as Function | undefined;
}

import 'reflect-metadata';

const ODATA_SEARCHABLE_PROPS_KEY = 'odata:model:searchable:props';

/**
 * Marks a model property as searchable by `$search` when search mode is
 * configured to use annotated fields.
 *
 * @example
 * ```ts
 * @property()
 * @odataSearchable()
 * name: string;
 * ```
 */
export function odataSearchable() {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as any)?.constructor as Function | undefined;
    if (!ctor) return;
    const existing =
      (Reflect.getMetadata(ODATA_SEARCHABLE_PROPS_KEY, ctor) as string[] | undefined) ?? [];
    const name = String(propertyKey);
    if (!existing.includes(name)) {
      Reflect.defineMetadata(ODATA_SEARCHABLE_PROPS_KEY, [...existing, name], ctor);
    }
  };
}

/** @internal Reads searchable-property metadata during model bootstrapping. */
export function getODataSearchableProps(target: Function): string[] | undefined {
  return (
    (Reflect.getMetadata(ODATA_SEARCHABLE_PROPS_KEY, target) as string[] | undefined) ?? undefined
  );
}

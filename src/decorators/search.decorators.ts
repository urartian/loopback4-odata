import 'reflect-metadata';

const ODATA_SEARCHABLE_PROPS_KEY = 'odata:model:searchable:props';

export function odataSearchable() {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as any)?.constructor as Function | undefined;
    if (!ctor) return;
    const existing = (Reflect.getMetadata(ODATA_SEARCHABLE_PROPS_KEY, ctor) as string[] | undefined) ?? [];
    const name = String(propertyKey);
    if (!existing.includes(name)) {
      Reflect.defineMetadata(ODATA_SEARCHABLE_PROPS_KEY, [...existing, name], ctor);
    }
  };
}

export function getODataSearchableProps(target: Function): string[] | undefined {
  return (Reflect.getMetadata(ODATA_SEARCHABLE_PROPS_KEY, target) as string[] | undefined) ?? undefined;
}


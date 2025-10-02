import 'reflect-metadata';
import {MetadataAccessor, MetadataInspector} from '@loopback/core';

type ClassMetadataKey = MetadataAccessor<unknown, ClassDecorator>;
type MethodMetadataKey = MetadataAccessor<unknown, MethodDecorator>;

interface MetadataAlias {
    alias: string;
    classKeys?: ClassMetadataKey[];
    methodKeys?: MethodMetadataKey[];
}

export type MethodAliasMap = Record<string, string | string[]>;

const AUTHENTICATION_CLASS_KEY = MetadataAccessor.create<unknown, ClassDecorator>('authentication:class');
const AUTHENTICATION_METHOD_KEY = MetadataAccessor.create<unknown, MethodDecorator>('authentication:method');
const AUTHORIZATION_CLASS_KEY = MetadataAccessor.create<unknown, ClassDecorator>('authorization:class');
const AUTHORIZATION_METHOD_KEY = MetadataAccessor.create<unknown, MethodDecorator>('authorization:method');
const LEGACY_AUTHENTICATION_CLASS_KEY = MetadataAccessor.create<unknown, ClassDecorator>('authentication:metadata');
const LEGACY_AUTHENTICATION_METHOD_KEY = MetadataAccessor.create<unknown, MethodDecorator>('authentication:metadata');
const LEGACY_AUTHORIZATION_CLASS_KEY = MetadataAccessor.create<unknown, ClassDecorator>('authorization:metadata');
const LEGACY_AUTHORIZATION_METHOD_KEY = MetadataAccessor.create<unknown, MethodDecorator>('authorization:metadata');

const METADATA_ALIASES: MetadataAlias[] = [
    {
        alias: 'authentication:metadata',
        classKeys: [LEGACY_AUTHENTICATION_CLASS_KEY, AUTHENTICATION_CLASS_KEY],
        methodKeys: [LEGACY_AUTHENTICATION_METHOD_KEY, AUTHENTICATION_METHOD_KEY],
    },
    {
        alias: 'authorization:metadata',
        classKeys: [LEGACY_AUTHORIZATION_CLASS_KEY, AUTHORIZATION_CLASS_KEY],
        methodKeys: [LEGACY_AUTHORIZATION_METHOD_KEY, AUTHORIZATION_METHOD_KEY],
    },
    {
        alias: 'authentication:class',
        classKeys: [AUTHENTICATION_CLASS_KEY, LEGACY_AUTHENTICATION_CLASS_KEY],
    },
    {
        alias: 'authentication:method',
        methodKeys: [AUTHENTICATION_METHOD_KEY, LEGACY_AUTHENTICATION_METHOD_KEY],
    },
    {
        alias: 'authorization:class',
        classKeys: [AUTHORIZATION_CLASS_KEY, LEGACY_AUTHORIZATION_CLASS_KEY],
    },
    {
        alias: 'authorization:method',
        methodKeys: [AUTHORIZATION_METHOD_KEY, LEGACY_AUTHORIZATION_METHOD_KEY],
    },
];

export interface ControllerSecurityMetadata {
    classMetadata: Record<string, unknown>;
    methodMetadata: Record<string, Record<string, unknown>>;
}

export function collectControllerSecurityMetadata(ctor: Function): ControllerSecurityMetadata | undefined {
    const classMetadata: Record<string, unknown> = {};
    const methodMetadata: Record<string, Record<string, unknown>> = {};

    const prototype = ctor.prototype ?? {};
    const prototypeMethods = Object.getOwnPropertyNames(prototype)
        .filter(name => name !== 'constructor');

    for (const mapping of METADATA_ALIASES) {
        const classValue = readClassMetadata(ctor, mapping.classKeys);
        if (classValue !== undefined) {
            classMetadata[mapping.alias] = classValue;
        }

        if (!mapping.methodKeys?.length) continue;

        for (const methodName of prototypeMethods) {
            const value = readMethodMetadata(prototype, methodName, mapping.methodKeys);
            if (value === undefined) continue;
            if (!methodMetadata[methodName]) {
                methodMetadata[methodName] = {};
            }
            methodMetadata[methodName][mapping.alias] = value;
        }
    }

    if (!Object.keys(classMetadata).length && !Object.keys(methodMetadata).length) {
        return undefined;
    }

    return { classMetadata, methodMetadata };
}

export function applyControllerSecurityMetadata(
    targetCtor: Function,
    metadata: ControllerSecurityMetadata | undefined,
    availableMethods?: string[],
    methodNameRemap?: MethodAliasMap,
) {
    if (!metadata) return;
    const { classMetadata, methodMetadata } = metadata;
    const allowedMethods = new Set<string>(availableMethods ?? Object.keys(methodMetadata ?? {}));
    const restrictToAllowed = Boolean(availableMethods?.length);

    for (const mapping of METADATA_ALIASES) {
        const classValue = classMetadata?.[mapping.alias];
        if (classValue !== undefined && mapping.classKeys?.length) {
            for (const key of mapping.classKeys) {
                defineClassMetadata(key, classValue, targetCtor);
            }
        }

        if (!mapping.methodKeys?.length || !methodMetadata) continue;

        const methodValues: Record<string, unknown> = {};

        for (const [methodName, aliasValues] of Object.entries(methodMetadata)) {
            const targetNames = resolveMethodAliasNames(methodName, methodNameRemap);
            const value = aliasValues?.[mapping.alias];
            if (value === undefined) continue;
            for (const targetName of targetNames) {
                if (restrictToAllowed && !allowedMethods.has(targetName)) continue;
                if (!Object.getOwnPropertyDescriptor(targetCtor.prototype, targetName)) continue;
                if (methodValues[targetName] !== undefined) continue;
                methodValues[targetName] = value;
            }
        }

        if (!Object.keys(methodValues).length) continue;

        const metadataMap = { ...methodValues };

        for (const key of mapping.methodKeys) {
            defineMethodMetadata(key, metadataMap, targetCtor.prototype);
        }
    }
}

function readClassMetadata(target: Function, keys?: ClassMetadataKey[]): unknown {
    if (!keys?.length) return undefined;
    for (const key of keys) {
        const value = MetadataInspector.getClassMetadata(key, target)
            ?? Reflect.getMetadata(key.toString(), target);
        if (value !== undefined) return value;
    }
    return undefined;
}

function defineClassMetadata(key: ClassMetadataKey, value: unknown, targetCtor: Function) {
    MetadataInspector.defineMetadata(key, value, targetCtor);
    Reflect.defineMetadata(key.toString(), value, targetCtor);
}

function defineMethodMetadata(key: MethodMetadataKey, value: Record<string, unknown>, target: object) {
    MetadataInspector.defineMetadata(key, value, target);
    for (const [methodName, methodValue] of Object.entries(value)) {
        Reflect.defineMetadata(key.toString(), methodValue, target, methodName);
    }
}

function readMethodMetadata(target: object, methodName: string, keys?: MethodMetadataKey[]): unknown {
    if (!keys?.length) return undefined;
    for (const key of keys) {
        const value = MetadataInspector.getMethodMetadata(key, target, methodName)
            ?? Reflect.getMetadata(key.toString(), target, methodName);
        if (value !== undefined) return value;
    }
    return undefined;
}

function resolveMethodAliasNames(methodName: string, aliasMap?: MethodAliasMap): string[] {
    const mapped = aliasMap?.[methodName];
    const targets = Array.isArray(mapped) ? mapped : mapped != null ? [mapped] : [];
    return Array.from(new Set<string>([methodName, ...targets]));
}

export function mergeMethodAliasMaps(...maps: (MethodAliasMap | undefined)[]): MethodAliasMap | undefined {
    const aggregated = new Map<string, string[]>();

    for (const map of maps) {
        if (!map) continue;
        for (const [source, aliases] of Object.entries(map)) {
            if (aliases === undefined) continue;
            const normalized = (Array.isArray(aliases) ? aliases : [aliases])
                .map(name => name?.trim())
                .filter((name): name is string => Boolean(name));
            if (!normalized.length) {
                aggregated.delete(source);
                continue;
            }
            const unique = Array.from(new Set(normalized));
            aggregated.set(source, unique);
        }
    }

    if (!aggregated.size) return undefined;

    const result: MethodAliasMap = {};
    for (const [source, aliases] of aggregated.entries()) {
        result[source] = aliases.length === 1 ? aliases[0] : aliases;
    }
    return result;
}

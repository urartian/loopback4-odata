import 'reflect-metadata';
import {MetadataInspector} from '@loopback/core';

const METADATA_KEYS = ['authentication:metadata', 'authorization:metadata'];

export interface ControllerSecurityMetadata {
    classMetadata: Record<string, unknown>;
    methodMetadata: Record<string, Record<string, unknown>>;
}

export function collectControllerSecurityMetadata(ctor: Function): ControllerSecurityMetadata | undefined {
    const classMetadata: Record<string, unknown> = {};
    const methodMetadata: Record<string, Record<string, unknown>> = {};

    for (const key of METADATA_KEYS) {
        const classValue = MetadataInspector.getClassMetadata<unknown>(key, ctor)
            ?? Reflect.getMetadata(key, ctor);
        if (classValue !== undefined) {
            classMetadata[key] = classValue;
        }

        const discovered = MetadataInspector.getAllMethodMetadata<unknown>(key, ctor.prototype) ?? {};
        const methodValues: Record<string, unknown> = { ...discovered };
        const prototypeMethods = Object.getOwnPropertyNames(ctor.prototype ?? {})
            .filter(name => name !== 'constructor');

        for (const methodName of prototypeMethods) {
            if (methodValues[methodName] !== undefined) continue;
            const direct = Reflect.getMetadata(key, ctor.prototype, methodName);
            if (direct !== undefined) {
                methodValues[methodName] = direct;
            }
        }

        for (const [methodName, value] of Object.entries(methodValues)) {
            if (value === undefined) continue;
            if (!methodMetadata[methodName]) {
                methodMetadata[methodName] = {};
            }
            methodMetadata[methodName][key] = value;
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
) {
    if (!metadata) return;
    const { classMetadata, methodMetadata } = metadata;

    for (const [key, value] of Object.entries(classMetadata ?? {})) {
        Reflect.defineMetadata(key, value, targetCtor);
    }

    const allowedMethods = new Set<string>(availableMethods ?? Object.keys(methodMetadata ?? {}));

    for (const methodName of Object.keys(methodMetadata ?? {})) {
        if (!allowedMethods.has(methodName)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(targetCtor.prototype, methodName);
        if (!descriptor) continue;
        const values = methodMetadata?.[methodName] ?? {};
        for (const [key, value] of Object.entries(values)) {
            Reflect.defineMetadata(key, value, targetCtor.prototype, methodName);
        }
    }
}

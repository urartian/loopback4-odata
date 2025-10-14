import { Application, Binding, CoreBindings, inject, injectable, ValueOrPromise, invokeMethodWithInterceptors } from '@loopback/core';
import { Booter } from '@loopback/boot';
import { ControllerClass, RestApplication, RequestContext, OperationObject, Route, RouteEntry, RouteSource, HttpErrors } from '@loopback/rest';
import { EntitySetDef, EntitySetRegistry } from '../registry/entityset-registry';
import { getODataControllerModel } from '../decorators/controller.decorator';
import { defineODataCrudController } from '../controllers/crud-controller-factory';
import { getODataModelMeta } from '../decorators/model.decorator';
import { ODATA_BINDINGS } from '../keys';
import { Entity } from '@loopback/repository';
import { getODataActions, getODataFunctions, OperationMeta } from '../decorators/action.function.decorators';
import { pluralize } from 'inflection';
import { normalizeEtagProperties } from '../util/etag';
import { collectControllerSecurityMetadata } from '../util/security-metadata';
import {getODataHooks} from '../decorators/hook.decorators';
import type {CrudHookBundle} from '../types/crud-hooks';
import { ODataConfig } from '../types';

@injectable({ tags: { booters: 'odata' } })
export class ODataBooter implements Booter {
    constructor(
        @inject(CoreBindings.APPLICATION_INSTANCE) private app: Application,
        @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY) private registry: EntitySetRegistry,
        @inject(ODATA_BINDINGS.CONFIG) private readonly config: ODataConfig,
    ) { }

    async load(): Promise<void> {
        const repositoryBindings = this.app.find('repositories.*');
        const repositoryByKey = new Map<string, Readonly<Binding<unknown>>>();
        const repositoryByEntity = new Map<typeof Entity, Readonly<Binding<unknown>>>();
        const inspectedRepositoryBindings = new Set<string>();
        const controllerBindings = this.app.find('controllers.*');

        for (const binding of repositoryBindings) {
            repositoryByKey.set(binding.key, binding);
        }

        for (const binding of controllerBindings) {
            const ctor = binding.valueConstructor as ControllerClass<{ [key: string]: any }>;
            if (!ctor) continue;

            const modelCtor = getODataControllerModel(ctor) as (typeof Entity | undefined);
            if (!modelCtor) continue;

            const setName = this.getEntitySetName(modelCtor);
            const repoBinding = await this.resolveRepositoryBindingForModel(
                modelCtor,
                repositoryBindings,
                repositoryByKey,
                repositoryByEntity,
                inspectedRepositoryBindings,
            );
            const modelMeta = getODataModelMeta(modelCtor);

            if (!repoBinding) {
                throw new Error(
                    `OData controller for model ${modelCtor.name} requires a DefaultCrudRepository instance. ` +
                    `Ensure a repository for ${modelCtor.name} is registered via app.repository(${modelCtor.name}Repository) ` +
                    `or mounted through a component before booting the OData component.`,
                );
            }

            const securityMetadata = collectControllerSecurityMetadata(ctor);
            const hooks = getODataHooks(ctor);

            // Validate @odata.on uniqueness per (op, scope)
            if (hooks.on?.length) {
                const seen = new Set<string>();
                for (const h of hooks.on) {
                    const key = `${h.op}:${h.scope ?? '-'}`;
                    if (seen.has(key)) {
                        throw new Error(
                            `Duplicate @odata.on for ${key} on controller ${ctor.name}. Only one override per operation/scope is allowed.`,
                        );
                    }
                    seen.add(key);
                }
            }

            const deepInsert = modelMeta?.deepInsert ?? Boolean(this.config?.enableDeepInsert);
            const def = this.registry.register({
                name: setName,
                modelCtor,
                repositoryBindingKey: repoBinding.key,
                repositoryCtor: repoBinding.valueConstructor ?? undefined,
                etagProperties: normalizeEtagProperties(modelMeta?.etag),
                securityMetadata,
                hooks: hooks as CrudHookBundle,
                sourceControllerBindingKey: binding.key,
                deepInsert,
            });

            const CrudController = defineODataCrudController(def);
            def.controllerCtor = CrudController;
            this.app.controller(CrudController);
            this.registerOperations(def, ctor);
        }
    }

    private async resolveRepositoryBindingForModel(
        modelCtor: typeof Entity,
        repositoryBindings: ReadonlyArray<Readonly<Binding<unknown>>>,
        repositoryByKey: Map<string, Readonly<Binding<unknown>>>,
        repositoryByEntity: Map<typeof Entity, Readonly<Binding<unknown>>>,
        inspectedBindings: Set<string>,
    ): Promise<Readonly<Binding<unknown>> | undefined> {
        const cached = repositoryByEntity.get(modelCtor);
        if (cached) return cached;

        for (const key of this.buildRepositoryKeyCandidates(modelCtor)) {
            const binding = repositoryByKey.get(key);
            if (binding) {
                repositoryByEntity.set(modelCtor, binding);
                return binding;
            }
        }

        for (const binding of repositoryBindings) {
            if (repositoryByEntity.has(modelCtor)) break;
            if (inspectedBindings.has(binding.key)) continue;
            inspectedBindings.add(binding.key);

            try {
                const repoInstance = await binding.getValue(this.app);
                const entityCtor = (repoInstance as { entityClass?: typeof Entity }).entityClass;
                if (entityCtor && !repositoryByEntity.has(entityCtor)) {
                    repositoryByEntity.set(entityCtor, binding);
                }
            } catch {
                // Ignore bindings that cannot be resolved at boot time.
            }
        }

        return repositoryByEntity.get(modelCtor);
    }

    private buildRepositoryKeyCandidates(modelCtor: typeof Entity): string[] {
        const candidates = new Set<string>();
        const rawName = modelCtor?.name ?? '';
        const trimmed = rawName.trim();
        if (!trimmed) return [];

        candidates.add(this.composeRepositoryBindingKey(trimmed));

        if (trimmed.endsWith('Entity')) {
            const withoutEntity = trimmed.slice(0, -'Entity'.length).trim();
            if (withoutEntity) candidates.add(this.composeRepositoryBindingKey(withoutEntity));
        }

        if (trimmed.endsWith('Model')) {
            const withoutModel = trimmed.slice(0, -'Model'.length).trim();
            if (withoutModel) candidates.add(this.composeRepositoryBindingKey(withoutModel));
        }

        return Array.from(candidates);
    }

    private composeRepositoryBindingKey(name: string): string {
        return `repositories.${name}Repository`;
    }

    private getEntitySetName(modelCtor: typeof Entity): string {
        const meta = getODataModelMeta(modelCtor);
        if (meta?.entitySetName) return meta.entitySetName;
        const baseName = modelCtor?.name?.trim()?.length ? modelCtor.name : 'Entity';
        const plural = pluralize(baseName);
        return plural?.trim()?.length ? plural : `${baseName}s`;
    }

    private registerOperations(def: EntitySetDef, controllerCtor: Function) {
        const actions = getODataActions(controllerCtor);
        const functions = getODataFunctions(controllerCtor);
        if (!actions.length && !functions.length) return;

        const app = this.app as RestApplication;
        const basePath = `/odata/${def.name}`;
        def.actions = actions;
        def.functions = functions;

        for (const action of actions) {
            app.route(this.buildOperationRoute(action, controllerCtor, basePath, 'post'));
        }

        for (const fn of functions) {
            app.route(this.buildOperationRoute(fn, controllerCtor, basePath, 'get'));
        }
    }

    private buildOperationRoute(
        op: OperationMeta,
        controllerCtor: Function,
        basePath: string,
        verb: 'get' | 'post',
    ): RouteEntry {
        let path = basePath;
        if (op.binding === 'entity') path += '/{id}';
        path += `/${op.name}`;

        const spec: OperationObject = {
            parameters: op.binding === 'entity'
                ? [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }]
                : undefined,
            requestBody: verb === 'post'
                ? {
                    required: true,
                    content: {
                        'application/json': { schema: { type: 'object' } },
                    },
                }
                : undefined,
            responses: {
                '200': { description: `${op.name} result` },
            },
        };

        const setSegment = op.binding === 'unbound'
            ? undefined
            : basePath.split('/').pop() ?? '';
        const bindingKey = `controllers.${controllerCtor.name}`;
        const routePath = op.binding === 'unbound'
            ? `/odata/${op.name}`
            : path;

        return new ODataOperationRoute(
            verb,
            routePath,
            spec,
            async (ctx: RequestContext, ...params: unknown[]) => {
                const controller = await ctx.get(bindingKey as any) as any;
                const args: unknown[] = [];
                if (op.binding === 'entity') {
                    const routeParams = ctx.request.params as Record<string, unknown> | undefined;
                    let id = routeParams?.id;

                    if (id == null && params.length) {
                        const candidate = params[0];
                        if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
                            id = candidate;
                        }
                    }
                    if (id == null) {
                        const segments = ctx.request.path.split('/').filter(Boolean);
                        id = segments.length >= 4 ? segments[segments.length - 2] : undefined;
                    }
                    if (id == null) {
                        throw new HttpErrors.BadRequest(`Missing entity key for ${op.name}.`);
                    }
                    args.push(id);
                }
                if (verb === 'post') {
                    args.push(ctx.request.body);
                } else {
                    args.push(ctx.request.query);
                }
                const result = await controller[op.methodName](...args);
                if (op.rawResponse) return result;
                const context = setSegment ? `/odata/$metadata#${setSegment}` : '/odata/$metadata';
                return {
                    '@odata.context': context,
                    value: result,
                };
            },
        );
    }
}

type OperationHandler = (ctx: RequestContext, ...params: unknown[]) => ValueOrPromise<unknown>;

class ODataOperationRoute extends Route {
    constructor(verb: string, path: string, spec: OperationObject, handler: OperationHandler) {
        super(verb, path, spec, handler);
    }

    async invokeHandler(requestContext: RequestContext, args: unknown[]): Promise<unknown> {
        return invokeMethodWithInterceptors(
            requestContext,
            this,
            '_handler',
            [requestContext, ...args],
            { source: new RouteSource(this) },
        );
    }
}

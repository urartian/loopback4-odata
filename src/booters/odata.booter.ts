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

@injectable({ tags: { booters: 'odata' } })
export class ODataBooter implements Booter {
    constructor(
        @inject(CoreBindings.APPLICATION_INSTANCE) private app: Application,
        @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY) private registry: EntitySetRegistry,
    ) { }

    async load(): Promise<void> {
        const repositoryMap = await this.buildRepositoryMap();
        const bindings = this.app.find('controllers.*');

        for (const binding of bindings) {
            const ctor = binding.valueConstructor as ControllerClass<{ [key: string]: any }>;
            if (!ctor) continue;

            const modelCtor = getODataControllerModel(ctor) as (typeof Entity | undefined);
            if (!modelCtor) continue;

            const setName = this.getEntitySetName(modelCtor);
            const repoBinding = repositoryMap.get(modelCtor);
            const modelMeta = getODataModelMeta(modelCtor);

            if (!repoBinding) {
                throw new Error(
                    `OData controller for model ${modelCtor.name} requires a DefaultCrudRepository instance. ` +
                    `Ensure a repository for ${modelCtor.name} is registered via app.repository(${modelCtor.name}Repository) ` +
                    `or mounted through a component before booting the OData component.`,
                );
            }

            const def = this.registry.register({
                name: setName,
                modelCtor,
                repositoryBindingKey: repoBinding.key,
                repositoryCtor: repoBinding.valueConstructor ?? undefined,
                etagProperties: normalizeEtagProperties(modelMeta?.etag),
            });

            const CrudController = defineODataCrudController(def);
            def.controllerCtor = CrudController;
            this.app.controller(CrudController);
            this.registerOperations(def, ctor);
        }
    }

    private async buildRepositoryMap(): Promise<Map<typeof Entity, Readonly<Binding<unknown>>>> {
        const repoBindings = this.app.find('repositories.*');
        const map = new Map<typeof Entity, Readonly<Binding<unknown>>>();

        for (const binding of repoBindings) {
            try {
                const repoInstance = await binding.getValue(this.app);
                const entityCtor = (repoInstance as { entityClass?: typeof Entity }).entityClass;
                if (entityCtor) {
                    map.set(entityCtor, binding);
                }
            } catch (err) {
                // Ignore bindings that cannot be resolved at boot time.
            }
        }

        return map;
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

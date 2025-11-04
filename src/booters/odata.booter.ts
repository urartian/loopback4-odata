import {
  Application,
  Binding,
  CoreBindings,
  MetadataInspector,
  inject,
  injectable,
  ValueOrPromise,
  invokeMethodWithInterceptors,
} from '@loopback/core';
import { Booter } from '@loopback/boot';
import {
  ControllerClass,
  RestApplication,
  RequestContext,
  OperationObject,
  Route,
  RouteEntry,
  RouteSource,
  HttpErrors,
} from '@loopback/rest';
import { EntitySetDef, EntitySetRegistry } from '../registry/entityset-registry';
import { getODataControllerModel } from '../decorators/controller.decorator';
import { defineODataCrudController } from '../controllers/crud-controller-factory';
import { getODataModelMeta, ODataModelOptions } from '../decorators/model.decorator';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import {
  AnyObject,
  Entity,
  ModelDefinition,
  MODEL_KEY,
  buildModelDefinition,
  juggler,
  RelationDefinitionMap,
} from '@loopback/repository';
import {
  getODataActions,
  getODataFunctions,
  OperationMeta,
} from '../decorators/action.function.decorators';
import { pluralize } from 'inflection';
import { normalizeEtagProperties } from '../util/etag';
import { collectControllerSecurityMetadata } from '../util/security-metadata';
import { getODataHooks } from '../decorators/hook.decorators';
import type { CrudHookBundle } from '../types/crud-hooks';
import { ODataConfig } from '../types';
import { ensureNavigationTargetKey } from '../util/relation-metadata';
import { ODataApplyExecutorRegistry } from '../services/odata-apply-executor.registry';
import { inferSqlMetadata } from '../util/sql-metadata';
import { ODATA_VERSION } from '../constants';

@injectable({ tags: { booters: 'odata' } })
export class ODataBooter implements Booter {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE) private app: Application,
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY) private registry: EntitySetRegistry,
    @inject(ODATA_BINDINGS.CONFIG) private readonly config: ODataConfig,
    @inject(ODATA_BINDINGS.APPLY_EXECUTOR_REGISTRY)
    private readonly executorRegistry: ODataApplyExecutorRegistry,
    @inject(ODATA_BINDINGS.LOGGER)
    private readonly logger: ODataLogger,
  ) {}

  private identifyCompositionRelations(
    modelCtor: typeof Entity | undefined,
    modelDefinition: ModelDefinition | undefined,
  ): {
    hasCompositionalRelation: boolean;
    missingDeepUpdate: string[];
  } {
    if (!modelCtor) {
      return { hasCompositionalRelation: false, missingDeepUpdate: [] };
    }
    const relations = modelDefinition?.relations ?? ({} as RelationDefinitionMap);
    const missing: string[] = [];
    let hasComposition = false;
    for (const [name, relation] of Object.entries(relations)) {
      if (!relation) continue;
      const relationType = (relation as AnyObject).type ?? (relation as AnyObject).relationType;
      if (relationType !== 'hasMany' && relationType !== 'hasOne') continue;
      if ((relation as AnyObject).through) continue;
      const keyTo = (relation as AnyObject).keyTo;
      const targetGetter = (relation as AnyObject).target;
      const targetCtor =
        typeof targetGetter === 'function'
          ? (targetGetter() as typeof Entity | undefined)
          : undefined;
      const targetDef = targetCtor
        ? ((targetCtor as unknown as { definition?: ModelDefinition }).definition as
            | ModelDefinition
            | undefined)
        : undefined;
      let fkRequired = false;
      if (keyTo && targetDef?.properties?.[keyTo]) {
        const targetProp = targetDef.properties[keyTo];
        fkRequired = targetProp?.required !== undefined ? Boolean(targetProp.required) : true;
      } else if (targetDef) {
        const targetRelations = targetDef.relations ?? ({} as RelationDefinitionMap);
        for (const relMeta of Object.values(targetRelations)) {
          if (!relMeta) continue;
          const relType = (relMeta as AnyObject).type ?? (relMeta as AnyObject).relationType;
          if (relType !== 'belongsTo') continue;
          const relTargetCtor =
            typeof (relMeta as AnyObject).target === 'function'
              ? ((relMeta as AnyObject).target() as typeof Entity | undefined)
              : undefined;
          if (relTargetCtor !== modelCtor) continue;
          const keyFrom = (relMeta as AnyObject).keyFrom as string | undefined;
          if (!keyFrom) continue;
          const targetProp = targetDef.properties?.[keyFrom];
          fkRequired = targetProp?.required !== undefined ? Boolean(targetProp.required) : true;
          break;
        }
      }
      if (!fkRequired) continue;
      hasComposition = true;
      missing.push(name);
    }
    return { hasCompositionalRelation: hasComposition, missingDeepUpdate: missing };
  }

  private warnOnCompositionWithoutDeepUpdate(
    setName: string,
    modelCtor: typeof Entity,
    deepUpdateEnabled: boolean,
    compositionInfo: { hasCompositionalRelation: boolean; missingDeepUpdate: string[] },
  ): void {
    if (deepUpdateEnabled) return;
    if (!compositionInfo.hasCompositionalRelation) return;
    if (!compositionInfo.missingDeepUpdate.length) return;
    this.logger.warn('Entity set has required navigation relations but deepUpdate is disabled.', {
      entitySet: setName,
      model: modelCtor.name,
      relations: compositionInfo.missingDeepUpdate,
    });
  }

  private resolveDocumentVisibility(
    modelCtor: typeof Entity,
    modelMeta: ODataModelOptions | undefined,
  ): boolean {
    if (modelMeta?.documentInOpenApi !== undefined) {
      return Boolean(modelMeta.documentInOpenApi);
    }
    const globalDefault = this.config?.documentInOpenApiDefault ?? 'auto';
    if (globalDefault === 'auto') {
      const hasLoopbackModel = MetadataInspector.getClassMetadata(MODEL_KEY, modelCtor) != null;
      return hasLoopbackModel;
    }
    return Boolean(globalDefault);
  }

  private ensureModelDefinition(modelCtor: typeof Entity): ModelDefinition | undefined {
    let modelDefinition = (modelCtor as typeof Entity).definition as ModelDefinition | undefined;
    if (modelDefinition) return modelDefinition;

    buildModelDefinition(modelCtor as typeof Entity & { definition?: ModelDefinition | undefined });
    modelDefinition = (modelCtor as typeof Entity).definition as ModelDefinition | undefined;
    return modelDefinition;
  }

  private applyGeneratedRouteMetadata(
    spec: OperationObject,
    visibility: 'documented' | 'undocumented',
  ): OperationObject {
    return {
      ...spec,
      'x-odata-generated': true,
      'x-odata-visibility': (spec as AnyObject)['x-odata-visibility'] ?? visibility,
    };
  }

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

      const modelCtor = getODataControllerModel(ctor) as typeof Entity | undefined;
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
      const documentInOpenApi = this.resolveDocumentVisibility(modelCtor, modelMeta);

      if (!repoBinding) {
        throw new Error(
          `OData controller for model ${modelCtor.name} requires a DefaultCrudRepository instance. ` +
            `Ensure a repository for ${modelCtor.name} is registered via app.repository(${modelCtor.name}Repository) ` +
            `or mounted through a component before booting the OData component.`,
        );
      }

      const securityMetadata = collectControllerSecurityMetadata(ctor);
      const modelDefinition = this.ensureModelDefinition(modelCtor);
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

      const etagProperties = normalizeEtagProperties(modelMeta?.etag);
      const compositionRelations = this.identifyCompositionRelations(modelCtor, modelDefinition);
      let deepInsert = modelMeta?.deepInsert;
      if (deepInsert === undefined) {
        deepInsert = compositionRelations.hasCompositionalRelation
          ? true
          : Boolean(this.config?.enableDeepInsert);
      }
      let deepUpdate = modelMeta?.deepUpdate;
      if (deepUpdate === undefined) {
        deepUpdate = compositionRelations.hasCompositionalRelation
          ? true
          : Boolean(this.config?.enableDeepUpdate);
      }
      this.warnOnCompositionWithoutDeepUpdate(setName, modelCtor, deepUpdate, compositionRelations);
      const modelDeltaMeta = modelMeta?.delta;
      let deltaEnabled = modelDeltaMeta?.enabled;
      if (deltaEnabled === undefined && this.config?.enableDelta !== undefined) {
        deltaEnabled = this.config.enableDelta;
      }
      const deltaField = modelDeltaMeta?.field ?? etagProperties?.[0];
      if (deltaEnabled && !deltaField) {
        deltaEnabled = false;
        this.logger.warn('Delta change tracking requested but no field configured.', {
          entitySet: setName,
        });
      }
      const def = this.registry.register({
        name: setName,
        modelCtor,
        repositoryBindingKey: repoBinding.key,
        repositoryCtor: repoBinding.valueConstructor ?? undefined,
        etagProperties,
        securityMetadata,
        hooks: hooks as CrudHookBundle,
        sourceControllerBindingKey: binding.key,
        deepInsert: Boolean(deepInsert),
        deepUpdate: Boolean(deepUpdate),
        deltaEnabled,
        deltaField,
        documentInOpenApi,
      });

      await this.configureApplyPushdown(def, repoBinding, modelMeta, modelCtor);

      const CrudController = defineODataCrudController(def);
      def.controllerCtor = CrudController;
      this.app.controller(CrudController);
      this.registerOperations(def, ctor);
      this.registerNavigationRefRoutes(def, modelDefinition, CrudController);
    }
  }

  private async configureApplyPushdown(
    def: EntitySetDef,
    repoBinding: Readonly<Binding<unknown>>,
    modelMeta: ODataModelOptions | undefined,
    modelCtor: typeof Entity,
  ): Promise<void> {
    let preference = def.applyPushdown;
    if (preference === undefined && modelMeta?.applyPushdown !== undefined) {
      preference = modelMeta.applyPushdown;
    }
    if (preference === undefined && this.config?.enableApplyPushdown !== undefined) {
      preference = this.config.enableApplyPushdown;
    }

    if (!preference) {
      def.applyPushdown = false;
      def.applyExecutorId = undefined;
      return;
    }

    let repositoryInstance: unknown;
    let dataSource: juggler.DataSource | undefined;
    try {
      repositoryInstance = await this.app.get(repoBinding.key);
    } catch {
      def.applyPushdown = false;
      def.applyExecutorId = undefined;
      return;
    }

    dataSource = (repositoryInstance as { dataSource?: juggler.DataSource }).dataSource;
    if (!dataSource) {
      def.applyPushdown = false;
      def.applyExecutorId = undefined;
      return;
    }

    if (def.applyExecutorId) {
      const existingExecutor = this.executorRegistry.get(def.applyExecutorId);
      if (existingExecutor) {
        const supported = existingExecutor.supports
          ? await existingExecutor.supports(dataSource)
          : true;
        if (supported) {
          def.applyPushdown = true;
          if (existingExecutor.capabilities?.navigation) {
            def.applySupportsNavigation = true;
          }
          const inferred = inferSqlMetadata(modelCtor, dataSource);
          if (inferred) {
            def.sqlMetadata = inferred;
          }
          return;
        }
      }
    }

    const autoExecutor = await this.executorRegistry.findForDataSource(dataSource);
    if (autoExecutor) {
      def.applyPushdown = true;
      def.applyExecutorId = autoExecutor.id;
      const inferred = inferSqlMetadata(modelCtor, dataSource);
      if (inferred) {
        def.sqlMetadata = inferred;
      }
      if (autoExecutor.capabilities?.navigation) {
        def.applySupportsNavigation = true;
      }
      return;
    }

    def.applyPushdown = false;
    def.applyExecutorId = undefined;
    if (preference) {
      const datasourceName = (dataSource as AnyObject)?.name ?? '[unknown]';
      this.logger.warn('Apply pushdown requested but no compatible executor found; falling back.', {
        entitySet: def.name,
        datasource: datasourceName,
      });
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
    const visibility = def.documentInOpenApi === false ? 'undocumented' : 'documented';

    for (const action of actions) {
      app.route(this.buildOperationRoute(action, controllerCtor, basePath, 'post', visibility));
    }

    for (const fn of functions) {
      app.route(this.buildOperationRoute(fn, controllerCtor, basePath, 'get', visibility));
    }
  }

  private registerNavigationRefRoutes(
    def: EntitySetDef,
    modelDefinition: ModelDefinition | undefined,
    controllerCtor: Function,
  ) {
    if (this.config?.enableNavigationRefEndpoints === false) return;
    const relations = (modelDefinition?.relations ?? {}) as Record<string, any>;
    if (!relations || !Object.keys(relations).length) return;

    const basePath = `/odata/${def.name}`;
    const bindingKey = `controllers.${controllerCtor.name}`;
    const app = this.app as RestApplication;
    const visibility = def.documentInOpenApi === false ? 'undocumented' : 'documented';

    for (const [relationName, relationMeta] of Object.entries(relations)) {
      const relationType = relationMeta?.type ?? relationMeta?.relationType;
      if (relationType !== 'hasMany' && relationType !== 'hasOne') continue;
      if (relationMeta?.through) continue;
      if (!ensureNavigationTargetKey(relationMeta as AnyObject)) continue;

      const linkVerb = relationMeta.targetsMany ? 'post' : 'put';
      const linkPath = `${basePath}/{id}/${relationName}/$ref`;
      const linkSpec: OperationObject = this.applyGeneratedRouteMetadata(
        {
          responses: {
            '204': { description: 'Reference successfully set.' },
          },
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['@odata.id'],
                  properties: {
                    '@odata.id': { type: 'string' },
                  },
                },
              },
            },
          },
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
        },
        visibility,
      );

      const linkHandler: OperationHandler = async (ctx: RequestContext, ...params: unknown[]) => {
        const body = params[0] as Record<string, unknown> | undefined;
        const id = params[1];
        const controller = (await ctx.get(bindingKey as any)) as AnyObject;
        await controller.linkNavigationRef(
          relationName,
          id,
          body?.['@odata.id'] as string | undefined,
        );
        if (!ctx.response.headersSent) ctx.response.status(204).end();
      };

      app.route(new ODataRefRoute(linkVerb, linkPath, linkSpec, linkHandler));

      const deletePath = relationMeta.targetsMany
        ? `${basePath}/{id}/${relationName}/{targetKey}/$ref`
        : `${basePath}/{id}/${relationName}/$ref`;
      const deleteSpec: OperationObject = this.applyGeneratedRouteMetadata(
        {
          responses: {
            '204': { description: 'Reference removed.' },
          },
          parameters: relationMeta.targetsMany
            ? [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                { name: 'targetKey', in: 'path', required: true, schema: { type: 'string' } },
              ]
            : [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
        visibility,
      );

      const deleteHandler: OperationHandler = async (ctx: RequestContext, ...params: unknown[]) => {
        const id = params[0];
        const targetKeyParam = relationMeta.targetsMany
          ? (params[1] as string | undefined)
          : undefined;
        const controller = (await ctx.get(bindingKey as any)) as AnyObject;
        await controller.unlinkNavigationRef(
          relationName,
          id,
          relationMeta.targetsMany ? targetKeyParam : undefined,
        );
        if (!ctx.response.headersSent) ctx.response.status(204).end();
      };

      app.route(new ODataRefRoute('delete', deletePath, deleteSpec, deleteHandler));
    }
  }

  private buildOperationRoute(
    op: OperationMeta,
    controllerCtor: Function,
    basePath: string,
    verb: 'get' | 'post',
    visibility: 'documented' | 'undocumented',
  ): RouteEntry {
    let path = basePath;
    if (op.binding === 'entity') path += '/{id}';
    path += `/${op.name}`;

    let spec: OperationObject = {
      parameters:
        op.binding === 'entity'
          ? [{ name: 'id', in: 'path' as const, required: true, schema: { type: 'string' } }]
          : undefined,
      requestBody:
        verb === 'post'
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
    spec = this.applyGeneratedRouteMetadata(spec, visibility);

    const setSegment = op.binding === 'unbound' ? undefined : (basePath.split('/').pop() ?? '');
    const bindingKey = `controllers.${controllerCtor.name}`;
    const routePath = op.binding === 'unbound' ? `/odata/${op.name}` : path;

    return new ODataOperationRoute(
      verb,
      routePath,
      spec,
      async (ctx: RequestContext, ...params: unknown[]) => {
        const controller = (await ctx.get(bindingKey as any)) as any;
        const args: unknown[] = [];
        if (op.binding === 'entity') {
          const routeParams = ctx.request.params as Record<string, unknown> | undefined;
          let id = routeParams?.id;

          if (id == null && params.length) {
            const candidate = params[0];
            if (
              typeof candidate === 'string' ||
              typeof candidate === 'number' ||
              typeof candidate === 'boolean'
            ) {
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
        if (!ctx.response.headersSent && !ctx.response.getHeader('OData-Version')) {
          ctx.response.set('OData-Version', ODATA_VERSION);
        }
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

class ODataRefRoute extends Route {
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

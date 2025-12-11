import {
  Application,
  Binding,
  BindingScope,
  Context,
  CoreBindings,
  MetadataInspector,
  inject,
  injectable,
  invokeMethod,
  describeInjectedArguments,
  describeInjectedProperties,
  ResolutionContext,
} from '@loopback/core';
import { Booter } from '@loopback/boot';
import {
  ControllerClass,
  RestApplication,
  RequestContext,
  OperationObject,
  RouteEntry,
  RouteSource,
  HttpErrors,
  ControllerRoute,
} from '@loopback/rest';
import { EntitySetDef, EntitySetRegistry } from '../registry/entityset-registry';
import { getODataControllerModel } from '../decorators/controller.decorator';
import { defineODataCrudController } from '../controllers/crud-controller-factory';
import { getODataModelMeta, ODataModelOptions } from '../decorators/model.decorator';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import {
  AnyObject,
  DefaultCrudRepository,
  Entity,
  ModelDefinition,
  MODEL_KEY,
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
import { ensureModelDefinitionWithRelations } from '../util/model-definition';
import { ensureNavigationTargetKey } from '../util/relation-metadata';
import { ODataApplyExecutorRegistry } from '../services/odata-apply-executor.registry';
import { inferSqlMetadata } from '../util/sql-metadata';
import { ODATA_VERSION } from '../constants';
import { probeDataSourceTransactionalCapability } from '../util/datasource-transactions';
import { normalizeBasePath } from '../util/base-path';
import {
  PropertyBackedMediaHandler,
  RepositoryMediaAdapterTarget,
  RepositoryMediaHandlerAdapter,
} from '../services/odata-media-handler';

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

  private readonly missingParamsWarnings = new Set<string>();
  private metadataPath?: string;
  private operationNamespace?: string;

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
      const modelDefinition = ensureModelDefinitionWithRelations(modelCtor);
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
      const hasStream = Boolean(modelMeta?.hasStream);
      const mediaField = modelMeta?.mediaField;
      const mediaContentTypeField = modelMeta?.mediaContentTypeField;
      const mediaEtagField = modelMeta?.mediaEtagField;
      const mediaLengthField = modelMeta?.mediaLengthField;
      const mediaHandlerBindingKey = hasStream
        ? (modelMeta?.mediaHandlerBindingKey ?? this.buildMediaHandlerBindingKey(setName))
        : undefined;
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
        hasStream,
        mediaField,
        mediaContentTypeField,
        mediaEtagField,
        mediaLengthField,
        mediaHandlerBindingKey: mediaHandlerBindingKey ?? undefined,
      });

      await this.detectTransactionalCapability(def, repoBinding);
      await this.configureApplyPushdown(def, repoBinding, modelMeta, modelCtor);
      if (hasStream) {
        await this.configureMediaHandler(def, repoBinding);
      }

      const CrudController = defineODataCrudController(def);
      def.controllerCtor = CrudController;
      this.app.controller(CrudController);
      this.registerOperations(def, ctor);
      this.registerNavigationRefRoutes(def, modelDefinition, CrudController);
    }
  }

  private async detectTransactionalCapability(
    def: EntitySetDef,
    repoBinding: Readonly<Binding<unknown>>,
  ): Promise<void> {
    if (def.supportsTransactions !== undefined) return;
    const dataSourceBindingKey = this.resolveRepositoryDataSourceBindingKey(repoBinding);
    if (!dataSourceBindingKey) return;
    if (!this.app.isBound(dataSourceBindingKey)) return;
    try {
      const dataSource = (await this.app.get(dataSourceBindingKey)) as juggler.DataSource;
      if (!dataSource) return;
      const { capability, error } = await probeDataSourceTransactionalCapability(dataSource);
      if (capability === 'supported') {
        def.supportsTransactions = true;
        def.transactionCapabilityLocked = true;
        return;
      }
      if (capability === 'unsupported') {
        def.supportsTransactions = false;
        def.transactionCapabilityLocked = false;
        return;
      }
      def.supportsTransactions = undefined;
      def.transactionCapabilityLocked = false;
      if (error) {
        this.logger.warn('Failed to verify repository datasource transactions during boot.', {
          entitySet: def.name,
          dataSource: dataSource.name ?? dataSourceBindingKey,
          error: (error as Error)?.message ?? error,
        });
      }
    } catch (error) {
      this.logger.warn('Error while probing repository datasource transactions during boot.', {
        entitySet: def.name,
        dataSourceBindingKey,
        error: (error as Error)?.message ?? error,
      });
      // Leave undefined; runtime batch execution will detect and cache the result.
    }
  }

  private resolveRepositoryDataSourceBindingKey(
    repoBinding: Readonly<Binding<unknown>>,
  ): string | undefined {
    const repoCtor = repoBinding.valueConstructor as
      | (new (...args: unknown[]) => unknown)
      | undefined;
    if (!repoCtor) return undefined;
    const ctorSelector = this.findDatasourceSelector(describeInjectedArguments(repoCtor, ''));
    if (ctorSelector) return ctorSelector;
    const propertyInjections = describeInjectedProperties(repoCtor.prototype ?? {});
    const propertySelector = this.findDatasourceSelector(
      propertyInjections ? Object.values(propertyInjections) : undefined,
    );
    if (propertySelector) return propertySelector;
    const staticName = (repoCtor as { dataSourceName?: string }).dataSourceName;
    if (typeof staticName === 'string' && staticName.length) {
      return staticName.startsWith('datasources.') ? staticName : `datasources.${staticName}`;
    }
    return undefined;
  }

  private findDatasourceSelector(
    injections: ReadonlyArray<{ bindingSelector?: unknown }> | undefined,
  ): string | undefined {
    if (!injections) return undefined;
    for (const injection of injections) {
      const selector = injection?.bindingSelector;
      if (typeof selector === 'string' && selector.startsWith('datasources.')) {
        return selector;
      }
    }
    return undefined;
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

  private buildMediaHandlerBindingKey(entitySetName: string): string {
    const trimmed = entitySetName.replace(/\s+/g, '');
    return `${ODATA_BINDINGS.MEDIA_HANDLERS.key}.${trimmed}`;
  }

  private repositoryExposesMediaMethods(proto: AnyObject | undefined): boolean {
    if (!proto) return false;
    const hasGetter = typeof (proto as AnyObject).getMedia === 'function';
    const hasSetter = typeof (proto as AnyObject).setMedia === 'function';
    return hasGetter && hasSetter;
  }

  private async configureMediaHandler(
    def: EntitySetDef,
    repoBinding: Readonly<Binding<unknown>>,
  ): Promise<void> {
    if (!def.hasStream) return;
    if (!def.mediaHandlerBindingKey) {
      def.mediaHandlerBindingKey = this.buildMediaHandlerBindingKey(def.name);
    }
    const bindingKey = def.mediaHandlerBindingKey;
    if (!bindingKey) return;
    if (this.app.isBound(bindingKey)) return;

    const repoCtor = repoBinding.valueConstructor as
      | (new (...args: unknown[]) => unknown)
      | undefined;
    if (repoCtor && this.repositoryExposesMediaMethods(repoCtor.prototype as AnyObject)) {
      this.app
        .bind(bindingKey)
        .toDynamicValue(async (resolutionCtx: ResolutionContext) => {
          const repo = (await this.resolveMediaRepository(
            repoBinding.key,
            resolutionCtx,
          )) as DefaultCrudRepository<Entity & AnyObject, unknown> & RepositoryMediaAdapterTarget;
          return new RepositoryMediaHandlerAdapter(repo);
        })
        .inScope(BindingScope.REQUEST);
      return;
    }

    if (def.mediaField) {
      this.app
        .bind(bindingKey)
        .toDynamicValue(async (resolutionCtx: ResolutionContext) => {
          const repo = (await this.resolveMediaRepository(
            repoBinding.key,
            resolutionCtx,
          )) as DefaultCrudRepository<Entity & AnyObject, unknown>;
          return new PropertyBackedMediaHandler(repo, def.mediaField!);
        })
        .inScope(BindingScope.REQUEST);
      return;
    }

    this.logger.warn('hasStream entity set registered without a media handler.', {
      entitySet: def.name,
    });
  }

  private async resolveMediaRepository(
    bindingKey: string,
    resolutionCtx?: ResolutionContext,
  ): Promise<DefaultCrudRepository<Entity & AnyObject, unknown>> {
    const context = this.resolveMediaHandlerContext(resolutionCtx);
    return (await context.get(bindingKey)) as DefaultCrudRepository<Entity & AnyObject, unknown>;
  }

  private resolveMediaHandlerContext(resolutionCtx?: ResolutionContext): Context {
    const requestContext = (resolutionCtx as { context?: Context } | undefined)?.context;
    return requestContext ?? this.app;
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

    this.warnMissingOperationParameters(controllerCtor, actions, 'Action');
    this.warnMissingOperationParameters(controllerCtor, functions, 'Function');

    const app = this.app as RestApplication;
    const basePath = `/odata/${def.name}`;
    def.actions = actions;
    def.functions = functions;
    const visibility = def.documentInOpenApi === false ? 'undocumented' : 'documented';

    for (const action of actions) {
      app.route(
        this.buildOperationRoute(action, controllerCtor, basePath, 'post', visibility, def.name),
      );
    }

    for (const fn of functions) {
      app.route(
        this.buildOperationRoute(fn, controllerCtor, basePath, 'get', visibility, def.name),
      );
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

      app.route(
        new ODataNavigationRefRoute(
          linkVerb,
          linkPath,
          linkSpec,
          controllerCtor,
          bindingKey,
          'link',
          relationName,
          Boolean(relationMeta.targetsMany),
        ),
      );

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

      app.route(
        new ODataNavigationRefRoute(
          'delete',
          deletePath,
          deleteSpec,
          controllerCtor,
          bindingKey,
          'unlink',
          relationName,
          Boolean(relationMeta.targetsMany),
        ),
      );
    }
  }

  private buildOperationRoute(
    op: OperationMeta,
    controllerCtor: Function,
    basePath: string,
    verb: 'get' | 'post',
    visibility: 'documented' | 'undocumented',
    entitySetName?: string,
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

    const controllerName =
      (controllerCtor?.name?.trim()?.length ?? 0) ? controllerCtor.name : 'Controller';
    const bindingKey = `controllers.${controllerCtor.name}`;
    const routePath = op.binding === 'unbound' ? `/odata/${op.name}` : path;
    const decoratedSpec: OperationObject = {
      ...spec,
      'x-controller-name': spec['x-controller-name'] ?? controllerName,
      'x-operation-name': spec['x-operation-name'] ?? op.methodName,
      tags: spec.tags ?? [controllerName],
    };

    const setSegment =
      op.binding === 'unbound' ? undefined : (entitySetName ?? basePath.split('/').pop() ?? '');
    const metadataPath = this.resolveMetadataPath();
    const namespace = this.resolveOperationNamespace();
    const qualifiedName = `${namespace}.${op.name}`;

    return new ODataOperationRoute(verb, routePath, decoratedSpec, controllerCtor, bindingKey, op, {
      setSegment,
      metadataPath,
      qualifiedName,
    });
  }

  private resolveMetadataPath(): string {
    if (this.metadataPath) return this.metadataPath;
    const serviceRoot = normalizeBasePath(this.config?.basePath);
    this.metadataPath = serviceRoot === '/' ? '/$metadata' : `${serviceRoot}/$metadata`;
    return this.metadataPath;
  }

  private resolveOperationNamespace(): string {
    if (this.operationNamespace) return this.operationNamespace;
    this.operationNamespace = this.config?.namespace ?? this.config?.namespaceAlias ?? 'Default';
    return this.operationNamespace;
  }

  private warnMissingOperationParameters(
    controllerCtor: Function,
    operations: OperationMeta[],
    kind: 'Action' | 'Function',
  ): void {
    const controllerName = controllerCtor?.name?.trim()?.length
      ? controllerCtor.name
      : 'Controller';
    for (const op of operations) {
      if (op.parameters !== undefined) continue;
      const cacheKey = `${controllerName}:${op.methodName}`;
      if (this.missingParamsWarnings.has(cacheKey)) continue;
      this.missingParamsWarnings.add(cacheKey);
      this.logger.warn(
        `No parameter metadata defined for OData ${kind.toLowerCase()} "${op.name}" on ${controllerName}. Add the "params" option to @odata${kind} to describe its payload.`,
        {
          controller: controllerName,
          method: op.methodName,
          operation: op.name,
          binding: op.binding,
          kind,
        },
      );
    }
  }
}

class ODataOperationRoute extends ControllerRoute<object> {
  private readonly operation: OperationMeta;
  private readonly setSegment?: string;
  private readonly httpVerb: 'get' | 'post';
  private readonly controllerBindingKey: string;
  private readonly metadataPath: string;
  private readonly qualifiedName: string;

  constructor(
    verb: 'get' | 'post',
    path: string,
    spec: OperationObject,
    controllerCtor: Function,
    controllerBindingKey: string,
    operation: OperationMeta,
    options: { setSegment?: string; metadataPath: string; qualifiedName: string },
  ) {
    super(
      verb,
      path,
      spec,
      controllerCtor as ControllerClass<object>,
      async (ctx) => ctx.get(controllerBindingKey as any),
      operation.methodName,
    );
    this.operation = operation;
    this.setSegment = options.setSegment;
    this.httpVerb = verb;
    this.controllerBindingKey = controllerBindingKey;
    this.metadataPath = options.metadataPath;
    this.qualifiedName = options.qualifiedName;
  }

  async invokeHandler(requestContext: RequestContext, args: unknown[]): Promise<unknown> {
    let controller: any;
    try {
      controller = await requestContext.get(CoreBindings.CONTROLLER_CURRENT);
    } catch (error) {
      if ((error as any)?.code !== 'KEY_NOT_FOUND') throw error;
      controller = await requestContext.get(this.controllerBindingKey as any);
    }

    const invocationArgs: unknown[] = [];
    if (this.operation.binding === 'entity') {
      const routeParams = requestContext.request.params as Record<string, unknown> | undefined;
      let id = routeParams?.id;

      if (id == null && args.length) {
        const candidate = args[0];
        if (
          typeof candidate === 'string' ||
          typeof candidate === 'number' ||
          typeof candidate === 'boolean'
        ) {
          id = candidate;
        }
      }
      if (id == null) {
        const segments = requestContext.request.path.split('/').filter(Boolean);
        id = segments.length >= 4 ? segments[segments.length - 2] : undefined;
      }
      if (id == null) {
        throw new HttpErrors.BadRequest(`Missing entity key for ${this.operation.name}.`);
      }
      invocationArgs.push(id);
    }

    if (this.httpVerb === 'post') {
      invocationArgs.push(requestContext.request.body);
    } else {
      invocationArgs.push(requestContext.request.query);
    }

    const result = await invokeMethod(
      controller,
      this.operation.methodName,
      requestContext,
      invocationArgs,
      {
        source: new RouteSource(this),
      },
    );
    if (
      !requestContext.response.headersSent &&
      !requestContext.response.getHeader('OData-Version')
    ) {
      requestContext.response.set('OData-Version', ODATA_VERSION);
    }
    if (this.operation.rawResponse) return result;

    let fragment: string | undefined;
    if (this.operation.binding === 'unbound') {
      fragment = this.qualifiedName;
    } else if (this.setSegment) {
      fragment = `${this.setSegment}/${this.qualifiedName}`;
    }
    const context = fragment ? `${this.metadataPath}#${fragment}` : this.metadataPath;

    return {
      '@odata.context': context,
      value: result,
    };
  }
}

class ODataNavigationRefRoute extends ControllerRoute<object> {
  private readonly controllerBindingKey: string;
  private readonly relationName: string;
  private readonly operation: 'link' | 'unlink';
  private readonly targetsMany: boolean;

  constructor(
    verb: 'post' | 'put' | 'delete',
    path: string,
    spec: OperationObject,
    controllerCtor: Function,
    controllerBindingKey: string,
    operation: 'link' | 'unlink',
    relationName: string,
    targetsMany: boolean,
  ) {
    super(
      verb,
      path,
      spec,
      controllerCtor as ControllerClass<object>,
      async (ctx) => ctx.get(controllerBindingKey as any),
      operation === 'link' ? 'linkNavigationRef' : 'unlinkNavigationRef',
    );
    this.controllerBindingKey = controllerBindingKey;
    this.relationName = relationName;
    this.operation = operation;
    this.targetsMany = targetsMany;
  }

  async invokeHandler(requestContext: RequestContext, args: unknown[]): Promise<unknown> {
    let controller: AnyObject;
    try {
      controller = (await requestContext.get(CoreBindings.CONTROLLER_CURRENT)) as AnyObject;
    } catch (error) {
      if ((error as AnyObject)?.code !== 'KEY_NOT_FOUND') throw error;
      controller = (await requestContext.get(this.controllerBindingKey as any)) as AnyObject;
    }

    const methodName = this.operation === 'link' ? 'linkNavigationRef' : 'unlinkNavigationRef';
    const invocationArgs: unknown[] = [
      this.relationName,
      this.resolveParentId(requestContext, args),
    ];

    if (this.operation === 'link') {
      invocationArgs.push(this.extractTargetUri(requestContext));
    } else {
      invocationArgs.push(this.targetsMany ? this.extractTargetKey(requestContext) : undefined);
    }

    const result = await invokeMethod(controller, methodName, requestContext, invocationArgs, {
      source: new RouteSource(this),
    });

    if (!requestContext.response.headersSent) {
      if (!requestContext.response.getHeader('OData-Version')) {
        requestContext.response.set('OData-Version', ODATA_VERSION);
      }
      requestContext.response.status(204).end();
    }

    return result;
  }

  private resolveParentId(requestContext: RequestContext, args: unknown[]): unknown {
    const params = requestContext.request.params as Record<string, unknown> | undefined;
    if (params?.id != null) return params.id;

    for (const arg of args) {
      if (arg == null) continue;
      const type = typeof arg;
      if (type === 'string' || type === 'number' || type === 'boolean') {
        return arg;
      }
    }

    const segments = requestContext.request.path.split('/').filter(Boolean);
    const relationIndex = segments.lastIndexOf(this.relationName);
    if (relationIndex > 0) {
      return segments[relationIndex - 1];
    }

    throw new HttpErrors.BadRequest('Missing entity key for navigation reference.');
  }

  private extractTargetUri(requestContext: RequestContext): string | undefined {
    const body = requestContext.request.body;
    if (body && typeof body === 'object') {
      const value = (body as Record<string, unknown>)['@odata.id'];
      if (value == null || typeof value === 'string') {
        return value as string | undefined;
      }
    }
    return undefined;
  }

  private extractTargetKey(requestContext: RequestContext): string | undefined {
    const params = requestContext.request.params as Record<string, unknown> | undefined;
    const paramValue = params?.targetKey;
    if (paramValue == null || typeof paramValue === 'string') {
      if (paramValue !== undefined) return paramValue as string | undefined;
    }

    const segments = requestContext.request.path.split('/').filter(Boolean);
    const relationIndex = segments.lastIndexOf(this.relationName);
    if (relationIndex >= 0 && relationIndex + 1 < segments.length) {
      const candidate = segments[relationIndex + 1];
      if (candidate && candidate !== '$ref') {
        return candidate;
      }
    }
    return undefined;
  }
}

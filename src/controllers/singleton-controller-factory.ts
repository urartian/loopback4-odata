import { inject } from '@loopback/core';
import {
  del,
  get,
  getModelSchemaRef,
  HttpErrors,
  OperationObject,
  param,
  patch,
  put,
  requestBody,
  Request,
  RequestContext,
  Response,
  RestBindings,
} from '@loopback/rest';
import { ODataErrorCodes } from '../odata-error-codes';
import { ODATA_BINDINGS, ODataLogger, ODataTenantThrottler } from '../keys';
import { EntitySetDef } from '../registry/entityset-registry';
import { ODataApplyExecutorRegistry } from '../services/odata-apply-executor.registry';
import { ODataConfig, ODataSingletonConfig } from '../types';
import {
  applyControllerSecurityMetadata,
  mergeMethodAliasMaps,
  MethodAliasMap,
} from '../util/security-metadata';
import { AnyObject } from '@loopback/repository';

type ODataVisibility = 'documented' | 'undocumented';

function withODataSpecMetadata<T extends OperationObject>(spec: T, visibility: ODataVisibility): T {
  return {
    ...spec,
    'x-odata-generated': true,
    'x-odata-visibility': (spec as Record<string, unknown>)['x-odata-visibility'] ?? visibility,
  };
}

function collectControllerMethodNames(controllerCtor: Function): Set<string> {
  const prototype = controllerCtor.prototype ?? {};
  const methods = new Set<string>();

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value === 'function') {
      methods.add(name);
    }
  }

  return methods;
}

function deriveDefaultMethodAliases(
  controllerMethods: Set<string>,
  metadata: EntitySetDef['securityMetadata'] | undefined,
): MethodAliasMap | undefined {
  const methodMetadata = metadata?.methodMetadata;
  if (!methodMetadata) return undefined;

  const derived = new Map<string, Map<string, number>>();
  const addAlias = (source: string, target: string, priority = 10) => {
    if (!controllerMethods.has(target)) return;
    let map = derived.get(source);
    if (!map) {
      map = new Map();
      derived.set(source, map);
    }
    const existing = map.get(target);
    if (existing === undefined || priority < existing) {
      map.set(target, priority);
    }
  };

  const writeAliasSources = new Set([
    'update',
    'updateById',
    'replace',
    'replaceById',
    'patch',
    'patchById',
    'bulkUpdate',
  ]);
  const deleteAliasSources = new Set(['delete', 'deleteById', 'destroyById']);
  const hasExplicitDeleteMetadata = Object.keys(methodMetadata).some((name) =>
    deleteAliasSources.has(name),
  );

  for (const methodName of Object.keys(methodMetadata)) {
    if (methodName === 'find' && controllerMethods.has('findById')) {
      addAlias(methodName, 'findById');
    }

    if (methodName.endsWith('ById')) {
      const base = methodName.substring(0, methodName.length - 'ById'.length);
      if (base && controllerMethods.has(base)) {
        addAlias(methodName, base);
      } else if (base === 'replace' && controllerMethods.has('update')) {
        addAlias(methodName, 'update');
      }
    }

    if (writeAliasSources.has(methodName)) {
      addAlias(methodName, 'linkNavigationRef');
      if (!hasExplicitDeleteMetadata) {
        addAlias(methodName, 'unlinkNavigationRef', 20);
      }
    }

    if (deleteAliasSources.has(methodName)) {
      addAlias(methodName, 'unlinkNavigationRef', 5);
    }
  }

  if (!derived.size) return undefined;

  const result: MethodAliasMap = {};
  for (const [source, aliases] of derived.entries()) {
    const sorted = Array.from(aliases.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name)
      .filter((value, index, array) => array.indexOf(value) === index);
    result[source] = sorted.length === 1 ? sorted[0] : sorted;
  }
  return result;
}

export function defineODataSingletonController(
  def: EntitySetDef,
  CrudControllerCtor: new (...args: any[]) => any,
  singleton: ODataSingletonConfig,
): new (...args: any[]) => object {
  const repoBindingKey = def.repositoryBindingKey;
  if (!repoBindingKey) {
    throw new HttpErrors.InternalServerError(
      `Entity set ${def.name} does not have an associated repository binding.`,
    );
  }

  const singletonName = singleton.name;
  const operationVisibility: ODataVisibility =
    def.documentInOpenApi === false ? 'undocumented' : 'documented';
  const contextBase = `/odata/$metadata#${singletonName}`;

  const entityResponseSchema = {
    allOf: [
      {
        type: 'object',
        required: ['@odata.context'],
        properties: {
          '@odata.context': { type: 'string' },
          '@odata.etag': { type: 'string' },
        },
      },
      getModelSchemaRef(def.modelCtor, { includeRelations: true }),
    ],
  };

  const patchSchema = getModelSchemaRef(def.modelCtor, { partial: true });
  const replaceSchema = getModelSchemaRef(def.modelCtor, { partial: false });

  class ODataSingletonController {
    private readonly inner: any;

    constructor(
      @inject(repoBindingKey as string)
      repository: unknown,
      @inject(RestBindings.Http.REQUEST)
      public readonly request: Request,
      @inject(RestBindings.Http.RESPONSE)
      public readonly response: Response,
      @inject(RestBindings.Http.CONTEXT)
      public readonly httpCtx: RequestContext,
      @inject(ODATA_BINDINGS.CONFIG)
      public readonly cfg: ODataConfig,
      @inject(ODATA_BINDINGS.APPLY_EXECUTOR_REGISTRY)
      public readonly applyExecutors: ODataApplyExecutorRegistry,
      @inject(ODATA_BINDINGS.LOGGER)
      public readonly logger: ODataLogger,
      @inject(ODATA_BINDINGS.THROTTLER)
      public readonly throttler: ODataTenantThrottler,
    ) {
      this.inner = new CrudControllerCtor(
        repository,
        request,
        response,
        httpCtx,
        cfg,
        applyExecutors,
        logger,
        throttler,
      );
    }

    private async resolveSingletonId(): Promise<unknown> {
      if (typeof singleton.resolveId === 'function') {
        const id = await singleton.resolveId({
          request: this.request,
          response: this.response,
          httpCtx: this.httpCtx,
        });
        if (id === null || id === undefined) {
          const err = new HttpErrors.NotFound('Singleton entity not found.');
          (err as any).code = ODataErrorCodes.NotFound;
          throw err;
        }
        return id;
      }

      if (Object.prototype.hasOwnProperty.call(singleton, 'id')) {
        const id = (singleton as any).id;
        if (id === null || id === undefined) {
          const err = new HttpErrors.NotFound('Singleton entity not found.');
          (err as any).code = ODataErrorCodes.NotFound;
          throw err;
        }
        return id;
      }

      const err = new HttpErrors.InternalServerError('Singleton key resolver is not configured.');
      (err as any).code = ODataErrorCodes.InternalServerError;
      throw err;
    }

    private rewriteSingletonContext(result: unknown, propertyName?: string): AnyObject | undefined {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result as any;
      const obj = result as AnyObject;
      if (typeof obj['@odata.context'] !== 'string') return obj;

      if (!propertyName) {
        obj['@odata.context'] = contextBase;
        return obj;
      }

      const isEntityResponse =
        !Object.prototype.hasOwnProperty.call(obj, 'value') &&
        Object.keys(obj).some((key) => key !== '@odata.context' && !key.startsWith('@odata.'));
      obj['@odata.context'] = isEntityResponse
        ? `${contextBase}/${propertyName}/$entity`
        : `${contextBase}/${propertyName}`;
      return obj;
    }

    @get(
      `/odata/${singletonName}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `${singletonName} singleton entity`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
            '304': { description: 'Not Modified' },
          },
        },
        operationVisibility,
      ),
    )
    async findById() {
      const id = await this.resolveSingletonId();
      const result = await this.inner.findById(id, undefined);
      return this.rewriteSingletonContext(result);
    }

    @patch(
      `/odata/${singletonName}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `Update ${singletonName} singleton entity`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
            '204': { description: 'Updated (minimal response).' },
          },
        },
        operationVisibility,
      ),
    )
    async update(
      @requestBody({
        content: {
          'application/json': {
            schema: patchSchema,
          },
        },
      })
      payload: Record<string, unknown>,
    ) {
      const id = await this.resolveSingletonId();
      const result = await this.inner.update(id, payload);
      return this.rewriteSingletonContext(result);
    }

    @put(
      `/odata/${singletonName}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `Replace ${singletonName} singleton entity`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
            '204': { description: 'Replaced (minimal response).' },
          },
        },
        operationVisibility,
      ),
    )
    async replace(
      @requestBody({
        content: {
          'application/json': {
            schema: replaceSchema,
          },
        },
      })
      payload: Record<string, unknown>,
    ) {
      const id = await this.resolveSingletonId();
      const result = await this.inner.replace(id, payload);
      return this.rewriteSingletonContext(result);
    }

    @del(
      `/odata/${singletonName}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `Delete ${singletonName} singleton entity (representation)`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
            '204': { description: 'Deleted.' },
          },
        },
        operationVisibility,
      ),
    )
    async delete() {
      if (!singleton.nullable) {
        throw new HttpErrors.MethodNotAllowed('Singleton is not nullable.');
      }
      const id = await this.resolveSingletonId();
      const result = await this.inner.delete(id);
      return this.rewriteSingletonContext(result);
    }

    @get(
      `/odata/${singletonName}/$value`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `${singletonName} media stream`,
              content: {
                'application/octet-stream': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
            '204': { description: 'Stream is empty.' },
            '304': { description: 'Not Modified' },
          },
        },
        operationVisibility,
      ),
    )
    async getMediaValue() {
      const id = await this.resolveSingletonId();
      return this.inner.getMediaValue(id);
    }

    @put(
      `/odata/${singletonName}/$value`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `${singletonName} media updated (representation)`,
              content: { 'application/json': { schema: entityResponseSchema } },
            },
            '204': { description: `${singletonName} media updated.` },
          },
        },
        operationVisibility,
      ),
    )
    async replaceMediaValue(
      @requestBody({
        required: true,
        content: {
          'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          'text/plain': { schema: { type: 'string', format: 'binary' } },
          '*/*': { schema: { type: 'string', format: 'binary' } },
        },
      })
      body: any,
    ) {
      const id = await this.resolveSingletonId();
      return this.inner.replaceMediaValue(id, body);
    }

    @del(
      `/odata/${singletonName}/$value`,
      withODataSpecMetadata(
        {
          responses: {
            '204': { description: `${singletonName} media deleted.` },
          },
        },
        operationVisibility,
      ),
    )
    async deleteMediaValue() {
      const id = await this.resolveSingletonId();
      return this.inner.deleteMediaValue(id);
    }

    @get(
      `/odata/${singletonName}/{property}/$value`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `Raw property value for ${singletonName}`,
              content: {
                'text/plain': { schema: { type: 'string' } },
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
            '204': { description: 'Property is null.' },
            '304': { description: 'Not Modified' },
          },
          parameters: [
            { name: 'property', in: 'path', required: true, schema: { type: 'string' } },
          ],
        },
        operationVisibility,
      ),
    )
    async getPropertyValue(@param.path.string('property') property: string) {
      const id = await this.resolveSingletonId();
      return this.inner.getPropertyValue(id, property);
    }

    @get(
      `/odata/${singletonName}/{property}`,
      withODataSpecMetadata(
        {
          responses: {
            '200': {
              description: `Property or navigation value for ${singletonName}`,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                  },
                },
              },
            },
            '204': { description: 'Value is null.' },
          },
          parameters: [
            { name: 'property', in: 'path', required: true, schema: { type: 'string' } },
          ],
        },
        operationVisibility,
      ),
    )
    async getProperty(@param.path.string('property') property: string) {
      const id = await this.resolveSingletonId();
      const result = await this.inner.getEntityProperty(id, property);
      return this.rewriteSingletonContext(result, property);
    }

    // NOTE: singleton $ref routes are registered via custom ControllerRoute instances
    // to preserve correct verbs for hasOne/hasMany and reuse generated security metadata.
    async linkNavigationRef() {
      throw new HttpErrors.NotImplemented();
    }

    async unlinkNavigationRef() {
      throw new HttpErrors.NotImplemented();
    }
  }

  const controllerMethodSet = collectControllerMethodNames(ODataSingletonController);
  const derivedMethodAliases = deriveDefaultMethodAliases(
    controllerMethodSet,
    def.securityMetadata,
  );
  const methodNameRemap = mergeMethodAliasMaps(derivedMethodAliases, def.securityMethodAliases);
  applyControllerSecurityMetadata(
    ODataSingletonController,
    def.securityMetadata,
    Array.from(controllerMethodSet),
    methodNameRemap,
  );

  Object.defineProperty(ODataSingletonController, 'name', {
    value: `${singletonName}ODataSingletonController`,
  });

  return ODataSingletonController;
}

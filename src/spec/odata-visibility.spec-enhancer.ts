import { BindingScope, inject, injectable } from '@loopback/core';
import { asSpecEnhancer, OASEnhancer, OpenApiSpec } from '@loopback/openapi-v3';
import { ODataConfig } from '../types';
import { ODATA_BINDINGS } from '../keys';

const HTTP_METHODS: Array<
  'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace'
> = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

@injectable(asSpecEnhancer, { scope: BindingScope.SINGLETON })
export class ODataVisibilitySpecEnhancer implements OASEnhancer {
  name = 'odata-visibility';

  constructor(@inject(ODATA_BINDINGS.CONFIG) private readonly config: ODataConfig) {}

  modifySpec(spec: OpenApiSpec): OpenApiSpec {
    if (!spec.paths) return spec;

    const shouldRemove = this.config?.removeUndocumentedFromSpec ?? true;
    const pathsToRemove: string[] = [];

    for (const [pathKey, pathSpec] of Object.entries(spec.paths)) {
      if (!pathSpec) continue;

      for (const method of HTTP_METHODS) {
        const rawOperation = (pathSpec as Record<string, unknown>)[method];
        if (!rawOperation || typeof rawOperation !== 'object') continue;
        const operation = rawOperation as Record<string, unknown>;

        const isGenerated = operation['x-odata-generated'] === true;
        const odataVisibility = operation['x-odata-visibility'];

        if (!isGenerated || odataVisibility !== 'undocumented') {
          if (isGenerated) {
            (pathSpec as Record<string, unknown>)[method] = {
              ...operation,
              'x-visibility': operation['x-visibility'] ?? 'documented',
            };
          }
          continue;
        }

        if (shouldRemove) {
          delete (pathSpec as Record<string, unknown>)[method];
          continue;
        }

        (pathSpec as Record<string, unknown>)[method] = {
          ...operation,
          'x-visibility': 'internal',
        };
      }

      const hasOperations = HTTP_METHODS.some(
        (method) => (pathSpec as Record<string, unknown>)[method] != null,
      );
      if (!hasOperations) {
        pathsToRemove.push(pathKey);
      }
    }

    for (const path of pathsToRemove) {
      delete spec.paths[path];
    }

    return spec;
  }
}

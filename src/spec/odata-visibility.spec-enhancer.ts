import { BindingScope, inject, injectable } from '@loopback/core';
import { asSpecEnhancer, OASEnhancer, OpenApiSpec } from '@loopback/openapi-v3';
import { ODataConfig } from '../types';
import { ODATA_BINDINGS } from '../keys';
import { normalizeBasePath } from '../util/base-path';

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

    const basePath = normalizeBasePath(this.config?.basePath);
    if (basePath !== '/odata') {
      spec.paths = remapODataPaths(spec.paths, basePath);
    }

    return spec;
  }
}

function remapODataPaths(
  paths: NonNullable<OpenApiSpec['paths']>,
  basePath: string,
): NonNullable<OpenApiSpec['paths']> {
  const remapped: NonNullable<OpenApiSpec['paths']> = {};

  for (const [pathKey, pathSpec] of Object.entries(paths)) {
    const targetPath = rewriteODataPath(pathKey, basePath);
    const existing = remapped[targetPath];
    remapped[targetPath] =
      existing && pathSpec
        ? ({
            ...existing,
            ...pathSpec,
          } as (typeof remapped)[string])
        : pathSpec;
  }

  return remapped;
}

function rewriteODataPath(pathKey: string, basePath: string): string {
  if (pathKey === '/odata') {
    return basePath;
  }
  if (!pathKey.startsWith('/odata/')) {
    return pathKey;
  }

  const suffix = pathKey.slice('/odata'.length);
  return basePath === '/' ? suffix || '/' : `${basePath}${suffix}`;
}

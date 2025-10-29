import { inject } from '@loopback/core';
import { get, Response, RestBindings, Request } from '@loopback/rest';
import { ODATA_BINDINGS } from '../keys';
import { EntitySetRegistry } from '../registry/entityset-registry';
import { ODataConfig } from '../types';
import { ODATA_VERSION } from '../constants';
import { markUndocumentedOperation } from '../util/openapi';

const SERVICE_DOCUMENT_OPERATION_SPEC = markUndocumentedOperation({
  responses: {
    '200': {
      description: 'OData service document',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['@odata.context', 'value'],
            properties: {
              '@odata.context': { type: 'string' },
              value: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'kind', 'url'],
                  properties: {
                    name: { type: 'string' },
                    kind: { type: 'string' },
                    url: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

interface ServiceDocumentEntry {
  name: string;
  kind: 'EntitySet';
  url: string;
}

interface ServiceDocumentPayload {
  '@odata.context': string;
  value: ServiceDocumentEntry[];
}

function normalizeBasePath(configured?: string): string {
  let basePath = configured?.trim() ?? '';
  if (!basePath) return '/odata';
  if (!basePath.startsWith('/')) basePath = `/${basePath}`;
  if (basePath.length > 1 && basePath.endsWith('/')) {
    basePath = basePath.slice(0, -1);
  }
  return basePath || '/';
}

export class ODataServiceDocumentController {
  constructor(
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
    private readonly registry: EntitySetRegistry,
    @inject(ODATA_BINDINGS.CONFIG)
    private readonly config: ODataConfig,
  ) {}

  @get('/odata', SERVICE_DOCUMENT_OPERATION_SPEC)
  getServiceDocument(
    @inject(RestBindings.Http.RESPONSE) response: Response,
    @inject(RestBindings.Http.REQUEST) request: Request,
  ): ServiceDocumentPayload {
    if (this.config?.strict) {
      const accept = request.get('Accept') ?? (request.headers?.['accept'] as string | undefined);
      if (accept?.trim()) {
        const lower = accept.toLowerCase();
        const ok =
          lower.includes('application/json') ||
          lower.includes('*/*') ||
          /application\s*\/\s*\*/.test(lower);
        if (!ok) {
          const err: any = new Error('NotAcceptable');
          err.statusCode = 406;
          err.code = 'NotAcceptable';
          throw err;
        }
      }
    }
    if (!response.getHeader('OData-Version')) {
      response.set('OData-Version', ODATA_VERSION);
    }

    const serviceRoot = normalizeBasePath(this.config.basePath);
    const payload: ServiceDocumentPayload = {
      '@odata.context': `${serviceRoot}/$metadata`,
      value: this.registry.list().map((def) => ({
        name: def.name,
        kind: 'EntitySet',
        url: def.name,
      })),
    };

    return payload;
  }
}

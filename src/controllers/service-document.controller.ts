import { inject } from '@loopback/core';
import { get, Response, RestBindings, Request } from '@loopback/rest';
import { ODATA_BINDINGS } from '../keys';
import { EntitySetRegistry } from '../registry/entityset-registry';
import { ODataConfig } from '../types';
import { ODATA_VERSION } from '../constants';
import { markUndocumentedOperation } from '../util/openapi';
import { acceptsAnyMediaType } from '../util/accept';
import { normalizeBasePath } from '../util/base-path';
import { ODataErrorCodes } from '../odata-error-codes';

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
      const acceptHeader = request.get('Accept') ?? request.headers?.['accept'];
      const accept = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader;
      if (accept?.trim()) {
        if (!acceptsAnyMediaType(accept, ['application/json'])) {
          const err: any = new Error('NotAcceptable');
          err.statusCode = 406;
          err.code = ODataErrorCodes.NotAcceptable;
          throw err;
        }
      }
    }
    if (!response.getHeader('OData-Version')) {
      response.set('OData-Version', ODATA_VERSION);
    }

    const serviceRoot = normalizeBasePath(this.config.basePath);
    const contextUrl = serviceRoot === '/' ? '/$metadata' : `${serviceRoot}/$metadata`;
    const payload: ServiceDocumentPayload = {
      '@odata.context': contextUrl,
      value: this.registry.list().map((def) => ({
        name: def.name,
        kind: 'EntitySet',
        url: def.name,
      })),
    };

    return payload;
  }
}

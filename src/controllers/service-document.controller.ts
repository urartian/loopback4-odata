import {inject} from '@loopback/core';
import {get, Response, RestBindings} from '@loopback/rest';
import {ODATA_BINDINGS} from '../keys';
import {EntitySetRegistry} from '../registry/entityset-registry';
import {ODataConfig} from '../types';

interface ServiceDocumentEntry {
    name: string;
    kind: 'EntitySet';
    url: string;
}

interface ServiceDocumentPayload {
    '@odata.context': string;
    value: ServiceDocumentEntry[];
}

const ODATA_VERSION = '4.01';

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

    @get('/odata', {
        responses: {
            '200': {
                description: 'OData service document',
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            required: ['@odata.context', 'value'],
                            properties: {
                                '@odata.context': {type: 'string'},
                                value: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        required: ['name', 'kind', 'url'],
                                        properties: {
                                            name: {type: 'string'},
                                            kind: {type: 'string'},
                                            url: {type: 'string'},
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    })
    getServiceDocument(
        @inject(RestBindings.Http.RESPONSE) response: Response,
    ): ServiceDocumentPayload {
        if (!response.getHeader('OData-Version')) {
            response.set('OData-Version', ODATA_VERSION);
        }

        const serviceRoot = normalizeBasePath(this.config.basePath);
        const payload: ServiceDocumentPayload = {
            '@odata.context': `${serviceRoot}/$metadata`,
            value: this.registry.list().map(def => ({
                name: def.name,
                kind: 'EntitySet',
                url: def.name,
            })),
        };

        return payload;
    }
}

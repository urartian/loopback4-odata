import { get, Response, RestBindings } from '@loopback/rest';
import { inject } from '@loopback/core';
import { ODATA_BINDINGS } from '../keys';
import { CsdlGenerator } from '../metadata/csdl-generator';
import { ODataConfig } from '../types';

export class ODataMetadataController {
    constructor(
        @inject(ODATA_BINDINGS.CSDL_GEN) private csdl: CsdlGenerator,
        @inject(ODATA_BINDINGS.CONFIG) private cfg: ODataConfig,
    ) { }

    @get('/odata/$metadata', {
        responses: {
            '200': {
                description: 'OData service metadata',
                content: {
                    'application/xml': { schema: { type: 'string' } },
                },
            },
        },
    })
    getMetadata(
        @inject(RestBindings.Http.RESPONSE) res: Response,
    ): string {
        res.type(this.csdl.contentType(this.cfg.csdlFormat ?? 'xml'));
        return this.csdl.generate();
    }
}

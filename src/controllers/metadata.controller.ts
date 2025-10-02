import { get, Response, RestBindings } from '@loopback/rest';
import { inject } from '@loopback/core';
import { ODATA_BINDINGS } from '../keys';
import { CsdlGenerator } from '../metadata/csdl-generator';
import { ODataConfig } from '../types';
import { ODATA_VERSION } from '../constants';

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
    ): Response {
        const body = this.csdl.generate();
        const mime = this.csdl.contentType(this.cfg.csdlFormat ?? 'xml');
        if (!res.getHeader('OData-Version')) {
            res.set('OData-Version', ODATA_VERSION);
        }
        res.type(mime);
        res.send(body);
        return res;
    }
}

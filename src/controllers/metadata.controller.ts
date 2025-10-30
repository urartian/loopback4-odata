import { get, Response, RestBindings } from '@loopback/rest';
import { inject } from '@loopback/core';
import { ODATA_BINDINGS } from '../keys';
import { CsdlGenerator } from '../metadata/csdl-generator';
import { ODataConfig } from '../types';
import { markUndocumentedOperation } from '../util/openapi';

const METADATA_OPERATION_SPEC = markUndocumentedOperation({
  responses: {
    '200': {
      description: 'OData service metadata',
      content: {
        'application/xml': { schema: { type: 'string' } },
        'application/json': { schema: { type: 'string' } },
      },
    },
  },
});

export class ODataMetadataController {
  constructor(
    @inject(ODATA_BINDINGS.CSDL_GEN) private csdl: CsdlGenerator,
    @inject(ODATA_BINDINGS.CONFIG) private cfg: ODataConfig,
  ) {}

  @get('/odata/$metadata', METADATA_OPERATION_SPEC)
  getMetadata(
    @inject(RestBindings.Http.RESPONSE) res: Response,
    @inject(RestBindings.Http.REQUEST) req: any,
  ): Response {
    if (this.cfg?.strict) {
      const accept = (req?.get?.('Accept') ?? req?.headers?.['accept'] ?? '')
        .toString()
        .toLowerCase();
      if (accept?.trim()) {
        const desired =
          (this.cfg?.csdlFormat ?? 'xml') === 'json' ? 'application/json' : 'application/xml';
        const ok =
          accept.includes(desired) ||
          accept.includes('*/*') ||
          /application\s*\/\s*\*/.test(accept);
        if (!ok) {
          const err = new Error('NotAcceptable');
          (err as any).statusCode = 406;
          (err as any).code = 'NotAcceptable';
          throw err;
        }
      }
    }
    const format = this.cfg.csdlFormat ?? 'xml';
    const body = this.csdl.generate(format);
    const mime = this.csdl.contentType(format);
    res.type(mime);
    res.send(body);
    return res;
  }
}

import { get, Response, RestBindings, HttpErrors } from '@loopback/rest';
import { inject } from '@loopback/core';
import { ODATA_BINDINGS } from '../keys';
import { CsdlGenerator } from '../metadata/csdl-generator';
import { ODataConfig } from '../types';
import { markUndocumentedOperation } from '../util/openapi';
import { acceptsAnyMediaType } from '../util/accept';
import { ODataErrorCodes } from '../odata-error-codes';
import { createODataHttpError } from '../util/odata-http-error';

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
      const accept = (req?.get?.('Accept') ?? req?.headers?.['accept'] ?? '').toString();
      if (accept?.trim()) {
        const desired =
          (this.cfg?.csdlFormat ?? 'xml') === 'json' ? 'application/json' : 'application/xml';
        if (!acceptsAnyMediaType(accept, [desired])) {
          throw createODataHttpError(
            HttpErrors.NotAcceptable,
            ODataErrorCodes.NotAcceptable,
            `Accept header must allow ${desired}.`,
          );
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

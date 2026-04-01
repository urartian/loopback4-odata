import 'reflect-metadata';
import { expect } from '@loopback/testlab';
import { HttpErrors } from '@loopback/rest';
import { ODataServiceDocumentController } from '../../controllers/service-document.controller';
import { ODataMetadataController } from '../../controllers/metadata.controller';
import { ODataErrorCodes } from '../../odata-error-codes';

describe('Accept negotiation for metadata endpoints', () => {
  const expectNotAcceptable = (
    action: () => unknown,
    message: string,
    code = ODataErrorCodes.NotAcceptable,
  ) => {
    try {
      action();
      throw new Error('Expected request to be rejected with NotAcceptable.');
    } catch (error) {
      expect(error).to.be.instanceOf(HttpErrors.NotAcceptable);
      expect((error as { message?: string }).message).to.equal(message);
      expect((error as { code?: string }).code).to.equal(code);
    }
  };

  const createRequest = (accept?: string) =>
    ({
      get(header: string) {
        if (header.toLowerCase() === 'accept') return accept;
        return undefined;
      },
      headers: accept ? { accept } : {},
    }) as any;

  const createResponse = () =>
    ({
      headers: {} as Record<string, unknown>,
      getHeader(name: string) {
        return this.headers[name];
      },
      set(name: string, value: unknown) {
        this.headers[name] = value;
      },
      type() {
        return this;
      },
      send() {
        return this;
      },
    }) as any;

  it('rejects service document requests with q=0 for JSON', () => {
    const controller = new ODataServiceDocumentController(
      { list: () => [] } as any,
      { strict: true } as any,
    );
    const request = createRequest('application/json;q=0, */*;q=0');
    const response = createResponse();
    expectNotAcceptable(
      () => controller.getServiceDocument(response, request),
      'Accept header must allow application/json.',
    );
  });

  it('rejects service document requests when acceptable types precede q=0 for JSON', () => {
    const controller = new ODataServiceDocumentController(
      { list: () => [] } as any,
      { strict: true } as any,
    );
    const request = createRequest('text/plain;q=1, application/json;q=0');
    const response = createResponse();
    expectNotAcceptable(
      () => controller.getServiceDocument(response, request),
      'Accept header must allow application/json.',
    );
  });

  it('rejects metadata requests when desired type has q=0', () => {
    const controller = new ODataMetadataController(
      {
        generate: () => '<edmx:Edmx />',
        contentType: () => 'application/xml',
      } as any,
      { strict: true, csdlFormat: 'xml' } as any,
    );
    const request = createRequest('application/xml;q=0');
    const response = createResponse();
    expectNotAcceptable(
      () => controller.getMetadata(response, request),
      'Accept header must allow application/xml.',
    );
  });

  it('rejects metadata requests with uppercase q parameter for desired type', () => {
    const controller = new ODataMetadataController(
      {
        generate: () => '<edmx:Edmx />',
        contentType: () => 'application/xml',
      } as any,
      { strict: true, csdlFormat: 'xml' } as any,
    );
    const request = createRequest('text/plain;q=1, APPLICATION/XML;Q=0');
    const response = createResponse();
    expectNotAcceptable(
      () => controller.getMetadata(response, request),
      'Accept header must allow application/xml.',
    );
  });
});

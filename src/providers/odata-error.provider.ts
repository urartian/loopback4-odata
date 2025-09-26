import {BindingScope, Provider, inject, injectable} from '@loopback/core';
import {RestBindings, Reject} from '@loopback/rest';
import {HttpError} from 'http-errors';
import {
  ErrorWriterOptions,
  writeErrorToResponse,
} from 'strong-error-handler';

type ExtendedHttpError = HttpError & {
  statusCode?: number;
  status?: number;
  code?: string;
  details?: unknown[];
  target?: string;
  innerError?: object;
  stack?: string;
};

@injectable({scope: BindingScope.SINGLETON})
export class ODataErrorProvider implements Provider<Reject> {
  constructor(
    @inject(RestBindings.ERROR_WRITER_OPTIONS, {optional: true})
    private readonly options: ErrorWriterOptions = {},
  ) {}

  value(): Reject {
    return ({request, response}, err: Error) => {
      const url = request.originalUrl ?? request.url ?? '';

      if (!url.startsWith('/odata')) {
        writeErrorToResponse(err, request, response, this.options);
        return;
      }

      const httpError = err as ExtendedHttpError;
      const statusCode =
        httpError.statusCode ??
        httpError.status ??
        (httpError.code ? this.mapCodeToStatus(httpError.code) : undefined) ??
        500;
      const code = httpError.code ?? this.mapStatusToCode(statusCode);
      const message = httpError.message || this.defaultMessage(statusCode);
      const target = httpError.target ?? null;
      const details = this.normalizeDetails(httpError);
      const innererror = this.buildInnerError(httpError);

      response.status(statusCode);
      if (!response.getHeader('OData-Version')) {
        response.set('OData-Version', '4.01');
      }
      response.contentType('application/json; charset=utf-8');

      response.send({
        error: {
          code,
          message,
          target,
          details,
          innererror,
        },
      });
    };
  }

  private mapStatusToCode(status: number): string {
    switch (status) {
      case 400:
        return 'BadRequest';
      case 401:
        return 'Unauthorized';
      case 403:
        return 'Forbidden';
      case 404:
        return 'NotFound';
      case 409:
        return 'Conflict';
      case 412:
        return 'PreconditionFailed';
      case 428:
        return 'PreconditionRequired';
      case 501:
        return 'NotImplemented';
      default:
        return 'InternalServerError';
    }
  }

  private mapCodeToStatus(code?: string): number | undefined {
    switch (code) {
      case 'ENTITY_NOT_FOUND':
        return 404;
      case 'VALIDATION_ERROR':
      case 'REQUEST_VALIDATION_FAILED':
        return 400;
      case 'PreferenceNotSupported':
        return 501;
      case 'PreconditionFailed':
        return 412;
      case 'PreconditionRequired':
        return 428;
      default:
        return undefined;
    }
  }

  private defaultMessage(status: number): string {
    switch (status) {
      case 400:
        return 'Request cannot be processed.';
      case 404:
        return 'Resource not found.';
      default:
        return 'An unexpected error occurred.';
    }
  }

  private normalizeDetails(error: ExtendedHttpError): unknown[] {
    const {details} = error;
    if (Array.isArray(details)) return details;
    return [];
  }

  private buildInnerError(error: ExtendedHttpError): object {
    const inner: Record<string, unknown> = {};
    if (this.options.debug) {
      inner.stack = error.stack;
    }
    if (error.innerError) {
      return {...inner, ...error.innerError};
    }
    if (Object.keys(inner).length === 0) {
      return {};
    }
    return inner;
  }
}

import { BindingScope, Provider, inject, injectable } from '@loopback/core';
import { HttpErrors, RestBindings, Reject } from '@loopback/rest';
import { HttpError } from 'http-errors';
import { ErrorWriterOptions, writeErrorToResponse } from 'strong-error-handler';
import { ODATA_VERSION } from '../constants';
import { ODATA_BINDINGS } from '../keys';
import { ODataConfig } from '../types';
import { gatherRequestUrls, normalizeBasePath, pathMatches } from '../util/base-path';
import { ODataErrorCodes } from '../odata-error-codes';

type AnyObject = Record<string, unknown>;

type ExtendedHttpError = HttpError & {
  statusCode?: number;
  status?: number;
  code?: string;
  details?: unknown[];
  target?: string;
  innerError?: object;
  stack?: string;
};

@injectable({ scope: BindingScope.SINGLETON })
export class ODataErrorProvider implements Provider<Reject> {
  private readonly stableCodes = new Set<string>(Object.values(ODataErrorCodes));

  constructor(
    @inject(RestBindings.ERROR_WRITER_OPTIONS, { optional: true })
    private readonly options: ErrorWriterOptions = {},
    @inject(ODATA_BINDINGS.CONFIG)
    private readonly cfg: ODataConfig,
  ) {}

  value(): Reject {
    return ({ request, response }, err: Error) => {
      const basePath = normalizeBasePath(this.cfg?.basePath);
      const urls = gatherRequestUrls(request);
      const targetsOData = urls.some(
        (url) => pathMatches(url, '/odata') || pathMatches(url, basePath),
      );
      if (!targetsOData) {
        writeErrorToResponse(err, request, response, this.options);
        return;
      }

      const normalizedError = this.normalizeODataError(request, err) as ExtendedHttpError;
      const httpError = normalizedError as ExtendedHttpError;
      const explicitCode = typeof httpError.code === 'string' ? httpError.code : undefined;
      const stableCode =
        explicitCode && this.stableCodes.has(explicitCode) ? explicitCode : undefined;
      const statusCode =
        httpError.statusCode ?? httpError.status ?? this.mapCodeToStatus(explicitCode) ?? 500;
      const code = stableCode ?? this.mapStatusToCode(statusCode);
      const message = httpError.message || this.defaultMessage(statusCode);
      const target = httpError.target ?? null;
      const details = this.normalizeDetails(httpError);
      const innererror = this.buildInnerError(httpError, stableCode ? undefined : explicitCode);

      response.status(statusCode);
      if (!response.getHeader('OData-Version')) {
        response.set('OData-Version', ODATA_VERSION);
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

  private normalizeODataError(request: { method?: string }, err: Error): Error {
    const anyErr = err as unknown as AnyObject;
    if ((anyErr as ExtendedHttpError)?.statusCode || (anyErr as ExtendedHttpError)?.status) {
      return err;
    }

    // Postgres foreign_key_violation (e.g. delete parent row blocked by FK RESTRICT/NO ACTION)
    // In database-enforced composition mode, this is the expected "restrict" behavior and should
    // surface as 409 Conflict rather than 500.
    if (String(request?.method ?? '').toUpperCase() === 'DELETE' && anyErr?.code === '23503') {
      const conflict = new HttpErrors.Conflict(
        'Delete restricted by referential integrity constraints.',
      );
      (conflict as AnyObject).innerError = {
        ...(anyErr?.constraint ? { constraint: anyErr.constraint } : {}),
        ...(anyErr?.table ? { table: anyErr.table } : {}),
        ...(anyErr?.detail ? { detail: anyErr.detail } : {}),
        dbCode: anyErr.code,
      };
      return conflict;
    }

    return err;
  }

  private mapStatusToCode(status: number): string {
    switch (status) {
      case 400:
        return ODataErrorCodes.BadRequest;
      case 406:
        return ODataErrorCodes.NotAcceptable;
      case 415:
        return ODataErrorCodes.UnsupportedMediaType;
      case 401:
        return ODataErrorCodes.Unauthorized;
      case 403:
        return ODataErrorCodes.Forbidden;
      case 404:
        return ODataErrorCodes.NotFound;
      case 422:
        return ODataErrorCodes.UnprocessableEntity;
      case 409:
        return ODataErrorCodes.Conflict;
      case 412:
        return ODataErrorCodes.PreconditionFailed;
      case 428:
        return ODataErrorCodes.PreconditionRequired;
      case 413:
        return ODataErrorCodes.PayloadTooLarge;
      case 501:
        return ODataErrorCodes.NotImplemented;
      default:
        return ODataErrorCodes.InternalServerError;
    }
  }

  private mapCodeToStatus(code?: string): number | undefined {
    switch (code) {
      case 'ENTITY_NOT_FOUND':
        return 404;
      case 'VALIDATION_ERROR':
      case 'REQUEST_VALIDATION_FAILED':
        return 400;
      case ODataErrorCodes.PreferenceNotSupported:
      case ODataErrorCodes.MultiDataSourceChangesetNotSupported:
      case ODataErrorCodes.AtomicityGroupNotSupported:
        return 501;
      case ODataErrorCodes.TenantResolutionFailed:
        return 400;
      case ODataErrorCodes.PreconditionFailed:
        return 412;
      case ODataErrorCodes.PreconditionRequired:
        return 428;
      case ODataErrorCodes.UnprocessableEntity:
        return 422;
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
    const { details } = error;
    if (Array.isArray(details)) return details;
    return [];
  }

  private buildInnerError(error: ExtendedHttpError, dbCode?: string): object {
    const inner: Record<string, unknown> = {};
    if (this.options.debug) {
      inner.stack = error.stack;
    }
    if (error.innerError && typeof error.innerError === 'object') {
      Object.assign(inner, error.innerError);
    }
    if (dbCode && inner.dbCode === undefined) {
      inner.dbCode = dbCode;
    }
    return inner;
  }
}

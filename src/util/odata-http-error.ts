import { HttpError } from 'http-errors';
import { ODataErrorCode } from '../odata-error-codes';

export interface ODataHttpErrorMetadata {
  target?: string;
  details?: unknown[];
  innerError?: object;
}

export type ODataHttpError = HttpError & {
  code?: string;
  target?: string;
  details?: unknown[];
  innerError?: object;
};

type HttpErrorConstructor<T extends HttpError = HttpError> = new (message?: string) => T;

export function annotateODataHttpError<T extends HttpError>(
  error: T,
  code: ODataErrorCode,
  metadata: ODataHttpErrorMetadata = {},
): T & ODataHttpError {
  const target = error as T & ODataHttpError;
  target.code = code;
  if (metadata.target !== undefined) {
    target.target = metadata.target;
  }
  if (metadata.details !== undefined) {
    target.details = metadata.details;
  }
  if (metadata.innerError !== undefined) {
    target.innerError = metadata.innerError;
  }
  return target;
}

export function createODataHttpError<T extends HttpError>(
  errorCtor: HttpErrorConstructor<T>,
  code: ODataErrorCode,
  message: string,
  metadata: ODataHttpErrorMetadata = {},
): T & ODataHttpError {
  return annotateODataHttpError(new errorCtor(message), code, metadata);
}

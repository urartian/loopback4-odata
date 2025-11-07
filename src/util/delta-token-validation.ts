import { DeltaTokenPayload } from './delta-token';
import { TokenVerificationError } from './token-signing';
import { ODataDeltaTokenInvalidEvent, ODataDeltaTokenInvalidCode } from '../types';

export type DeltaTokenValidationResult =
  | { ok: true; payload?: DeltaTokenPayload }
  | {
      ok: false;
      code: ODataDeltaTokenInvalidCode;
      message: string;
    };

export interface DeltaTokenValidationOptions {
  entitySet: string;
  deltaEnabled: boolean;
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
  onTelemetry?: (event: ODataDeltaTokenInvalidEvent) => void;
  decode: () => DeltaTokenPayload;
}

export function validateDeltaToken(
  options: DeltaTokenValidationOptions,
): DeltaTokenValidationResult {
  const { deltaEnabled: enabled, entitySet, logger, onTelemetry } = options;
  if (!enabled) {
    return {
      ok: false,
      code: 'delta-not-supported',
      message: '$deltatoken is not supported for this entity set.',
    };
  }

  let payload: DeltaTokenPayload;
  try {
    payload = options.decode();
  } catch (error) {
    const code =
      error instanceof TokenVerificationError && error.reason === 'expired' ? 'expired' : 'invalid';
    emit(logger, onTelemetry, code, entitySet);
    const message =
      code === 'expired'
        ? '$deltatoken has expired. Request a fresh delta feed.'
        : 'Invalid $deltatoken value.';
    return { ok: false, code, message };
  }

  if (payload?.entitySet && payload.entitySet !== entitySet) {
    emit(logger, onTelemetry, 'entity-mismatch', entitySet);
    return {
      ok: false,
      code: 'entity-mismatch',
      message: '$deltatoken does not match the requested entity set.',
    };
  }

  return { ok: true, payload };
}

function emit(
  logger: DeltaTokenValidationOptions['logger'],
  onTelemetry: DeltaTokenValidationOptions['onTelemetry'],
  code: ODataDeltaTokenInvalidCode,
  entitySet: string,
) {
  logger?.warn('Invalid delta token.', { code, entitySet });
  onTelemetry?.({ event: 'delta-token-invalid', code, entitySet });
}

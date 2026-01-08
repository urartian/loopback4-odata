import { RequestContext } from '@loopback/rest';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import { ODataRequestState, ODataTelemetryCategory, ODataTelemetryLevel } from '../types';

export interface TelemetryEventOptions {
  category: ODataTelemetryCategory;
  event: string;
  level?: ODataTelemetryLevel;
  context?: Record<string, unknown>;
  requireSample?: boolean;
  error?: Error;
}

export interface StatisticsUpdate {
  rows?: number;
  roundTripsIncrement?: number;
  dbTimeNs?: bigint;
}

export function getRequestStateFromContext(
  ctx: RequestContext | undefined,
): ODataRequestState | undefined {
  if (!ctx) return undefined;
  try {
    return ctx.getSync(ODATA_BINDINGS.REQUEST_STATE, { optional: true }) as
      | ODataRequestState
      | undefined;
  } catch {
    return undefined;
  }
}

export function emitTelemetryEvent(
  logger: ODataLogger | undefined,
  state: ODataRequestState | undefined,
  options: TelemetryEventOptions,
): void {
  if (!logger) return;
  const telemetry = state?.telemetry;
  if (!telemetry?.enabled) return;
  if (telemetry.categories && !telemetry.categories.has(options.category)) return;
  if (options.requireSample !== false && telemetry.sampled === false) return;

  const level: ODataTelemetryLevel = options.level ?? telemetry.level ?? 'info';
  const baseContext = {
    telemetryEvent: options.event,
    telemetryCategory: options.category,
    correlationId: state?.correlationId,
    tenantId: state?.tenantId,
    sampled: telemetry.sampled,
  };
  const context = {
    ...baseContext,
    ...(options.context ?? {}),
  };

  logAtLevel(logger, level, `Telemetry:${options.event}`, context, options.error);
}

export function recordStatistics(
  state: ODataRequestState | undefined,
  update: StatisticsUpdate,
): void {
  if (!state?.statistics) return;
  if (typeof update.rows === 'number' && Number.isFinite(update.rows)) {
    state.statistics.rows = update.rows;
  }
  if (
    typeof update.roundTripsIncrement === 'number' &&
    Number.isFinite(update.roundTripsIncrement)
  ) {
    state.statistics.roundTrips += update.roundTripsIncrement;
  }
  if (typeof update.dbTimeNs === 'bigint') {
    state.statistics.dbTimeNs += update.dbTimeNs;
  }
}

function logAtLevel(
  logger: ODataLogger,
  level: ODataTelemetryLevel,
  message: string,
  context?: Record<string, unknown>,
  error?: Error,
): void {
  switch (level) {
    case 'trace':
      logger.trace(message, context);
      break;
    case 'debug':
      logger.debug(message, context);
      break;
    case 'info':
      logger.info(message, context);
      break;
    case 'warn':
      logger.warn(message, context);
      break;
    case 'error':
      logger.error(message, context, error);
      break;
    default:
      logger.info(message, context);
      break;
  }
}

import { BindingKey } from '@loopback/core';
import { ODataEntitySetRegistry } from './entity-set-config';
import { ODataConfig, ODataLogEntry, ODataRequestState, ODataTenantThrottleContext } from './types';
import { CsdlGenerator } from './metadata/csdl-generator';
import { ODataApplyExecutorRegistry } from './services/odata-apply-executor.registry';
import { TenantThrottleStore } from './services/tenant-throttle-store';
import { ODataMediaHandler } from './services/odata-media-handler';

/**
 * Public binding keys used by the OData component.
 *
 * Bind application-specific implementations here to customize logging,
 * registry behavior, tenant throttling, media handlers, or telemetry.
 */
export const ODATA_BINDINGS = {
  /** Component configuration bound by the host LB4 application. */
  CONFIG: BindingKey.create<ODataConfig>('odata.config'),
  /** @internal Internal metadata generator binding used by `$metadata` controllers. */
  CSDL_GEN: BindingKey.create<CsdlGenerator>('odata.csdl'),
  /** Advanced entity-set registry used during boot and custom registration. */
  ENTITY_SET_REGISTRY: BindingKey.create<ODataEntitySetRegistry>('odata.registry.entitysets'),
  /** Registry of datastore-backed `$apply` executors. */
  APPLY_EXECUTOR_REGISTRY: BindingKey.create<ODataApplyExecutorRegistry>('odata.apply.executors'),
  /** Structured logger adapter used by the component. */
  LOGGER: BindingKey.create<ODataLogger>('odata.logger'),
  /** Request throttler enforcing tenant-specific quotas. */
  THROTTLER: BindingKey.create<ODataTenantThrottler>('odata.tenantThrottler'),
  /** Backing store used by the tenant throttler. */
  THROTTLE_STORE: BindingKey.create<TenantThrottleStore>('odata.tenantThrottler.store'),
  /** Request-scoped state captured for the current OData request. */
  REQUEST_STATE: BindingKey.create<ODataRequestState>('odata.request.state'),
  /** Bound media handlers consulted for `$value` read/write/delete operations. */
  MEDIA_HANDLERS: BindingKey.create<ODataMediaHandler>('odata.media.handlers'),
};

/** Minimal structured logger contract used by the OData component. */
export interface ODataLogger {
  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>, error?: Error): void;
}

/** Dispatches a structured log entry to the matching logger method. */
export function createLogEntry(logger: ODataLogger, entry: ODataLogEntry): void {
  const { level, message, context, error } = entry;
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

/** Public throttler contract used to enforce per-tenant request quotas. */
export interface ODataTenantThrottler {
  check(tenant: string, context?: ODataTenantThrottleContext): Promise<void>;
  release(tenant: string): void;
}

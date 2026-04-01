import { BindingKey } from '@loopback/core';
import { ODataEntitySetRegistry } from './entity-set-config';
import { ODataConfig, ODataLogEntry, ODataRequestState, ODataTenantThrottleContext } from './types';
import { CsdlGenerator } from './metadata/csdl-generator';
import { ODataApplyExecutorRegistry } from './services/odata-apply-executor.registry';
import { TenantThrottleStore } from './services/tenant-throttle-store';
import { ODataMediaHandler } from './services/odata-media-handler';

export const ODATA_BINDINGS = {
  CONFIG: BindingKey.create<ODataConfig>('odata.config'),
  CSDL_GEN: BindingKey.create<CsdlGenerator>('odata.csdl'),
  ENTITY_SET_REGISTRY: BindingKey.create<ODataEntitySetRegistry>('odata.registry.entitysets'),
  APPLY_EXECUTOR_REGISTRY: BindingKey.create<ODataApplyExecutorRegistry>('odata.apply.executors'),
  LOGGER: BindingKey.create<ODataLogger>('odata.logger'),
  THROTTLER: BindingKey.create<ODataTenantThrottler>('odata.tenantThrottler'),
  THROTTLE_STORE: BindingKey.create<TenantThrottleStore>('odata.tenantThrottler.store'),
  REQUEST_STATE: BindingKey.create<ODataRequestState>('odata.request.state'),
  MEDIA_HANDLERS: BindingKey.create<ODataMediaHandler>('odata.media.handlers'),
};

export interface ODataLogger {
  trace(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>, error?: Error): void;
}

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

export interface ODataTenantThrottler {
  check(tenant: string, context?: ODataTenantThrottleContext): Promise<void>;
  release(tenant: string): void;
}

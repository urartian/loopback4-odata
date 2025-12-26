import { AnyObject } from '@loopback/repository';
import {
  ODataConfig,
  ODataCorrelationConfig,
  ODataPaginationConfig,
  ODataTelemetryCategory,
  ODataTelemetryConfig,
  ODataTelemetryLevel,
  ODataTenantQuotaConfig,
} from '../types';

const validatedConfigs = new WeakSet<ODataConfig>();
const TELEMETRY_LEVELS: ReadonlySet<ODataTelemetryLevel> = new Set([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
]);
const TELEMETRY_CATEGORIES: ReadonlySet<ODataTelemetryCategory> = new Set([
  'apply',
  'rewrite',
  'hooks',
  'batch',
  'throttle',
  'tokens',
  'requests',
]);

export function ensureConfigValidated(config: ODataConfig): void {
  if (validatedConfigs.has(config)) return;
  validateODataConfig(config);
  validatedConfigs.add(config);
}

export function validateODataConfig(config: ODataConfig): void {
  if (!config) {
    throw new Error('ODataConfig must be provided.');
  }
  if (
    typeof config.tokenSecret !== 'string' ||
    !config.tokenSecret ||
    !config.tokenSecret.trim().length
  ) {
    throw new Error('ODataConfig.tokenSecret must be configured.');
  }
  config.tokenSecret = config.tokenSecret.trim();
  if (config.pagination) {
    validatePaginationLimits('ODataConfig.pagination', config.pagination);
  }
  assignPositive(config as AnyObject, 'pageSize');
  assignPositive(config as AnyObject, 'maxTop');
  assignPositive(config as AnyObject, 'maxSkip');
  assignPositive(config as AnyObject, 'maxFilterPatternLength');
  assignPositive(config as AnyObject, 'maxSubstringStart');
  assignPositive(config as AnyObject, 'maxSubstringLength');
  assignPositive(config as AnyObject, 'maxFilterFieldNameLength');
  assignPositive(config as AnyObject, 'maxDecimalExponentAbs');
  assignPositive(config as AnyObject, 'maxApplyResultSize');
  assignPositive(config as AnyObject, 'maxApplyNavigationFanout');
  assignPositive(config as AnyObject, 'maxSearchFields');
  assignPositive(config as AnyObject, 'maxSearchTerms');
  assignPositive(config as AnyObject, 'skipTokenTtl');
  assignPositive(config as AnyObject, 'deltaTokenTtl');
  assignPositive(config as AnyObject, 'maxDeepInsertDepth');
  assignPositive(config as AnyObject, 'maxDeepUpdateDepth');
  if (config.batch) {
    const batch = config.batch as AnyObject;
    assignPositive(batch, 'maxPayloadBytes', 'ODataConfig.batch');
    assignPositive(batch, 'maxOperations', 'ODataConfig.batch');
    assignPositive(batch, 'maxChangesetOperations', 'ODataConfig.batch');
    assignPositive(batch, 'maxDepth', 'ODataConfig.batch');
    assignPositive(batch, 'maxPartBodyBytes', 'ODataConfig.batch');
    assignPositive(batch, 'maxResponseBodyBytes', 'ODataConfig.batch');
    assignPositive(batch, 'maxResponsePayloadBytes', 'ODataConfig.batch');
  }
  if (config.telemetry) {
    validateTelemetryConfig(config.telemetry);
  }
  if (config.correlation) {
    validateCorrelationConfig(config.correlation);
  }
  if (config.tenantQuotas) {
    validateTenantQuotas('ODataConfig.tenantQuotas', config.tenantQuotas);
  }
}

export function validatePaginationLimits(label: string, pagination?: ODataPaginationConfig): void {
  if (!pagination) return;
  const target = pagination as AnyObject;
  assignPositive(target, 'maxTop', label);
  assignPositive(target, 'maxSkip', label);
  assignPositive(target, 'maxPageSize', label);
  assignPositive(target, 'maxApplyPageSize', label);
}

function assignPositive(target: AnyObject, key: string, parentLabel = 'ODataConfig'): void {
  if (!(key in target)) return;
  const value = target[key];
  const normalized = normalizePositiveNumber(value, `${parentLabel}.${String(key)}`);
  if (normalized !== undefined) {
    target[key] = normalized;
  }
}

function normalizePositiveNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return Math.floor(num);
}

function validateTelemetryConfig(telemetry: ODataTelemetryConfig): void {
  if (telemetry.level && !TELEMETRY_LEVELS.has(telemetry.level)) {
    throw new Error(
      `ODataConfig.telemetry.level must be one of ${Array.from(TELEMETRY_LEVELS).join(', ')}.`,
    );
  }
  if (telemetry.categories) {
    if (!Array.isArray(telemetry.categories)) {
      throw new Error('ODataConfig.telemetry.categories must be an array.');
    }
    for (const category of telemetry.categories) {
      if (!TELEMETRY_CATEGORIES.has(category as ODataTelemetryCategory)) {
        throw new Error(
          `ODataConfig.telemetry.categories contains unsupported value "${String(category)}".`,
        );
      }
    }
  }
  if (telemetry.sampleRate !== undefined && telemetry.sampleRate !== null) {
    const rate = Number(telemetry.sampleRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error('ODataConfig.telemetry.sampleRate must be between 0 and 1.');
    }
    telemetry.sampleRate = rate;
  }
  if (telemetry.statisticsHeaderName !== undefined && telemetry.statisticsHeaderName !== null) {
    if (
      typeof telemetry.statisticsHeaderName !== 'string' ||
      telemetry.statisticsHeaderName.trim().length === 0
    ) {
      throw new Error('ODataConfig.telemetry.statisticsHeaderName must be a non-empty string.');
    }
    telemetry.statisticsHeaderName = telemetry.statisticsHeaderName.trim();
  }
  assignNonNegative(telemetry as AnyObject, 'statisticsPrecision', 'ODataConfig.telemetry');
  if (telemetry.requestLogging) {
    validateRequestLoggingConfig(telemetry.requestLogging);
  }
}

function validateCorrelationConfig(cfg: ODataCorrelationConfig): void {
  if (cfg.headerName !== undefined && cfg.headerName !== null) {
    if (typeof cfg.headerName !== 'string' || cfg.headerName.trim().length === 0) {
      throw new Error('ODataConfig.correlation.headerName must be a non-empty string.');
    }
    cfg.headerName = cfg.headerName.trim();
  }
  if (cfg.responseHeaderName !== undefined && cfg.responseHeaderName !== null) {
    if (typeof cfg.responseHeaderName !== 'string' || cfg.responseHeaderName.trim().length === 0) {
      throw new Error('ODataConfig.correlation.responseHeaderName must be a non-empty string.');
    }
    cfg.responseHeaderName = cfg.responseHeaderName.trim();
  }
}

function assignNonNegative(target: AnyObject, key: string, parentLabel = 'ODataConfig'): void {
  if (!(key in target)) return;
  const value = target[key];
  if (value === undefined || value === null) return;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${parentLabel}.${String(key)} must be a non-negative number.`);
  }
  target[key] = Math.floor(num);
}

function validateRequestLoggingConfig(config: AnyObject): void {
  if (config.maxPayloadBytes !== undefined && config.maxPayloadBytes !== null) {
    assignPositive(config, 'maxPayloadBytes', 'ODataConfig.telemetry.requestLogging');
  }
  if (config.maskHeaders !== undefined && config.maskHeaders !== null) {
    if (!Array.isArray(config.maskHeaders)) {
      throw new Error('ODataConfig.telemetry.requestLogging.maskHeaders must be an array.');
    }
  }
  if (config.maskBodyPaths !== undefined && config.maskBodyPaths !== null) {
    if (!Array.isArray(config.maskBodyPaths)) {
      throw new Error('ODataConfig.telemetry.requestLogging.maskBodyPaths must be an array.');
    }
  }
}

function validateTenantQuotas(label: string, quotas: ODataTenantQuotaConfig): void {
  const target = quotas as AnyObject;
  assignPositive(target, 'maxRequestsPerMinute', label);
  assignPositive(target, 'maxConcurrentRequests', label);
  assignPositive(target, 'maxLeaseRefreshers', label);
  if (!quotas.overrides) return;
  for (const [tenant, override] of Object.entries(quotas.overrides)) {
    if (!override) continue;
    const overrideLabel = `${label}.overrides["${tenant}"]`;
    assignPositive(override as AnyObject, 'maxRequestsPerMinute', overrideLabel);
    assignPositive(override as AnyObject, 'maxConcurrentRequests', overrideLabel);
  }
}

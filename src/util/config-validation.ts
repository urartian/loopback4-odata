import { AnyObject } from '@loopback/repository';
import { ODataConfig, ODataPaginationConfig } from '../types';

const validatedConfigs = new WeakSet<ODataConfig>();

export function ensureConfigValidated(config: ODataConfig): void {
  if (validatedConfigs.has(config)) return;
  validateODataConfig(config);
  validatedConfigs.add(config);
}

export function validateODataConfig(config: ODataConfig): void {
  if (!config) {
    throw new Error('ODataConfig must be provided.');
  }
  if (config.pagination) {
    validatePaginationLimits('ODataConfig.pagination', config.pagination);
  }
  assignPositive(config as AnyObject, 'pageSize');
  assignPositive(config as AnyObject, 'maxTop');
  assignPositive(config as AnyObject, 'maxSkip');
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

function assignPositive(
  target: AnyObject,
  key: string,
  parentLabel = 'ODataConfig',
): void {
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

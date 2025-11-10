import { inject, Provider } from '@loopback/core';
import { ODATA_BINDINGS, ODataLogger, ODataTenantThrottler } from '../keys';
import { ODataConfig, ODataTenantThrottleContext } from '../types';
import {
  InMemoryTenantThrottleStore,
  TenantThrottleStore,
} from '../services/tenant-throttle-store';

export class TenantThrottlerProvider implements Provider<ODataTenantThrottler> {
  private readonly windowMs = 60_000;
  private readonly store: TenantThrottleStore;

  constructor(
    @inject(ODATA_BINDINGS.CONFIG) private readonly config: ODataConfig,
    @inject(ODATA_BINDINGS.LOGGER, { optional: true })
    private readonly logger?: ODataLogger,
    @inject(ODATA_BINDINGS.THROTTLE_STORE, { optional: true })
    store?: TenantThrottleStore,
  ) {
    this.store = store ?? new InMemoryTenantThrottleStore(this.windowMs);
  }

  value(): ODataTenantThrottler {
    return {
      check: async (tenant, context) => this.check(tenant, context),
      release: (tenant) => {
        this.releaseTenant(tenant).catch((error) => {
          this.logStoreError('release', tenant, error);
        });
      },
    };
  }

  private getLimits(tenant: string) {
    const cfg = this.config.tenantQuotas;
    if (!cfg) {
      return { maxRequestsPerMinute: undefined, maxConcurrentRequests: undefined };
    }
    const override = cfg.overrides?.[tenant] ?? {};
    return {
      maxRequestsPerMinute: override.maxRequestsPerMinute ?? cfg.maxRequestsPerMinute,
      maxConcurrentRequests: override.maxConcurrentRequests ?? cfg.maxConcurrentRequests,
    };
  }

  async check(tenant: string, context?: ODataTenantThrottleContext) {
    const limits = this.getLimits(tenant);
    if (!limits.maxRequestsPerMinute && !limits.maxConcurrentRequests) return;

    if (limits.maxRequestsPerMinute) {
      const rate = await this.store.incrementRate(
        tenant,
        this.windowMs,
        limits.maxRequestsPerMinute,
      );
      if (rate.limited) {
        this.emitThrottleLog(
          tenant,
          'rate',
          limits.maxRequestsPerMinute,
          {
            hits: rate.hits,
            windowResetMs: rate.windowResetMs,
          },
          context,
          { requestedHits: rate.hits + 1 },
        );
        throw new Error('tenant-rate-limit-exceeded');
      }
    }

    const concurrent = await this.store.acquireConcurrent(tenant, limits.maxConcurrentRequests);
    if (concurrent.limited) {
      this.emitThrottleLog(
        tenant,
        'concurrent',
        limits.maxConcurrentRequests,
        {
          concurrent: concurrent.concurrent,
        },
        context,
        { requestedConcurrent: concurrent.concurrent + 1 },
      );
      throw new Error('tenant-concurrent-limit-exceeded');
    }
  }

  private async releaseTenant(tenant: string) {
    await this.store.releaseConcurrent(tenant);
  }

  private emitThrottleLog(
    tenant: string,
    limitType: 'rate' | 'concurrent',
    limit: number | undefined,
    stats: { hits?: number; concurrent?: number; windowResetMs?: number },
    context?: ODataTenantThrottleContext,
    extras?: { requestedHits?: number; requestedConcurrent?: number },
  ) {
    if (!this.logger) return;
    this.logger.warn('Tenant throttle limit exceeded', {
      event: 'tenant-throttle',
      tenantId: tenant,
      limitType,
      limit,
      hits: stats.hits,
      concurrent: stats.concurrent,
      windowResetMs: stats.windowResetMs,
      ...extras,
      ...(context ?? {}),
      correlationId: context?.correlationId,
    });
  }

  private logStoreError(action: string, tenant: string, error: unknown) {
    if (!this.logger) return;
    const err = error instanceof Error ? error : new Error(String(error));
    this.logger.error(
      'Tenant throttle store error',
      {
        event: 'tenant-throttle-store-error',
        action,
        tenantId: tenant,
      },
      err,
    );
  }
}

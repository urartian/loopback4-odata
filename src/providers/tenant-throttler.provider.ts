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
  private readonly activeTenants = new Map<string, { count: number; timer?: NodeJS.Timeout }>();

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
    this.incrementActiveTenant(tenant);
  }

  private async releaseTenant(tenant: string) {
    await this.store.releaseConcurrent(tenant);
    this.decrementActiveTenant(tenant);
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

  private incrementActiveTenant(tenant: string) {
    if (typeof this.store.refreshConcurrentLease !== 'function') return;
    const entry = this.activeTenants.get(tenant) ?? { count: 0 };
    entry.count += 1;
    if (entry.count === 1) {
      entry.timer = this.startLeaseTimer(tenant);
    }
    this.activeTenants.set(tenant, entry);
  }

  private decrementActiveTenant(tenant: string) {
    if (typeof this.store.refreshConcurrentLease !== 'function') return;
    const entry = this.activeTenants.get(tenant);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count === 0) {
      if (entry.timer) {
        clearInterval(entry.timer);
      }
      this.activeTenants.delete(tenant);
    } else {
      this.activeTenants.set(tenant, entry);
    }
  }

  private startLeaseTimer(tenant: string): NodeJS.Timeout | undefined {
    const refreshFn = this.store.refreshConcurrentLease;
    if (typeof refreshFn !== 'function') return undefined;
    const interval = this.getLeaseRefreshInterval();
    const timer = setInterval(() => {
      refreshFn
        .call(this.store, tenant)
        .catch((error: unknown) => this.logStoreError('refresh', tenant, error));
    }, interval);
    timer.unref?.();
    return timer;
  }

  private getLeaseRefreshInterval(): number {
    const ttl = this.store.getConcurrentLeaseDuration?.();
    const base = ttl && ttl > 0 ? ttl : 120_000;
    const half = Math.floor(base / 2);
    return Math.max(5_000, Math.min(half, base - 1_000));
  }
}

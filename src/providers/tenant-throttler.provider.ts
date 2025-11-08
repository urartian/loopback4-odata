import { inject, Provider } from '@loopback/core';
import { ODATA_BINDINGS, ODataTenantThrottler } from '../keys';
import { ODataConfig, ODataTenantQuotaConfig } from '../types';

interface TenantCounters {
  windowStart: number;
  hits: number;
  concurrent: number;
}

export class TenantThrottlerProvider implements Provider<ODataTenantThrottler> {
  private readonly counters = new Map<string, TenantCounters>();
  private readonly windowMs = 60_000;
  private lastCleanup = 0;
  private cleanupHandle?: NodeJS.Timeout;

  constructor(@inject(ODATA_BINDINGS.CONFIG) private readonly config: ODataConfig) {
    if (config.tenantQuotas) {
      this.cleanupHandle = setInterval(() => this.pruneCounters(Date.now(), true), this.windowMs);
      this.cleanupHandle.unref?.();
    }
  }

  value(): ODataTenantThrottler {
    return {
      check: async (tenant) => this.check(tenant),
      release: (tenant) => this.releaseTenant(tenant),
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

  async check(tenant: string) {
    this.checkTenant(tenant);
  }

  private checkTenant(tenant: string) {
    const limits = this.getLimits(tenant);
    if (!limits.maxRequestsPerMinute && !limits.maxConcurrentRequests) return;
    const now = Date.now();
    this.pruneCounters(now);
    const counter = this.counters.get(tenant) ?? {
      windowStart: now,
      hits: 0,
      concurrent: 0,
    };
    if (now - counter.windowStart >= this.windowMs) {
      counter.windowStart = now;
      counter.hits = 0;
    }
    const nextHits = counter.hits + 1;
    if (limits.maxRequestsPerMinute && nextHits > limits.maxRequestsPerMinute) {
      throw new Error('tenant-rate-limit-exceeded');
    }
    if (limits.maxConcurrentRequests && counter.concurrent >= limits.maxConcurrentRequests) {
      throw new Error('tenant-concurrent-limit-exceeded');
    }

    counter.hits = nextHits;
    counter.concurrent += 1;
    this.counters.set(tenant, counter);
  }

  private releaseTenant(tenant: string) {
    const counter = this.counters.get(tenant);
    if (!counter) return;
    counter.concurrent = Math.max(0, counter.concurrent - 1);
    const now = Date.now();
    if (counter.concurrent === 0 && now - counter.windowStart >= this.windowMs) {
      this.counters.delete(tenant);
      return;
    }
    this.pruneCounters(now);
  }

  private pruneCounters(now: number, force = false) {
    if (!this.counters.size) return;
    if (!force && now - this.lastCleanup < this.windowMs) return;
    this.lastCleanup = now;
    for (const [tenant, counter] of this.counters) {
      if (counter.concurrent === 0 && now - counter.windowStart >= this.windowMs) {
        this.counters.delete(tenant);
      }
    }
  }
}

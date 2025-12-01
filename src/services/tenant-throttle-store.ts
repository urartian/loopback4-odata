export interface TenantThrottleRateResult {
  limited: boolean;
  hits: number;
  windowStart: number;
  windowResetMs: number;
}

export interface TenantThrottleConcurrentResult {
  limited: boolean;
  concurrent: number;
}

export interface TenantThrottleStore {
  incrementRate(
    tenant: string,
    windowMs: number,
    limit?: number,
  ): Promise<TenantThrottleRateResult>;
  acquireConcurrent(tenant: string, limit?: number): Promise<TenantThrottleConcurrentResult>;
  releaseConcurrent(tenant: string): Promise<number>;
  refreshConcurrentLease?(tenant: string): Promise<void>;
  getConcurrentLeaseDuration?(): number | undefined;
}

interface TenantState {
  windowStart: number;
  windowMs: number;
  hits: number;
  concurrent: number;
}

export class InMemoryTenantThrottleStore implements TenantThrottleStore {
  private readonly states = new Map<string, TenantState>();
  private lastCleanup = 0;

  constructor(private readonly defaultWindowMs = 60_000) {}

  async incrementRate(
    tenant: string,
    windowMs: number,
    limit?: number,
  ): Promise<TenantThrottleRateResult> {
    const now = Date.now();
    const state = this.ensureState(tenant, now, windowMs);
    this.prune(now, windowMs);

    if (now - state.windowStart >= windowMs) {
      state.windowStart = now;
      state.hits = 0;
    }
    const nextHits = state.hits + 1;
    if (limit && limit > 0 && nextHits > limit) {
      return {
        limited: true,
        hits: state.hits,
        windowStart: state.windowStart,
        windowResetMs: Math.max(0, state.windowStart + windowMs - now),
      };
    }
    state.hits = nextHits;
    state.windowMs = windowMs;
    return {
      limited: false,
      hits: state.hits,
      windowStart: state.windowStart,
      windowResetMs: Math.max(0, state.windowStart + windowMs - now),
    };
  }

  async acquireConcurrent(tenant: string, limit?: number): Promise<TenantThrottleConcurrentResult> {
    const now = Date.now();
    const state = this.ensureState(tenant, now, this.defaultWindowMs);
    this.prune(now, state.windowMs);

    if (limit && limit > 0 && state.concurrent >= limit) {
      return { limited: true, concurrent: state.concurrent };
    }
    state.concurrent += 1;
    return { limited: false, concurrent: state.concurrent };
  }

  async releaseConcurrent(tenant: string): Promise<number> {
    const state = this.states.get(tenant);
    if (!state) return 0;
    state.concurrent = Math.max(0, state.concurrent - 1);
    const now = Date.now();
    this.prune(now, state.windowMs);
    if (state.concurrent === 0 && now - state.windowStart >= state.windowMs) {
      this.states.delete(tenant);
      return 0;
    }
    return state.concurrent;
  }

  private ensureState(tenant: string, now: number, windowMs: number): TenantState {
    const existing = this.states.get(tenant);
    if (existing) return existing;
    const created: TenantState = {
      windowStart: now,
      windowMs,
      hits: 0,
      concurrent: 0,
    };
    this.states.set(tenant, created);
    return created;
  }

  private prune(now: number, windowMs: number) {
    if (!this.states.size) return;
    if (now - this.lastCleanup < windowMs) return;
    this.lastCleanup = now;
    for (const [tenant, state] of this.states) {
      if (state.concurrent === 0 && now - state.windowStart >= state.windowMs) {
        this.states.delete(tenant);
      }
    }
  }
}

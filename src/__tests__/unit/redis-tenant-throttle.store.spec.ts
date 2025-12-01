import { expect } from '@loopback/testlab';
import {
  CONCURRENCY_SCRIPT,
  RATE_SCRIPT,
  RELEASE_SCRIPT,
  RedisScriptExecutor,
  RedisTenantThrottleStore,
} from '../../services/redis-tenant-throttle.store';

type ScriptType = 'rate' | 'concurrent' | 'release';

type StoredState = { windowStart: number; hits: number; concurrent: number; ttl: number | null };

class FakeRedisClient implements RedisScriptExecutor {
  private readonly storage = new Map<string, StoredState>();
  private readonly scripts = new Map<string, ScriptType>();
  private seq = 0;

  async script(subcommand: 'LOAD' | 'load', script: string): Promise<string> {
    if (subcommand.toLowerCase() !== 'load') {
      throw new Error('Unsupported subcommand');
    }
    const type = this.detectScriptType(script);
    const sha = `sha-${this.seq++}-${type}`;
    this.scripts.set(sha, type);
    return sha;
  }

  async evalsha(sha: string, keyCount: number, ...args: Array<string | number>): Promise<unknown> {
    const type = this.scripts.get(sha);
    if (!type) {
      throw Object.assign(new Error('NOSCRIPT'), { message: 'NOSCRIPT' });
    }
    return this.run(
      type,
      args[0] as string,
      keyCount,
      args.slice(1).map((v) => Number(v)),
    );
  }

  async eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown> {
    const type = this.detectScriptType(script);
    return this.run(
      type,
      args[0] as string,
      keyCount,
      args.slice(1).map((v) => Number(v)),
    );
  }

  getState(key: string): StoredState | undefined {
    const state = this.storage.get(key);
    if (!state) return undefined;
    return { ...state };
  }

  private detectScriptType(script: string): ScriptType {
    const normalized = script.trim();
    if (normalized === RATE_SCRIPT.trim()) return 'rate';
    if (normalized === CONCURRENCY_SCRIPT.trim()) return 'concurrent';
    if (normalized === RELEASE_SCRIPT.trim()) return 'release';
    throw new Error('Unknown script');
  }

  private run(type: ScriptType, key: string, keyCount: number, args: number[]): number[] {
    const state = this.storage.get(key) ?? { windowStart: 0, hits: 0, concurrent: 0, ttl: null };
    this.storage.set(key, state);
    if (type === 'rate') {
      const [now, windowMs, limit, ttl] = args;
      if (now - state.windowStart >= windowMs || state.windowStart === 0) {
        state.windowStart = now;
        state.hits = 0;
      }
      const nextHits = state.hits + 1;
      if (limit > 0 && nextHits > limit) {
        this.applyTtl(state, ttl);
        return [
          state.hits,
          state.windowStart,
          Math.max(0, state.windowStart + windowMs - now),
          state.concurrent,
          1,
        ];
      }
      state.hits = nextHits;
      this.applyTtl(state, ttl);
      return [
        state.hits,
        state.windowStart,
        Math.max(0, state.windowStart + windowMs - now),
        state.concurrent,
        0,
      ];
    }
    if (type === 'concurrent') {
      const [limit, ttl, now] = args;
      if (state.windowStart === 0) state.windowStart = now;
      if (limit > 0 && state.concurrent >= limit) {
        this.applyTtl(state, ttl);
        return [state.windowStart, state.hits, state.concurrent, 1];
      }
      state.concurrent += 1;
      this.applyTtl(state, ttl);
      return [state.windowStart, state.hits, state.concurrent, 0];
    }
    if (type === 'release') {
      const [ttl] = args;
      state.concurrent = Math.max(0, state.concurrent - 1);
      this.applyTtl(state, ttl);
      return [state.concurrent];
    }
    throw new Error('Unknown script type');
  }

  private applyTtl(state: StoredState, ttl: number) {
    if (state.concurrent > 0) {
      state.ttl = null;
    } else {
      state.ttl = ttl;
    }
  }
}

describe('RedisTenantThrottleStore', () => {
  it('enforces rate limits across calls', async () => {
    const store = new RedisTenantThrottleStore(new FakeRedisClient());
    const first = await store.incrementRate('tenant', 60_000, 1);
    expect(first.limited).to.be.false();
    const second = await store.incrementRate('tenant', 60_000, 1);
    expect(second.limited).to.be.true();
  });

  it('tracks concurrent usage atomically', async () => {
    const store = new RedisTenantThrottleStore(new FakeRedisClient());
    const first = await store.acquireConcurrent('tenant', 2);
    expect(first.concurrent).to.equal(1);
    const second = await store.acquireConcurrent('tenant', 2);
    expect(second.concurrent).to.equal(2);
    const limited = await store.acquireConcurrent('tenant', 2);
    expect(limited.limited).to.be.true();
    await store.releaseConcurrent('tenant');
    const afterRelease = await store.acquireConcurrent('tenant', 2);
    expect(afterRelease.concurrent).to.equal(2);
  });

  it('keeps concurrency keys alive while requests are active', async () => {
    const client = new FakeRedisClient();
    const ttlMs = 5000;
    const store = new RedisTenantThrottleStore(client, { minTtlMs: ttlMs });
    await store.acquireConcurrent('tenant', 2);
    const key = 'odata:tenant-throttle:tenant';
    expect(client.getState(key)?.ttl).to.equal(null);
    await store.incrementRate('tenant', 60_000, 10);
    expect(client.getState(key)?.ttl).to.equal(null);
    await store.releaseConcurrent('tenant');
    expect(client.getState(key)?.ttl).to.equal(ttlMs);
  });

  it('refreshes expiry only after the last request completes', async () => {
    const client = new FakeRedisClient();
    const ttlMs = 8000;
    const store = new RedisTenantThrottleStore(client, { minTtlMs: ttlMs });
    await store.acquireConcurrent('tenant', 2);
    await store.acquireConcurrent('tenant', 2);
    const key = 'odata:tenant-throttle:tenant';
    await store.releaseConcurrent('tenant');
    expect(client.getState(key)?.ttl).to.equal(null);
    await store.releaseConcurrent('tenant');
    expect(client.getState(key)?.ttl).to.equal(ttlMs);
  });
});

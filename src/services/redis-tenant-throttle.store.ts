import {
  TenantThrottleConcurrentResult,
  TenantThrottleRateResult,
  TenantThrottleStore,
} from './tenant-throttle-store';

export interface RedisScriptExecutor {
  evalsha(sha: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
  script(subcommand: 'LOAD' | 'load', script: string): Promise<string>;
}

export interface RedisTenantThrottleStoreOptions {
  keyPrefix?: string;
  minTtlMs?: number;
}

export const RATE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local expireMs = tonumber(ARGV[4])
local current = redis.call('HMGET', key, 'windowStart', 'hits', 'concurrent')
local windowStart = tonumber(current[1]) or now
local hits = tonumber(current[2]) or 0
local concurrent = tonumber(current[3]) or 0

if now - windowStart >= windowMs then
  windowStart = now
  hits = 0
end

local nextHits = hits + 1
if limit > 0 and nextHits > limit then
  local windowResetMs = math.max(0, windowStart + windowMs - now)
  return {hits, windowStart, windowResetMs, concurrent, 1}
end

hits = nextHits
redis.call('HMSET', key, 'windowStart', windowStart, 'hits', hits, 'concurrent', concurrent)
redis.call('PEXPIRE', key, expireMs)
local windowResetMs = math.max(0, windowStart + windowMs - now)
return {hits, windowStart, windowResetMs, concurrent, 0}
`;

export const CONCURRENCY_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local expireMs = tonumber(ARGV[2])
local current = redis.call('HMGET', key, 'windowStart', 'hits', 'concurrent')
local windowStart = tonumber(current[1]) or 0
local hits = tonumber(current[2]) or 0
local concurrent = tonumber(current[3]) or 0

if limit > 0 and concurrent >= limit then
  return {windowStart, hits, concurrent, 1}
end

concurrent = concurrent + 1
if windowStart == 0 then
  windowStart = ARGV[3]
end
redis.call('HMSET', key, 'windowStart', windowStart, 'hits', hits, 'concurrent', concurrent)
redis.call('PEXPIRE', key, expireMs)
return {windowStart, hits, concurrent, 0}
`;

export const RELEASE_SCRIPT = `
local key = KEYS[1]
local current = redis.call('HMGET', key, 'concurrent')
local concurrent = tonumber(current[1]) or 0
if concurrent <= 0 then
  return 0
end
concurrent = math.max(0, concurrent - 1)
redis.call('HSET', key, 'concurrent', concurrent)
return concurrent
`;

export class RedisTenantThrottleStore implements TenantThrottleStore {
  private rateSha?: string;
  private concurrentSha?: string;
  private releaseSha?: string;

  constructor(
    private readonly client: RedisScriptExecutor,
    private readonly options: RedisTenantThrottleStoreOptions = {},
  ) {}

  async incrementRate(
    tenant: string,
    windowMs: number,
    limit?: number,
  ): Promise<TenantThrottleRateResult> {
    const now = Date.now();
    const ttl = Math.max(this.options.minTtlMs ?? windowMs * 2, windowMs);
    const limitValue = limit && limit > 0 ? limit : 0;
    const [hits, windowStart, windowResetMs, , limited] = await this.execScript(
      'rate',
      [this.key(tenant)],
      [now, windowMs, limitValue, ttl],
    );
    return {
      hits,
      windowStart,
      windowResetMs,
      limited: Boolean(limited),
    };
  }

  async acquireConcurrent(tenant: string, limit?: number): Promise<TenantThrottleConcurrentResult> {
    const ttl = Math.max(this.options.minTtlMs ?? this.defaultTtl(), this.defaultTtl());
    const limitValue = limit && limit > 0 ? limit : 0;
    const now = Date.now();
    const [, , concurrent, limited] = await this.execScript(
      'concurrent',
      [this.key(tenant)],
      [limitValue, ttl, now],
    );
    return {
      concurrent,
      limited: Boolean(limited),
    };
  }

  async releaseConcurrent(tenant: string): Promise<number> {
    const [concurrent] = await this.execScript('release', [this.key(tenant)], []);
    return concurrent;
  }

  private key(tenant: string) {
    return `${this.options.keyPrefix ?? 'odata:tenant-throttle:'}${tenant}`;
  }

  private defaultTtl() {
    return this.options.minTtlMs ?? 120_000;
  }

  private async execScript(
    type: 'rate' | 'concurrent' | 'release',
    keys: string[],
    args: Array<number>,
  ): Promise<[number, number, number, number, number?]> {
    const sha = await this.ensureSha(type);
    const keyCount = keys.length;
    const keyArgs = keys;
    const argStrings = args.map((value) => value.toString());
    try {
      const result = await this.client.evalsha(sha, keyCount, ...keyArgs, ...argStrings);
      return (Array.isArray(result) ? result : [result]).map((value) => Number(value ?? 0)) as [
        number,
        number,
        number,
        number,
        number?,
      ];
    } catch (error) {
      if (this.isNoScriptError(error)) {
        this.clearSha(type);
        const script = this.getScript(type);
        const freshSha = await this.client.script('LOAD', script);
        this.storeSha(type, freshSha);
        const result = await this.client.evalsha(freshSha, keyCount, ...keyArgs, ...argStrings);
        return (Array.isArray(result) ? result : [result]).map((value) => Number(value ?? 0)) as [
          number,
          number,
          number,
          number,
          number?,
        ];
      }
      throw error;
    }
  }

  private async ensureSha(type: 'rate' | 'concurrent' | 'release'): Promise<string> {
    const existing = this.getSha(type);
    if (existing) return existing;
    const script = this.getScript(type);
    const sha = await this.client.script('LOAD', script);
    this.storeSha(type, sha);
    return sha;
  }

  private getSha(type: 'rate' | 'concurrent' | 'release') {
    if (type === 'rate') return this.rateSha;
    if (type === 'concurrent') return this.concurrentSha;
    return this.releaseSha;
  }

  private storeSha(type: 'rate' | 'concurrent' | 'release', sha: string) {
    if (type === 'rate') this.rateSha = sha;
    else if (type === 'concurrent') this.concurrentSha = sha;
    else this.releaseSha = sha;
  }

  private clearSha(type: 'rate' | 'concurrent' | 'release') {
    if (type === 'rate') this.rateSha = undefined;
    else if (type === 'concurrent') this.concurrentSha = undefined;
    else this.releaseSha = undefined;
  }

  private getScript(type: 'rate' | 'concurrent' | 'release') {
    if (type === 'rate') return RATE_SCRIPT;
    if (type === 'concurrent') return CONCURRENCY_SCRIPT;
    return RELEASE_SCRIPT;
  }

  private isNoScriptError(error: unknown) {
    if (!error) return false;
    const message = (error as { message?: string }).message ?? '';
    return message.includes('NOSCRIPT');
  }
}

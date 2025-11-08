import { expect, sinon } from '@loopback/testlab';
import { InMemoryTenantThrottleStore } from '../../services/tenant-throttle-store';

describe('InMemoryTenantThrottleStore', () => {
  it('resets hit counters after the window expires', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const store = new InMemoryTenantThrottleStore(60_000);
      await store.incrementRate('tenant', 60_000, 10);
      clock.tick(61_000);
      const result = await store.incrementRate('tenant', 60_000, 10);
      expect(result.hits).to.equal(1);
    } finally {
      clock.restore();
    }
  });

  it('enforces rate limits without mutating counters when rejected', async () => {
    const store = new InMemoryTenantThrottleStore(60_000);
    await store.incrementRate('tenant', 60_000, 1);
    const result = await store.incrementRate('tenant', 60_000, 1);
    expect(result.limited).to.be.true();
    expect(result.hits).to.equal(1);
  });

  it('tracks concurrent usage and releases gracefully', async () => {
    const store = new InMemoryTenantThrottleStore(60_000);
    await store.acquireConcurrent('tenant', 2);
    await store.acquireConcurrent('tenant', 2);
    const limited = await store.acquireConcurrent('tenant', 2);
    expect(limited.limited).to.be.true();
    expect(limited.concurrent).to.equal(2);
    await store.releaseConcurrent('tenant');
    const afterRelease = await store.acquireConcurrent('tenant', 2);
    expect(afterRelease.concurrent).to.equal(2);
  });

  it('evicts idle tenants when the window expires and concurrency drops to zero', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const store = new InMemoryTenantThrottleStore(60_000);
      await store.incrementRate('tenant', 60_000, 10);
      await store.acquireConcurrent('tenant', 1);
      await store.releaseConcurrent('tenant');
      clock.tick(61_000);
      const result = await store.incrementRate('tenant', 60_000, 10);
      expect(result.hits).to.equal(1);
    } finally {
      clock.restore();
    }
  });
});

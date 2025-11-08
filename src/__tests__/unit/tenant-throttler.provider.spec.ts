import { expect, sinon } from '@loopback/testlab';
import { TenantThrottlerProvider } from '../../providers/tenant-throttler.provider';
import { ODataConfig } from '../../types';

describe('TenantThrottlerProvider', () => {
  it('does nothing when tenantQuotas are not configured', async () => {
    const provider = new TenantThrottlerProvider({} as ODataConfig);
    const throttler = provider.value();
    for (let i = 0; i < 10; i++) {
      await throttler.check('default');
      throttler.release('default');
    }
  });

  it('enforces maxRequestsPerMinute', async () => {
    const provider = new TenantThrottlerProvider({
      tenantQuotas: { maxRequestsPerMinute: 1 },
    } as ODataConfig);
    const throttler = provider.value();
    await throttler.check('tenant');
    await expect(throttler.check('tenant')).to.be.rejectedWith(/tenant-rate-limit-exceeded/);
  });

  it('enforces maxConcurrentRequests and releases after completion', async () => {
    const provider = new TenantThrottlerProvider({
      tenantQuotas: { maxConcurrentRequests: 1 },
    } as ODataConfig);
    const throttler = provider.value();
    await throttler.check('tenant');
    await expect(
      (async () => {
        await throttler.check('tenant');
      })(),
    ).to.be.rejectedWith(/tenant-concurrent-limit-exceeded/);
    throttler.release('tenant');
    await throttler.check('tenant');
  });

  it('evicts stale tenant counters once the window elapses with no activity', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const provider = new TenantThrottlerProvider({
        tenantQuotas: { maxRequestsPerMinute: 10 },
      } as ODataConfig);
      const throttler = provider.value();

      await throttler.check('orphan');
      throttler.release('orphan');
      expect(provider['counters'].has('orphan')).to.be.true();

      clock.tick(61_000);

      await throttler.check('new-tenant');
      throttler.release('new-tenant');

      expect(provider['counters'].has('orphan')).to.be.false();
    } finally {
      clock.restore();
    }
  });
});

import { expect, sinon } from '@loopback/testlab';
import { TenantThrottlerProvider } from '../../providers/tenant-throttler.provider';
import { ODataConfig } from '../../types';
import { ODataLogger } from '../../keys';
import { TenantThrottleStore } from '../../services/tenant-throttle-store';

const noopLogger: ODataLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('TenantThrottlerProvider', () => {
  it('does nothing when tenantQuotas are not configured', async () => {
    const provider = new TenantThrottlerProvider({} as ODataConfig, noopLogger);
    const throttler = provider.value();
    for (let i = 0; i < 10; i++) {
      await throttler.check('default');
      throttler.release('default');
    }
  });

  it('enforces maxRequestsPerMinute', async () => {
    const provider = new TenantThrottlerProvider(
      {
        tenantQuotas: { maxRequestsPerMinute: 1 },
      } as ODataConfig,
      noopLogger,
    );
    const throttler = provider.value();
    await throttler.check('tenant');
    await expect(throttler.check('tenant')).to.be.rejectedWith(/tenant-rate-limit-exceeded/);
  });

  it('enforces maxConcurrentRequests and releases after completion', async () => {
    const provider = new TenantThrottlerProvider(
      {
        tenantQuotas: { maxConcurrentRequests: 1 },
      } as ODataConfig,
      noopLogger,
    );
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

  it('emits structured log entries when throttling occurs', async () => {
    const warn = sinon.stub();
    const logger: ODataLogger = {
      trace() {},
      debug() {},
      info() {},
      warn,
      error() {},
    };
    const provider = new TenantThrottlerProvider(
      { tenantQuotas: { maxRequestsPerMinute: 1 } } as ODataConfig,
      logger,
    );
    const throttler = provider.value();
    await throttler.check('tenant', {
      entitySet: 'Products',
      operation: 'READ',
      method: 'GET',
      url: '/odata/Products',
      requestId: 'req-1',
    });
    await expect(
      throttler.check('tenant', {
        entitySet: 'Products',
        operation: 'READ',
        method: 'GET',
        url: '/odata/Products',
        requestId: 'req-2',
      }),
    ).to.be.rejectedWith(/tenant-rate-limit-exceeded/);
    expect(warn.called).to.be.true();
    const logContext = warn.getCall(0).args[1];
    expect(logContext).to.containDeep({
      event: 'tenant-throttle',
      tenantId: 'tenant',
      limitType: 'rate',
      entitySet: 'Products',
      operation: 'READ',
      method: 'GET',
    });
  });

  it('logs store failures when release throws', async () => {
    const error = sinon.stub();
    const logger: ODataLogger = {
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error,
    };
    const store: TenantThrottleStore = {
      incrementRate: async () => ({
        limited: false,
        hits: 0,
        windowStart: Date.now(),
        windowResetMs: 0,
      }),
      acquireConcurrent: async () => ({ limited: false, concurrent: 0 }),
      releaseConcurrent: async () => {
        throw new Error('release-failed');
      },
    };
    const provider = new TenantThrottlerProvider(
      { tenantQuotas: { maxConcurrentRequests: 1 } } as ODataConfig,
      logger,
      store,
    );
    const throttler = provider.value();
    throttler.release('tenant-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(error.called).to.be.true();
    expect(error.getCall(0).args[1]).to.containDeep({
      event: 'tenant-throttle-store-error',
      action: 'release',
      tenantId: 'tenant-1',
    });
  });

  it('starts only one lease timer per tenant and clears it on release', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const store = buildLeaseAwareStore();
      const provider = new TenantThrottlerProvider(
        { tenantQuotas: { maxConcurrentRequests: 5 } } as ODataConfig,
        noopLogger,
        store,
      );
      const throttler = provider.value();
      await throttler.check('tenant-1');
      expect(getLeaseTimerCount(provider)).to.equal(1);
      await throttler.check('tenant-1');
      expect(getLeaseTimerCount(provider)).to.equal(1);
      await (provider as unknown as { releaseTenant(tenant: string): Promise<void> }).releaseTenant(
        'tenant-1',
      );
      expect(getLeaseTimerCount(provider)).to.equal(1);
      await (provider as unknown as { releaseTenant(tenant: string): Promise<void> }).releaseTenant(
        'tenant-1',
      );
      expect(getLeaseTimerCount(provider)).to.equal(0);
    } finally {
      clock.restore();
    }
  });

  it('rejects new tenants when lease refresher cap is exceeded and releases the slot', async () => {
    const store = buildLeaseAwareStore();
    const provider = new TenantThrottlerProvider(
      {
        tenantQuotas: { maxConcurrentRequests: 5, maxLeaseRefreshers: 1 },
      } as ODataConfig,
      noopLogger,
      store,
    );
    const throttler = provider.value();
    await throttler.check('tenant-a');
    await expect(throttler.check('tenant-b')).to.be.rejectedWith(
      /tenant-lease-refreshers-exhausted/,
    );
    throttler.release('tenant-a');
    await nextTick();
  });
});

function buildLeaseAwareStore(refreshStub?: sinon.SinonStub): TenantThrottleStore {
  const concurrentCounts = new Map<string, number>();
  return {
    incrementRate: async () => ({
      limited: false,
      hits: 0,
      windowStart: Date.now(),
      windowResetMs: 0,
    }),
    acquireConcurrent: async (tenant: string) => {
      const current = concurrentCounts.get(tenant) ?? 0;
      const next = current + 1;
      concurrentCounts.set(tenant, next);
      return { limited: false, concurrent: next };
    },
    releaseConcurrent: async (tenant: string) => {
      const current = concurrentCounts.get(tenant) ?? 0;
      const next = Math.max(0, current - 1);
      concurrentCounts.set(tenant, next);
      return next;
    },
    refreshConcurrentLease: async (tenant: string) => {
      await refreshStub?.(tenant);
    },
    getConcurrentLeaseDuration: () => 8_000,
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function getLeaseTimerCount(provider: TenantThrottlerProvider): number {
  return (provider as unknown as { activeLeaseTimerCount: number }).activeLeaseTimerCount;
}

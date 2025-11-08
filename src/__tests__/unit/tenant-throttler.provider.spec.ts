import { expect, sinon } from '@loopback/testlab';
import { TenantThrottlerProvider } from '../../providers/tenant-throttler.provider';
import { ODataConfig } from '../../types';
import { ODataLogger } from '../../keys';

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

  it('evicts stale tenant counters once the window elapses with no activity', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const provider = new TenantThrottlerProvider(
        {
          tenantQuotas: { maxRequestsPerMinute: 10 },
        } as ODataConfig,
        noopLogger,
      );
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
});

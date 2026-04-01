import { AnyObject, juggler } from '@loopback/repository';
import { ODataApplyExecutor, ODataApplyExecutorContext, ODataApplyExecutorRegistry } from '../../src/services/odata-apply-executor.registry';
import { ODATA_BINDINGS } from '../../src/keys';
import { createServerEnvironment, bindSingleton, stopServerEnvironment } from '../lib/app';
import { BenchScenario } from '../types';

class MemoryBenchmarkApplyExecutor implements ODataApplyExecutor {
  readonly id = 'benchmark-memory-executor';

  supports(dataSource: juggler.DataSource): boolean {
    const connectorName = (dataSource.connector as AnyObject | undefined)?.name;
    return connectorName === 'memory';
  }

  async execute(ctx: ODataApplyExecutorContext) {
    const rows = await ctx.repository.find(ctx.fetchFilter, ctx.options);
    const buckets = new Map<number, number>();

    for (const row of rows) {
      const price = Number((row as AnyObject).price);
      if (Number.isFinite(price) && price > 200) {
        buckets.set(price, (buckets.get(price) ?? 0) + 1);
      }
    }

    const result = Array.from(buckets.entries())
      .map(([price, productCount]) => ({ price, ProductCount: productCount }))
      .sort((left, right) => right.ProductCount - left.ProductCount || left.price - right.price)
      .slice(0, 10);

    return { rows: result, appliedOrder: true, appliedPipelinePagination: true };
  }
}

export const applyExecutorScenario: BenchScenario = {
  name: 'apply-executor',
  description: '$apply through the executor path for comparison with fallback mode',
  setup(options) {
    return createServerEnvironment(options, {
      config: {
        enableApplyPushdown: true,
        capabilities: {
          aggregation: true,
          applySupported: true,
        },
      },
      configureApp(app) {
        bindSingleton(app, ODATA_BINDINGS.APPLY_EXECUTOR_REGISTRY, () => {
          const registry = new ODataApplyExecutorRegistry();
          registry.register(new MemoryBenchmarkApplyExecutor());
          return registry;
        });
      },
    });
  },
  async run(env) {
    const client = env.client;
    if (!client) {
      throw new Error('$apply executor benchmark requires a REST client.');
    }

    await client
      .get('/odata/Products')
      .query({
        $apply:
          'filter(price gt 200)/groupby((price),aggregate(id with count as ProductCount))/orderby(ProductCount desc)/top(10)',
      })
      .expect(200);
  },
  cleanup: stopServerEnvironment,
};

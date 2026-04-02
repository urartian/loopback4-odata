import { createServerEnvironment, stopServerEnvironment } from '../lib/app';
import { BenchScenario } from '../types';

export const applyPostgresScenario: BenchScenario = {
  name: 'apply-postgres',
  description: 'Real Postgres $apply pushdown for comparison with the fallback path',
  setup(options) {
    if (options.database !== 'postgres') {
      throw new Error(
        'The apply-postgres scenario requires --database=postgres and a disposable Postgres benchmark database.',
      );
    }

    return createServerEnvironment(options, {
      config: {
        enableApplyPushdown: true,
        capabilities: {
          aggregation: true,
          applySupported: true,
        },
      },
    });
  },
  async run(env) {
    const client = env.client;
    if (!client) {
      throw new Error('Postgres $apply benchmark requires a REST client.');
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

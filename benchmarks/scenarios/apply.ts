import { createServerEnvironment, stopServerEnvironment } from '../lib/app';
import { BenchScenario } from '../types';

export const applyScenario: BenchScenario = {
  name: 'apply',
  description: '$apply aggregation with filter, groupby, orderby, and top',
  setup: createServerEnvironment,
  async run(env) {
    const client = env.client;
    if (!client) {
      throw new Error('$apply benchmark requires a REST client.');
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

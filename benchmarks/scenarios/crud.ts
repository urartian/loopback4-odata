import { createServerEnvironment, stopServerEnvironment } from '../lib/app';
import { BenchScenario } from '../types';

export const crudScenario: BenchScenario = {
  name: 'crud',
  description: 'Collection reads with filtering, ordering, and paging',
  setup: createServerEnvironment,
  async run(env) {
    const client = env.client;
    if (!client) {
      throw new Error('CRUD benchmark requires a REST client.');
    }

    await client
      .get('/odata/Products')
      .query({
        $filter: 'price gt 200',
        $orderby: 'id desc',
        $top: '50',
      })
      .expect(200);
  },
  cleanup: stopServerEnvironment,
};

import { createServerEnvironment, stopServerEnvironment } from '../lib/app';
import { BenchScenario } from '../types';

export const batchScenario: BenchScenario = {
  name: 'batch',
  description: 'JSON $batch request with multiple read-only sub-requests',
  setup: createServerEnvironment,
  async run(env) {
    const client = env.client;
    if (!client) {
      throw new Error('$batch benchmark requires a REST client.');
    }

    const response = await client
      .post('/odata/$batch')
      .send({
        requests: [
          { id: 'products', method: 'GET', url: '/odata/Products?$top=20' },
          { id: 'count', method: 'GET', url: '/odata/Products/$count' },
          { id: 'orders', method: 'GET', url: '/odata/Orders?$top=10' },
        ],
      });

    if (response.status !== 200) {
      const body = response.body as {
        error?: { code?: string; message?: string };
        responses?: Array<{ id?: string; status?: number; body?: unknown }>;
      };

      const responseEntries = Array.isArray(body?.responses)
        ? body.responses
            .map((entry) => `${entry.id ?? 'unknown'}:${entry.status ?? 'n/a'}`)
            .join(', ')
        : 'none';

      throw new Error(
        `Batch benchmark failed with status ${response.status}. ` +
          `errorCode=${body?.error?.code ?? 'n/a'} ` +
          `errorMessage=${body?.error?.message ?? 'n/a'} ` +
          `responses=${responseEntries} ` +
          `body=${JSON.stringify(body)}`,
      );
    }
  },
  cleanup: stopServerEnvironment,
};

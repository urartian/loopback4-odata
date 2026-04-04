import {
  signDeltaToken,
  signSkipToken,
  verifyDeltaToken,
  verifySkipToken,
} from '../../src/util/token-signing';
import { BenchScenario } from '../types';

const TOKEN_SECRET = 'benchmark-secret';

export const tokensScenario: BenchScenario = {
  name: 'tokens',
  description: 'Skip/delta token signing and verification hot path',
  operationLabel: 'token actions',
  countOperations(options) {
    return options.iterations * options.concurrency * options.tokenOpsPerIteration * 4;
  },
  async setup(options) {
    return { options };
  },
  async run(env) {
    const operations = env.options.tokenOpsPerIteration;

    for (let i = 0; i < operations; i++) {
      const suffix = String(i);
      const skipToken = signSkipToken(
        {
          descriptor: 'id:ASC',
          context: 'GET:/odata/Products?$orderby=id',
          values: [suffix],
        },
        { secret: TOKEN_SECRET, ttlSeconds: 900 },
      );
      verifySkipToken(skipToken, 'id:ASC', 'GET:/odata/Products?$orderby=id', {
        secret: TOKEN_SECRET,
      });

      const deltaToken = signDeltaToken(
        {
          entitySet: 'Products',
          lastValue: suffix,
        },
        { secret: TOKEN_SECRET, ttlSeconds: 900 },
      );
      verifyDeltaToken(deltaToken, { secret: TOKEN_SECRET });
    }
  },
};

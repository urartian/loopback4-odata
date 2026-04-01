import { BindingScope } from '@loopback/core';
import { RestBindings } from '@loopback/rest';
import { createClientForHandler } from '@loopback/testlab';
import {
  ProductRepository,
  TestApplication,
  givenODataApplication,
  seedExampleData,
} from '../../src/__tests__/fixtures/odata-app.fixture';
import { ODATA_BINDINGS } from '../../src/keys';
import { ODataConfig } from '../../src/types';
import { BenchmarkEnvironment, BenchOptions } from '../types';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_SERVER_URL = `http://${DEFAULT_HOST}`;
const PRODUCT_INSERT_BATCH_SIZE = 200;

export interface ServerEnvironmentOverrides {
  config?: Partial<ODataConfig>;
  configureApp?: (app: TestApplication) => Promise<void> | void;
}

export async function createServerEnvironment(
  options: BenchOptions,
  overrides: ServerEnvironmentOverrides = {},
): Promise<BenchmarkEnvironment> {
  const app = await givenODataApplication({ host: DEFAULT_HOST, port: DEFAULT_PORT });
  app.bind(RestBindings.URL).to(DEFAULT_SERVER_URL);
  if (overrides.config) {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    app.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      ...overrides.config,
      capabilities: {
        ...(current.capabilities ?? {}),
        ...(overrides.config.capabilities ?? {}),
      },
    } as ODataConfig);
  }
  if (overrides.configureApp) {
    await overrides.configureApp(app);
  }
  await app.boot();
  await seedExampleData(app);
  await inflateProducts(app, options.datasetScale);

  return {
    options,
    app,
    client: createClientForHandler(app.requestHandler),
  };
}

export async function stopServerEnvironment(env: BenchmarkEnvironment): Promise<void> {
  if (env.app?.state === 'started') {
    await env.app.stop();
  }
}

export function bindSingleton<T>(
  app: TestApplication,
  key: string | { key: string },
  factory: () => T,
): void {
  const bindingKey = typeof key === 'string' ? key : key.key;
  app.bind(bindingKey).toDynamicValue(factory).inScope(BindingScope.SINGLETON);
}

async function inflateProducts(app: TestApplication, targetCount: number): Promise<void> {
  if (!targetCount || targetCount <= 0) return;

  const productRepo = await app.getRepository(ProductRepository);
  const existingCount = (await productRepo.count()).count;
  if (existingCount >= targetCount) return;

  let nextIndex = existingCount;
  while (nextIndex < targetCount) {
    const remaining = targetCount - nextIndex;
    const batchSize = Math.min(PRODUCT_INSERT_BATCH_SIZE, remaining);
    const products = Array.from({ length: batchSize }, (_, offset) => {
      const serial = nextIndex + offset + 1;
      return {
        name: `Benchmark Product ${serial}`,
        price: 50 + (serial % 20) * 25,
        dimensions: {
          width: 100 + (serial % 30),
          height: 10 + (serial % 12),
        },
      };
    });
    await productRepo.createAll(products);
    nextIndex += batchSize;
  }
}

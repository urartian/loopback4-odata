import { BindingScope } from '@loopback/core';
import { RestBindings } from '@loopback/rest';
import { createClientForHandler } from '@loopback/testlab';
import { juggler } from '@loopback/repository';
import {
  AppSettingsRepository,
  AssetLibraryRepository,
  BigIntAssetRepository,
  DecisionRuleRepository,
  MediaAssetRepository,
  OrderItemNoteRepository,
  OrderItemRepository,
  OrderRepository,
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
const DEFAULT_PRODUCT_INSERT_BATCH_SIZE = 200;
const LARGE_DATASET_PRODUCT_INSERT_BATCH_SIZE = 2000;
const LARGE_DATASET_THRESHOLD = 100_000;
const LARGE_DATASET_PROGRESS_INTERVAL = 100_000;
const DEFAULT_BENCHMARK_DATABASE = 'memory';

export interface ServerEnvironmentOverrides {
  config?: Partial<ODataConfig>;
  configureApp?: (app: TestApplication) => Promise<void> | void;
}

export async function createServerEnvironment(
  options: BenchOptions,
  overrides: ServerEnvironmentOverrides = {},
): Promise<BenchmarkEnvironment> {
  const app = await givenODataApplication(
    { host: DEFAULT_HOST, port: DEFAULT_PORT },
    { dataSourceConfig: resolveBenchmarkDataSourceConfig(options) },
  );
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
  await prepareBenchmarkSchema(app, options);
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

function resolveBenchmarkDataSourceConfig(
  options: BenchOptions,
): { name: string; [key: string]: unknown } {
  if (options.database === 'postgres') {
    return resolvePostgresBenchmarkDataSourceConfig();
  }
  return {
    name: 'db',
    connector: DEFAULT_BENCHMARK_DATABASE,
  };
}

function resolvePostgresBenchmarkDataSourceConfig(): { name: string; [key: string]: unknown } {
  const database = process.env.ODATA_BENCH_PG_DATABASE?.trim();
  if (!database) {
    throw new Error(
      'Postgres benchmarks require ODATA_BENCH_PG_DATABASE to point to a dedicated disposable database. The benchmark harness runs automigrate and will replace its schema.',
    );
  }

  return {
    name: 'db',
    connector: 'postgresql',
    host: readTrimmedEnv('ODATA_BENCH_PG_HOST') ?? '127.0.0.1',
    port: Number(process.env.ODATA_BENCH_PG_PORT ?? 5432),
    user: readTrimmedEnv('ODATA_BENCH_PG_USER') ?? 'postgres',
    password: process.env.ODATA_BENCH_PG_PASSWORD ?? 'pass',
    database,
    ssl: process.env.ODATA_BENCH_PG_SSL === 'true',
  };
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function prepareBenchmarkSchema(app: TestApplication, options: BenchOptions): Promise<void> {
  if (options.database !== 'postgres') return;

  await Promise.all([
    app.getRepository(ProductRepository),
    app.getRepository(OrderRepository),
    app.getRepository(OrderItemRepository),
    app.getRepository(OrderItemNoteRepository),
    app.getRepository(MediaAssetRepository),
    app.getRepository(AssetLibraryRepository),
    app.getRepository(BigIntAssetRepository),
    app.getRepository(AppSettingsRepository),
    app.getRepository(DecisionRuleRepository),
  ]);

  const dataSource = (await app.get('datasources.db')) as juggler.DataSource;
  await dataSource.automigrate();
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

  const insertBatchSize = resolveProductInsertBatchSize(targetCount);
  const shouldLogProgress = targetCount >= LARGE_DATASET_THRESHOLD;
  let nextProgressLog = Math.ceil((existingCount + 1) / LARGE_DATASET_PROGRESS_INTERVAL) *
    LARGE_DATASET_PROGRESS_INTERVAL;

  let nextIndex = existingCount;
  while (nextIndex < targetCount) {
    const remaining = targetCount - nextIndex;
    const batchSize = Math.min(insertBatchSize, remaining);
    const products = Array.from({ length: batchSize }, (_, offset) => {
      const serial = nextIndex + offset + 1;
      return {
        id: serial,
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

    if (shouldLogProgress && nextIndex >= nextProgressLog) {
      console.log(
        `Benchmark dataset seed progress: ${nextIndex.toLocaleString()} / ${targetCount.toLocaleString()} products`,
      );
      nextProgressLog += LARGE_DATASET_PROGRESS_INTERVAL;
    }
  }
}

function resolveProductInsertBatchSize(targetCount: number): number {
  const fromEnv = process.env.ODATA_BENCH_INSERT_BATCH_SIZE;
  if (fromEnv) {
    const parsed = Number(fromEnv);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (targetCount >= LARGE_DATASET_THRESHOLD) {
    return LARGE_DATASET_PRODUCT_INSERT_BATCH_SIZE;
  }

  return DEFAULT_PRODUCT_INSERT_BATCH_SIZE;
}

import { createServerEnvironment, stopServerEnvironment } from './lib/app';
import {
  forceGcIfAvailable,
  mean,
  nowMs,
  percentile,
  snapshotMemory,
  toMb,
} from './lib/stats';
import { BenchOptions } from './types';

type RequestResult = {
  durationMs: number;
  ok: boolean;
  status?: number;
  error?: string;
};

const DEFAULT_OPTIONS: BenchOptions = {
  iterations: 5,
  warmup: 1,
  concurrency: 100,
  datasetScale: 10_000,
  tokenOpsPerIteration: 5000,
  database: 'postgres',
  payloadBytes: 110 * 1024 * 1024,
};

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.database !== 'postgres') {
    throw new Error('The concurrency validation runner requires --database=postgres.');
  }

  console.log('Section 3.3 concurrency harness');
  console.log(
    `iterations=${options.iterations} warmup=${options.warmup} concurrency=${options.concurrency} datasetScale=${options.datasetScale} database=${options.database}`,
  );

  const env = await createServerEnvironment(options);
  if (!env.app) {
    throw new Error('Expected concurrency benchmark environment to include an application instance.');
  }

  try {
    await env.app.start();
    const baseUrl = env.app.restServer.url?.replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('Expected started benchmark server to expose a URL.');
    }

    for (let i = 0; i < options.warmup; i++) {
      await runWave(baseUrl, options.concurrency);
    }

    await forceGcIfAvailable();
    const memoryBefore = snapshotMemory();

    const waveDurations: number[] = [];
    const requestDurations: number[] = [];
    let successCount = 0;
    let failureCount = 0;
    const failures: RequestResult[] = [];

    const totalStart = nowMs();
    for (let i = 0; i < options.iterations; i++) {
      const waveStart = nowMs();
      const results = await runWave(baseUrl, options.concurrency);
      waveDurations.push(nowMs() - waveStart);

      for (const result of results) {
        requestDurations.push(result.durationMs);
        if (result.ok) {
          successCount += 1;
        } else {
          failureCount += 1;
          failures.push(result);
        }
      }
    }
    const totalMs = nowMs() - totalStart;

    await forceGcIfAvailable();
    const memoryAfter = snapshotMemory();

    const totalRequests = successCount + failureCount;
    const successRate = totalRequests === 0 ? 0 : (successCount / totalRequests) * 100;

    console.log('');
    console.log('concurrency - CRUD reads under concurrent load');
    console.log(`  requests: ${totalRequests}`);
    console.log(`  successes/failures: ${successCount} / ${failureCount}`);
    console.log(`  success rate: ${successRate.toFixed(2)}%`);
    console.log(`  total: ${totalMs.toFixed(1)} ms`);
    console.log(
      `  wave min/avg/max: ${Math.min(...waveDurations).toFixed(1)} / ${mean(waveDurations).toFixed(1)} / ${Math.max(...waveDurations).toFixed(1)} ms`,
    );
    console.log(
      `  request p50/p95: ${percentile(requestDurations, 0.5).toFixed(1)} / ${percentile(requestDurations, 0.95).toFixed(1)} ms`,
    );
    console.log(`  throughput: ${((totalRequests * 1000) / totalMs).toFixed(2)} requests/s`);
    console.log(
      `  memory delta (heap/rss): ${toMb(memoryAfter.heapUsed - memoryBefore.heapUsed).toFixed(2)} / ${toMb(memoryAfter.rss - memoryBefore.rss).toFixed(2)} MiB`,
    );

    if (failures.length > 0) {
      const sample = failures
        .slice(0, 5)
        .map((failure) => failure.error ?? `HTTP ${failure.status ?? 'unknown'}`)
        .join('; ');
      throw new Error(
        `Concurrency validation recorded ${failureCount} failed requests out of ${totalRequests}. Sample failures: ${sample}`,
      );
    }
  } finally {
    await stopServerEnvironment(env);
  }
}

async function runWave(baseUrl: string, concurrency: number): Promise<RequestResult[]> {
  return Promise.all(
    Array.from({ length: concurrency }, async () => runCrudRequest(baseUrl)),
  );
}

async function runCrudRequest(baseUrl: string): Promise<RequestResult> {
  const url = new URL('/odata/Products', `${baseUrl}/`);
  url.searchParams.set('$filter', 'price gt 200');
  url.searchParams.set('$orderby', 'id desc');
  url.searchParams.set('$top', '50');

  const started = nowMs();
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return {
        durationMs: nowMs() - started,
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }

    await response.arrayBuffer();
    return {
      durationMs: nowMs() - started,
      ok: true,
      status: response.status,
    };
  } catch (error) {
    return {
      durationMs: nowMs() - started,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseCliArgs(argv: string[]): BenchOptions {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      throw new Error(`Unexpected argument "${current}". Use --key=value.`);
    }

    const trimmed = current.slice(2);
    const separator = trimmed.indexOf('=');
    if (separator >= 0) {
      values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      values.set(trimmed, 'true');
      continue;
    }

    values.set(trimmed, next);
    i += 1;
  }

  return {
    iterations: parsePositiveInt(values.get('iterations'), DEFAULT_OPTIONS.iterations, 'iterations'),
    warmup: parseNonNegativeInt(values.get('warmup'), DEFAULT_OPTIONS.warmup, 'warmup'),
    concurrency: parsePositiveInt(
      values.get('concurrency'),
      DEFAULT_OPTIONS.concurrency,
      'concurrency',
    ),
    datasetScale: parsePositiveInt(
      values.get('dataset-scale'),
      DEFAULT_OPTIONS.datasetScale,
      'dataset-scale',
    ),
    tokenOpsPerIteration: DEFAULT_OPTIONS.tokenOpsPerIteration,
    database: parseDatabase(values.get('database'), DEFAULT_OPTIONS.database),
    payloadBytes: DEFAULT_OPTIONS.payloadBytes,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${label} to be a positive integer, got "${raw}".`);
  }
  return parsed;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected ${label} to be a non-negative integer, got "${raw}".`);
  }
  return parsed;
}

function parseDatabase(
  raw: string | undefined,
  fallback: BenchOptions['database'],
): BenchOptions['database'] {
  if (raw === undefined) return fallback;
  if (raw === 'memory' || raw === 'postgres') return raw;
  throw new Error(`Expected database to be "memory" or "postgres", got "${raw}".`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

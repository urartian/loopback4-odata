import { applyScenario } from './scenarios/apply';
import { applyPostgresScenario } from './scenarios/apply-postgres';
import { applyExecutorScenario } from './scenarios/apply-executor';
import { batchScenario } from './scenarios/batch';
import { crudScenario } from './scenarios/crud';
import { mediaLargeScenario } from './scenarios/media-large';
import { mediaScenario } from './scenarios/media';
import { mediaWriteScenario } from './scenarios/media-write';
import { tokensScenario } from './scenarios/tokens';
import {
  forceGcIfAvailable,
  formatSummary,
  mean,
  nowMs,
  percentile,
  snapshotMemory,
  toMb,
} from './lib/stats';
import { BenchOptions, BenchScenario, ScenarioSummary } from './types';

const SCENARIOS: Record<string, BenchScenario> = {
  crud: crudScenario,
  apply: applyScenario,
  'apply-postgres': applyPostgresScenario,
  'apply-executor': applyExecutorScenario,
  batch: batchScenario,
  media: mediaScenario,
  'media-large': mediaLargeScenario,
  'media-write': mediaWriteScenario,
  tokens: tokensScenario,
};

const DEFAULT_OPTIONS: BenchOptions = {
  iterations: 10,
  warmup: 2,
  concurrency: 1,
  datasetScale: 500,
  tokenOpsPerIteration: 5000,
  database: 'memory',
  payloadBytes: 110 * 1024 * 1024,
};

async function main() {
  const { scenarioNames, options } = parseCliArgs(process.argv.slice(2));

  console.log('Section 1.3 benchmark harness');
  console.log(
    `scenarios=${scenarioNames.join(', ')} iterations=${options.iterations} warmup=${options.warmup} concurrency=${options.concurrency} datasetScale=${options.datasetScale} tokenOps=${options.tokenOpsPerIteration} database=${options.database} payloadBytes=${options.payloadBytes}`,
  );

  const summaries: ScenarioSummary[] = [];
  for (const scenarioName of scenarioNames) {
    const scenario = SCENARIOS[scenarioName];
    const summary = await runScenario(scenario, options);
    summaries.push(summary);
    console.log('');
    console.log(formatSummary(summary));
  }

  console.log('');
  console.log('Completed benchmark scenarios:');
  for (const summary of summaries) {
    console.log(
      `- ${summary.name}: ${summary.opsPerSecond.toFixed(2)} ${summary.operationLabel}/s, p95 ${summary.p95Ms.toFixed(1)} ms`,
    );
  }
}

async function runScenario(scenario: BenchScenario, options: BenchOptions): Promise<ScenarioSummary> {
  console.log('');
  console.log(`Running ${scenario.name}: ${scenario.description}`);
  const env = await scenario.setup(options);

  try {
    for (let i = 0; i < options.warmup; i++) {
      await runWave(scenario, env, options.concurrency);
    }

    await forceGcIfAvailable();
    const memoryBefore = snapshotMemory();

    const durations: number[] = [];
    const totalStart = nowMs();
    for (let i = 0; i < options.iterations; i++) {
      const started = nowMs();
      await runWave(scenario, env, options.concurrency);
      durations.push(nowMs() - started);
    }
    const totalMs = nowMs() - totalStart;

    await forceGcIfAvailable();
    const memoryAfter = snapshotMemory();
    const operations =
      scenario.countOperations?.(options) ?? options.iterations * options.concurrency;
    const operationLabel = scenario.operationLabel ?? 'operations';

    return {
      name: scenario.name,
      description: scenario.description,
      operations,
      operationLabel,
      totalMs,
      minMs: Math.min(...durations),
      maxMs: Math.max(...durations),
      avgMs: mean(durations),
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      opsPerSecond: (operations * 1000) / totalMs,
      heapUsedDeltaMb: toMb(memoryAfter.heapUsed - memoryBefore.heapUsed),
      rssDeltaMb: toMb(memoryAfter.rss - memoryBefore.rss),
    };
  } finally {
    if (scenario.cleanup) {
      await scenario.cleanup(env);
    }
  }
}

async function runWave(
  scenario: BenchScenario,
  env: Awaited<ReturnType<BenchScenario['setup']>>,
  concurrency: number,
): Promise<void> {
  await Promise.all(Array.from({ length: concurrency }, async () => scenario.run(env)));
}

function parseCliArgs(argv: string[]): { scenarioNames: string[]; options: BenchOptions } {
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

  const scenarioValue = values.get('scenario') ?? 'all';
  const scenarioNames =
    scenarioValue === 'all'
      ? Object.keys(SCENARIOS)
      : scenarioValue
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);

  if (scenarioNames.length === 0) {
    throw new Error('At least one benchmark scenario must be selected.');
  }

  for (const scenarioName of scenarioNames) {
    if (!SCENARIOS[scenarioName]) {
      throw new Error(
        `Unknown scenario "${scenarioName}". Valid scenarios: ${Object.keys(SCENARIOS).join(', ')}`,
      );
    }
  }

  const options: BenchOptions = {
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
    tokenOpsPerIteration: parsePositiveInt(
      values.get('token-ops'),
      DEFAULT_OPTIONS.tokenOpsPerIteration,
      'token-ops',
    ),
    database: parseDatabase(values.get('database'), DEFAULT_OPTIONS.database),
    payloadBytes: parsePositiveInt(
      values.get('payload-bytes'),
      DEFAULT_OPTIONS.payloadBytes,
      'payload-bytes',
    ),
  };

  return { scenarioNames, options };
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
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes('EPERM') ||
    message.includes('operation not permitted') ||
    message.includes('Cannot read properties of null')
  ) {
    console.error(
      'Server-backed benchmark scenarios require an environment that allows ephemeral HTTP listeners. Run `npm run bench:tokens` here, or run `npm run bench` locally.',
    );
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

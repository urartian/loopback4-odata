import { applyScenario } from './scenarios/apply';
import { applyExecutorScenario } from './scenarios/apply-executor';
import { batchScenario } from './scenarios/batch';
import { crudScenario } from './scenarios/crud';
import { mediaScenario } from './scenarios/media';
import { mediaWriteScenario } from './scenarios/media-write';
import {
  forceGcIfAvailable,
  nowMs,
  snapshotMemory,
  toMb,
} from './lib/stats';
import { BenchOptions, BenchScenario } from './types';

const SCENARIOS: Record<string, BenchScenario> = {
  crud: crudScenario,
  apply: applyScenario,
  'apply-executor': applyExecutorScenario,
  batch: batchScenario,
  media: mediaScenario,
  'media-write': mediaWriteScenario,
};

const DEFAULT_OPTIONS: BenchOptions = {
  iterations: 100,
  warmup: 0,
  concurrency: 1,
  datasetScale: 1000,
  tokenOpsPerIteration: 5000,
};

async function main() {
  const { scenarioNames, options, sampleEvery } = parseCliArgs(process.argv.slice(2));

  console.log('Section 1.3 soak harness');
  console.log(
    `scenarios=${scenarioNames.join(', ')} iterations=${options.iterations} sampleEvery=${sampleEvery} concurrency=${options.concurrency} datasetScale=${options.datasetScale}`,
  );

  for (const scenarioName of scenarioNames) {
    const scenario = SCENARIOS[scenarioName];
    await runScenario(scenario, options, sampleEvery);
    console.log('');
  }
}

async function runScenario(
  scenario: BenchScenario,
  options: BenchOptions,
  sampleEvery: number,
) {
  console.log('');
  console.log(`Running soak ${scenario.name}: ${scenario.description}`);
  const env = await scenario.setup(options);

  try {
    await forceGcIfAvailable();
    const memoryStart = snapshotMemory();
    let peakHeap = memoryStart.heapUsed;
    let peakRss = memoryStart.rss;
    const started = nowMs();

    for (let i = 1; i <= options.iterations; i++) {
      await runWave(scenario, env, options.concurrency);

      if (i % sampleEvery === 0 || i === options.iterations) {
        await forceGcIfAvailable();
        const sample = snapshotMemory();
        peakHeap = Math.max(peakHeap, sample.heapUsed);
        peakRss = Math.max(peakRss, sample.rss);
        console.log(
          `  sample ${i}/${options.iterations}: heap ${toMb(sample.heapUsed - memoryStart.heapUsed).toFixed(2)} MiB, rss ${toMb(sample.rss - memoryStart.rss).toFixed(2)} MiB`,
        );
      }
    }

    await forceGcIfAvailable();
    const memoryEnd = snapshotMemory();
    const totalMs = nowMs() - started;
    const operations =
      (scenario.countOperations?.(options) ?? options.iterations * options.concurrency) /
      options.iterations;
    const totalOperations = operations * options.iterations;
    const operationLabel = scenario.operationLabel ?? 'operations';

    console.log(`${scenario.name} soak summary`);
    console.log(`  ${operationLabel}: ${totalOperations}`);
    console.log(`  total: ${totalMs.toFixed(1)} ms`);
    console.log(`  throughput: ${((totalOperations * 1000) / totalMs).toFixed(2)} ${operationLabel}/s`);
    console.log(
      `  final memory delta (heap/rss): ${toMb(memoryEnd.heapUsed - memoryStart.heapUsed).toFixed(2)} / ${toMb(memoryEnd.rss - memoryStart.rss).toFixed(2)} MiB`,
    );
    console.log(
      `  peak memory delta (heap/rss): ${toMb(peakHeap - memoryStart.heapUsed).toFixed(2)} / ${toMb(peakRss - memoryStart.rss).toFixed(2)} MiB`,
    );
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

function parseCliArgs(argv: string[]): {
  scenarioNames: string[];
  options: BenchOptions;
  sampleEvery: number;
} {
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

  const scenarioValue = values.get('scenario') ?? 'crud,apply,batch,media,media-write';
  const scenarioNames = scenarioValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (scenarioNames.length === 0) {
    throw new Error('At least one soak scenario must be selected.');
  }

  for (const scenarioName of scenarioNames) {
    if (!SCENARIOS[scenarioName]) {
      throw new Error(
        `Unknown soak scenario "${scenarioName}". Valid scenarios: ${Object.keys(SCENARIOS).join(', ')}`,
      );
    }
  }

  const options: BenchOptions = {
    iterations: parsePositiveInt(values.get('iterations'), DEFAULT_OPTIONS.iterations, 'iterations'),
    warmup: 0,
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
  };

  const sampleEvery = parsePositiveInt(values.get('sample-every'), 10, 'sample-every');

  return { scenarioNames, options, sampleEvery };
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${label} to be a positive integer, got "${raw}".`);
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import { createServerEnvironment, stopServerEnvironment } from '../lib/app';
import { configureLargeMediaHandler, ensureLargePayloadBytes } from '../lib/media-large';
import { BenchOptions } from '../types';

const READY_PREFIX = 'MEDIA_LARGE_READY ';

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  ensureLargePayloadBytes(options.payloadBytes);
  if (options.database !== 'postgres') {
    throw new Error('The external media-large server requires --database=postgres.');
  }

  const env = await createServerEnvironment(options, {
    configureApp(app) {
      configureLargeMediaHandler(app, options.payloadBytes);
    },
  });

  if (!env.app) {
    throw new Error('Expected benchmark server environment to include an application instance.');
  }

  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await stopServerEnvironment(env);
    } finally {
      process.exit(exitCode);
    }
  };

  const scheduleShutdown = (exitCode: number) => {
    shutdown(exitCode).catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => {
    scheduleShutdown(0);
  });
  process.on('SIGINT', () => {
    scheduleShutdown(0);
  });
  process.on('uncaughtException', (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    scheduleShutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(reason);
    scheduleShutdown(1);
  });

  await env.app.start();
  const url = env.app.restServer.url;
  if (!url) {
    throw new Error('Expected started benchmark server to expose a URL.');
  }

  console.log(`${READY_PREFIX}${url.replace(/\/+$/, '')}`);

  await new Promise<void>(() => undefined);
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
    iterations: 1,
    warmup: 0,
    concurrency: 1,
    datasetScale: parsePositiveInt(values.get('dataset-scale'), 500, 'dataset-scale'),
    tokenOpsPerIteration: 5000,
    database: parseDatabase(values.get('database'), 'postgres'),
    payloadBytes: parsePositiveInt(values.get('payload-bytes'), 110 * 1024 * 1024, 'payload-bytes'),
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

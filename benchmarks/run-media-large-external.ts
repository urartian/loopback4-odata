import { spawn } from 'child_process';
import * as readline from 'readline';
import { performance } from 'perf_hooks';

const READY_PREFIX = 'MEDIA_LARGE_READY ';
const TS_NODE_BIN = './node_modules/ts-node/dist/bin.js';

async function main() {
  const { payloadBytes, datasetScale } = parseCliArgs(process.argv.slice(2));

  console.log('Section 1.3 external payload benchmark');
  console.log(`database=postgres datasetScale=${datasetScale} payloadBytes=${payloadBytes}`);

  const server = spawn(
    process.execPath,
    [
      TS_NODE_BIN,
      '--project',
      'tsconfig.bench.json',
      'benchmarks/server/media-large-server.ts',
      '--database=postgres',
      `--dataset-scale=${datasetScale}`,
      `--payload-bytes=${payloadBytes}`,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const started = performance.now();
  let serverExited = false;
  server.once('exit', () => {
    serverExited = true;
  });

  const forward = (stream: NodeJS.ReadableStream | null, target: NodeJS.WritableStream) => {
    if (!stream) return;
    stream.on('data', (chunk) => target.write(chunk));
  };
  forward(server.stderr, process.stderr);

  try {
    const baseUrl = await waitForReady(server);

    const clientExitCode = await runClient(baseUrl, payloadBytes);
    if (clientExitCode !== 0) {
      throw new Error(`External media-large client exited with code ${clientExitCode}.`);
    }

    const totalMs = performance.now() - started;
    console.log('');
    console.log('media-large-external - Postgres upload/download over 100 MiB');
    console.log('  operations: 1');
    console.log(`  total: ${totalMs.toFixed(1)} ms`);
  } finally {
    if (!serverExited) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
  }
}

async function waitForReady(server: ReturnType<typeof spawn>): Promise<string> {
  const stdout = server.stdout;
  if (!stdout) {
    throw new Error('Expected server stdout to be available.');
  }

  return new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({ input: stdout });

    const onExit = (code: number | null) => {
      rl.close();
      reject(new Error(`External media-large server exited before becoming ready (code ${code}).`));
    };

    server.once('exit', onExit);

    rl.on('line', (line) => {
      console.log(line);
      if (!line.startsWith(READY_PREFIX)) return;

      server.off('exit', onExit);
      rl.close();
      resolve(line.slice(READY_PREFIX.length).trim());
    });
  });
}

async function runClient(baseUrl: string, payloadBytes: number): Promise<number | null> {
  const client = spawn(
    process.execPath,
    [
      TS_NODE_BIN,
      '--project',
      'tsconfig.bench.json',
      'benchmarks/clients/media-large-client.ts',
      `--base-url=${baseUrl}`,
      `--payload-bytes=${payloadBytes}`,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    },
  );

  return waitForExit(client);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

function parseCliArgs(argv: string[]): { payloadBytes: number; datasetScale: number } {
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
    payloadBytes: parsePositiveInt(values.get('payload-bytes'), 110 * 1024 * 1024, 'payload-bytes'),
    datasetScale: parsePositiveInt(values.get('dataset-scale'), 500, 'dataset-scale'),
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

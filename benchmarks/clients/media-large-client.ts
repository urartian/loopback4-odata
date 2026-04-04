import { once } from 'events';
import * as http from 'http';
import * as https from 'https';

const CHUNK_SIZE = 256 * 1024;

async function main() {
  const { baseUrl, payloadBytes } = parseCliArgs(process.argv.slice(2));

  const listing = await requestJson<{ value?: Array<{ id?: number; ['@odata.mediaEtag']?: string }> }>(
    baseUrl,
    '/odata/MediaAssets',
  );
  const asset = Array.isArray(listing.value) ? listing.value[0] : undefined;
  if (!asset?.id) {
    throw new Error('Large media client could not resolve a seeded media asset.');
  }

  const detail = await requestJson<{ ['@odata.mediaEtag']?: string }>(
    baseUrl,
    `/odata/MediaAssets(${asset.id})`,
  );
  const etag = detail['@odata.mediaEtag'];
  if (typeof etag !== 'string') {
    throw new Error('Large media client could not resolve the current media ETag.');
  }

  await putLargePayload(baseUrl, `/odata/MediaAssets(${asset.id})/$value`, payloadBytes, etag);
  await downloadLargePayload(baseUrl, `/odata/MediaAssets(${asset.id})/$value`, payloadBytes);
}

async function requestJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await request(baseUrl, path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Expected 200 for ${path}, got ${response.statusCode}.`);
  }

  const body = response.body.toString('utf8');
  return JSON.parse(body) as T;
}

async function putLargePayload(
  baseUrl: string,
  path: string,
  payloadBytes: number,
  etag: string,
): Promise<void> {
  const target = new URL(path, baseUrl);
  const transport = selectTransport(target);

  await new Promise<void>((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payloadBytes),
          'If-Match': etag,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          if (res.statusCode !== 204) {
            reject(
              new Error(
                `Expected 204 for media upload, got ${res.statusCode}. ${Buffer.concat(chunks).toString('utf8')}`,
              ),
            );
            return;
          }
          resolve();
        });
      },
    );

    req.on('error', reject);

    streamPayload(req, payloadBytes).catch((error) => {
      req.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function streamPayload(req: http.ClientRequest, payloadBytes: number): Promise<void> {
  let remaining = payloadBytes;
  while (remaining > 0) {
    const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, remaining), 0x61);
    remaining -= chunk.length;
    if (!req.write(chunk)) {
      await once(req, 'drain');
    }
  }
  req.end();
}

async function downloadLargePayload(
  baseUrl: string,
  path: string,
  expectedBytes: number,
): Promise<void> {
  const response = await request(baseUrl, path, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream' },
    streamOnly: true,
  });

  if (response.statusCode !== 200) {
    throw new Error(`Expected 200 for media download, got ${response.statusCode}.`);
  }

  const contentLength = Number(response.headers['content-length']);
  if (!Number.isFinite(contentLength) || contentLength !== expectedBytes) {
    throw new Error(
      `Expected Content-Length ${expectedBytes} for media download, got ${response.headers['content-length']}.`,
    );
  }

  if (response.bytesRead !== expectedBytes) {
    throw new Error(`Expected to stream ${expectedBytes} bytes, read ${response.bytesRead}.`);
  }
}

async function request(
  baseUrl: string,
  path: string,
  options: {
    method: 'GET' | 'PUT';
    headers?: Record<string, string>;
    streamOnly?: boolean;
  },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer; bytesRead: number }> {
  const target = new URL(path, baseUrl);
  const transport = selectTransport(target);

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        let bytesRead = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytesRead += buffer.length;
          if (!options.streamOnly) {
            chunks.push(buffer);
          }
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: options.streamOnly ? Buffer.alloc(0) : Buffer.concat(chunks),
            bytesRead,
          });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

function selectTransport(target: URL): typeof http | typeof https {
  return target.protocol === 'https:' ? https : http;
}

function parseCliArgs(argv: string[]): { baseUrl: string; payloadBytes: number } {
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

  const baseUrl = values.get('base-url');
  if (!baseUrl) {
    throw new Error('The media-large client requires --base-url.');
  }

  return {
    baseUrl,
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

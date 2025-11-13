import { BatchResponseEntry } from '../controllers/batch.controller';
import { STATUS_CODES } from 'http';

interface ResponseGroup {
  type: 'single' | 'changeset';
  id?: string;
  entries: BatchResponseEntry[];
}

export interface SerializedMultipartBatch {
  boundary: string;
  body: Buffer;
}

export function serializeMultipartBatch(responses: BatchResponseEntry[]): SerializedMultipartBatch {
  const boundary = generateBoundary('batch');
  const groups = groupResponses(responses);
  const chunks: Buffer[] = [];

  for (const group of groups) {
    if (group.type === 'single') {
      chunks.push(renderSinglePart(boundary, group.entries[0]));
    } else {
      chunks.push(renderChangesetPart(boundary, group));
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
  return { boundary, body: Buffer.concat(chunks) };
}

function groupResponses(entries: BatchResponseEntry[]): ResponseGroup[] {
  const groups: ResponseGroup[] = [];
  for (const entry of entries) {
    if (entry.atomicityGroup) {
      const last = groups[groups.length - 1];
      if (last && last.type === 'changeset' && last.id === entry.atomicityGroup) {
        last.entries.push(entry);
      } else {
        groups.push({ type: 'changeset', id: entry.atomicityGroup, entries: [entry] });
      }
    } else {
      groups.push({ type: 'single', entries: [entry] });
    }
  }
  return groups;
}

function renderSinglePart(boundary: string, entry: BatchResponseEntry): Buffer {
  const headers = buildPartHeaders(entry);
  const httpPayload = renderHttpResponse(entry);
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`, 'utf-8'),
    httpPayload,
    Buffer.from('\r\n', 'utf-8'),
  ]);
}

function renderChangesetPart(boundary: string, group: ResponseGroup): Buffer {
  const changesetBoundary = generateBoundary(group.id ?? 'changeset');
  const chunks: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Type: multipart/mixed; boundary=${changesetBoundary}\r\n\r\n`,
      'utf-8',
    ),
  ];
  for (const entry of group.entries) {
    const headers = buildPartHeaders(entry);
    const httpPayload = renderHttpResponse(entry);
    chunks.push(
      Buffer.from(`--${changesetBoundary}\r\n${headers}\r\n\r\n`, 'utf-8'),
      httpPayload,
      Buffer.from('\r\n', 'utf-8'),
    );
  }
  chunks.push(Buffer.from(`--${changesetBoundary}--\r\n`, 'utf-8'));
  return Buffer.concat(chunks);
}

function buildPartHeaders(entry: BatchResponseEntry): string {
  const lines = [] as string[];
  if (entry.id) {
    lines.push(`Content-ID: ${entry.id}`);
  }
  lines.push('Content-Type: application/http');
  lines.push('Content-Transfer-Encoding: binary');
  return lines.join('\r\n');
}

function renderHttpResponse(entry: BatchResponseEntry): Buffer {
  const reason = STATUS_CODES[entry.status] ?? '';
  const headers = normaliseHeaders(entry.headers ?? {});
  const bodyBuffer = serializeEntryBody(entry.body, headers);

  if (bodyBuffer && bodyBuffer.length && !headers['content-length']) {
    headers['content-length'] = bodyBuffer.length.toString();
  }

  const headerLines = Object.entries(headers).map(
    ([key, value]) => `${formatHeaderName(key)}: ${value}`,
  );
  let responseHead = `HTTP/1.1 ${entry.status} ${reason}`;
  if (headerLines.length) {
    responseHead += '\r\n' + headerLines.join('\r\n');
  }
  responseHead += '\r\n\r\n';
  const headBuffer = Buffer.from(responseHead, 'utf-8');
  if (!bodyBuffer || bodyBuffer.length === 0) {
    return headBuffer;
  }
  return Buffer.concat([headBuffer, bodyBuffer]);
}

function serializeEntryBody(body: unknown, headers: Record<string, string>): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf-8');
  }
  if (typeof body === 'number' || typeof body === 'boolean' || typeof body === 'object') {
    if (!headers['content-type']) {
      headers['content-type'] = 'application/json; charset=utf-8';
    }
    return Buffer.from(JSON.stringify(body));
  }
  return Buffer.from(String(body));
}

function normaliseHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function formatHeaderName(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
}

function generateBoundary(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

import {BatchResponseEntry} from '../controllers/batch.controller';
import {STATUS_CODES} from 'http';

interface ResponseGroup {
  type: 'single' | 'changeset';
  id?: string;
  entries: BatchResponseEntry[];
}

export interface SerializedMultipartBatch {
  boundary: string;
  body: string;
}

export function serializeMultipartBatch(responses: BatchResponseEntry[]): SerializedMultipartBatch {
  const boundary = generateBoundary('batch');
  const groups = groupResponses(responses);
  let result = '';

  for (const group of groups) {
    if (group.type === 'single') {
      result += renderSinglePart(boundary, group.entries[0]);
    } else {
      result += renderChangesetPart(boundary, group);
    }
  }

  result += `--${boundary}--\r\n`;
  return {boundary, body: result};
}

function groupResponses(entries: BatchResponseEntry[]): ResponseGroup[] {
  const groups: ResponseGroup[] = [];
  for (const entry of entries) {
    if (entry.atomicityGroup) {
      const last = groups[groups.length - 1];
      if (last && last.type === 'changeset' && last.id === entry.atomicityGroup) {
        last.entries.push(entry);
      } else {
        groups.push({type: 'changeset', id: entry.atomicityGroup, entries: [entry]});
      }
    } else {
      groups.push({type: 'single', entries: [entry]});
    }
  }
  return groups;
}

function renderSinglePart(boundary: string, entry: BatchResponseEntry): string {
  const headers = buildPartHeaders(entry);
  const httpPayload = renderHttpResponse(entry);
  return `--${boundary}\r\n${headers}\r\n\r\n${httpPayload}\r\n`;
}

function renderChangesetPart(boundary: string, group: ResponseGroup): string {
  const changesetBoundary = generateBoundary(group.id ?? 'changeset');
  let part = `--${boundary}\r\nContent-Type: multipart/mixed; boundary=${changesetBoundary}\r\n\r\n`;
  for (const entry of group.entries) {
    const headers = buildPartHeaders(entry);
    const httpPayload = renderHttpResponse(entry);
    part += `--${changesetBoundary}\r\n${headers}\r\n\r\n${httpPayload}\r\n`;
  }
  part += `--${changesetBoundary}--\r\n`;
  return part;
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

function renderHttpResponse(entry: BatchResponseEntry): string {
  const reason = STATUS_CODES[entry.status] ?? '';
  const headers = normaliseHeaders(entry.headers ?? {});
  let bodyString = '';

  if (entry.body !== undefined && entry.body !== null) {
    if (typeof entry.body === 'string') {
      bodyString = entry.body;
    } else if (Buffer.isBuffer(entry.body)) {
      bodyString = entry.body.toString('utf-8');
    } else {
      bodyString = JSON.stringify(entry.body);
      if (!headers['content-type']) {
        headers['content-type'] = 'application/json; charset=utf-8';
      }
    }
  }

  if (bodyString && !headers['content-length']) {
    headers['content-length'] = Buffer.byteLength(bodyString, 'utf-8').toString();
  }

  const headerLines = Object.entries(headers).map(([key, value]) => `${formatHeaderName(key)}: ${value}`);
  let response = `HTTP/1.1 ${entry.status} ${reason}`;
  if (headerLines.length) {
    response += '\r\n' + headerLines.join('\r\n');
  }
  response += '\r\n\r\n';
  if (bodyString) {
    response += bodyString;
  }
  return response;
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
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
}

function generateBoundary(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

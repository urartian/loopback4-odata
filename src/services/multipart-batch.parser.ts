import { Readable } from 'stream';
import { HttpErrors } from '@loopback/rest';

export interface ParsedBatch {
  requests: ParsedBatchRequest[];
}

export interface ParsedBatchRequest {
  id?: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  atomicityGroup?: string;
}

interface MultipartPart {
  headers: Record<string, string>;
  body: string;
}

export async function parseMultipartBatch(
  stream: Readable,
  boundary: string,
): Promise<ParsedBatch> {
  const content = await streamToString(stream);
  const parts = parseMultipart(content, boundary);
  const requests: ParsedBatchRequest[] = [];
  let autoId = 0;

  for (const part of parts) {
    const contentType = part.headers['content-type']?.toLowerCase() ?? '';
    if (contentType.startsWith('multipart/mixed')) {
      const nestedBoundary = extractBoundary(contentType);
      if (!nestedBoundary) {
        throw new HttpErrors.BadRequest('Changeset part is missing boundary attribute.');
      }
      const groupId = part.headers['content-id'] ?? nestedBoundary;
      const nestedParts = parseMultipart(part.body, nestedBoundary);
      for (const nested of nestedParts) {
        const request = parseHttpPart(nested, () => `auto-${++autoId}`, groupId);
        requests.push(request);
      }
      continue;
    }

    if (contentType.startsWith('application/http')) {
      const request = parseHttpPart(part, () => `auto-${++autoId}`);
      requests.push(request);
      continue;
    }

    throw new HttpErrors.BadRequest(`Unsupported part content-type: ${contentType || 'unknown'}.`);
  }

  return { requests };
}

function parseHttpPart(
  part: MultipartPart,
  idFactory: () => string,
  atomicityGroup?: string,
): ParsedBatchRequest {
  const id = part.headers['content-id'] ?? idFactory();
  const payload = parseHttpPayload(part.body);
  return {
    id,
    method: payload.method,
    url: payload.url,
    headers: payload.headers,
    body: payload.body,
    atomicityGroup,
  };
}

function parseHttpPayload(body: string) {
  const sanitized = body.replace(/^\r?\n/, '');
  const lineBreak = sanitized.includes('\r\n') ? '\r\n' : '\n';
  const requestLineEnd = sanitized.indexOf(lineBreak);
  if (requestLineEnd < 0) {
    throw new HttpErrors.BadRequest('Malformed batch part: missing request line.');
  }
  const requestLine = sanitized.slice(0, requestLineEnd).trim();
  const rest = sanitized.slice(requestLineEnd + lineBreak.length);
  const [method, url] = requestLine.split(' ');
  if (!method || !url) {
    throw new HttpErrors.BadRequest('Malformed batch part: invalid request line.');
  }

  const headerSeparator = rest.indexOf(`${lineBreak}${lineBreak}`);
  let headerText: string;
  let rawBody = '';
  if (headerSeparator >= 0) {
    headerText = rest.slice(0, headerSeparator);
    rawBody = rest.slice(headerSeparator + 2 * lineBreak.length);
  } else {
    headerText = rest;
  }

  const headers = parseHeaders(headerText);
  const contentType = headers['content-type'];
  const trimmedBody = rawBody.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  let parsedBody: unknown;
  if (trimmedBody.length) {
    if (contentType && /application\/json/i.test(contentType)) {
      try {
        parsedBody = JSON.parse(trimmedBody);
      } catch (error) {
        throw new HttpErrors.BadRequest('Invalid JSON payload inside batch part.');
      }
    } else {
      parsedBody = trimmedBody;
    }
  }

  return {
    method: method.toUpperCase(),
    url,
    headers,
    body: parsedBody,
  };
}

function parseMultipart(content: string, boundary: string): MultipartPart[] {
  const delimiter = `--${boundary}`;
  const segments = content.split(delimiter);
  const parts: MultipartPart[] = [];

  for (const rawSegment of segments) {
    let segment = rawSegment;
    if (!segment) continue;
    segment = segment.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!segment || segment === '--') continue;
    if (segment.startsWith('--')) {
      // closing boundary
      continue;
    }

    const headerEnd = findHeaderBoundary(segment);
    if (headerEnd < 0) {
      throw new HttpErrors.BadRequest('Malformed multipart part: missing header separator.');
    }

    const headerText = segment.slice(0, headerEnd);
    const bodyText = segment.slice(headerEnd).replace(/^\r?\n\r?\n/, '');
    const headers = parseHeaders(headerText);
    parts.push({ headers, body: bodyText });
  }

  return parts;
}

function findHeaderBoundary(content: string): number {
  const idx = content.indexOf('\r\n\r\n');
  if (idx >= 0) return idx;
  return content.indexOf('\n\n');
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = value;
  }
  return headers;
}

function extractBoundary(contentType: string): string | undefined {
  const match = /boundary=([^;]+)/i.exec(contentType ?? '');
  if (!match) return undefined;
  return match[1]?.trim().replace(/^"|"$/g, '');
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

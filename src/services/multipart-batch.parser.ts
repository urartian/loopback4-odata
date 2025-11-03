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

export interface MultipartParserLimits {
  maxPayloadBytes?: number;
  maxOperations?: number;
  maxChangesetOperations?: number;
  maxDepth?: number;
  maxPartBodyBytes?: number;
}

export interface MultipartParserOptions {
  limits?: MultipartParserLimits;
  onLimitViolation?: (reason: string) => void;
}

export async function parseMultipartBatch(
  stream: Readable,
  boundary: string,
  options: MultipartParserOptions = {},
): Promise<ParsedBatch> {
  const context = new ParserContext(options.limits ?? {}, options.onLimitViolation);
  const parser = new StreamingBatchParser(boundary, context, 0);
  const requests = await parser.parse(stream);
  return { requests };
}

class ParserContext {
  autoId = 0;
  totalOperations = 0;

  constructor(
    public readonly limits: MultipartParserLimits,
    private readonly onLimitViolation?: (reason: string) => void,
  ) {}

  nextAutoId(): number {
    return ++this.autoId;
  }

  recordOperation(changesetId?: string, positionInChangeset?: number) {
    this.totalOperations++;
    const { maxOperations, maxChangesetOperations } = this.limits;

    if (maxOperations && maxOperations > 0 && this.totalOperations > maxOperations) {
      this.signal(
        `Operation count ${this.totalOperations} exceeds maxOperations=${maxOperations}.`,
      );
      throw new HttpErrors.BadRequest('Batch payload exceeds the configured operation limit.');
    }

    if (
      changesetId &&
      maxChangesetOperations &&
      maxChangesetOperations > 0 &&
      positionInChangeset &&
      positionInChangeset > maxChangesetOperations
    ) {
      this.signal(
        `Changeset ${changesetId} contains ${positionInChangeset} operations which exceeds maxChangesetOperations=${maxChangesetOperations}.`,
      );
      throw new HttpErrors.BadRequest('Changeset exceeds the configured operation limit.');
    }
  }

  checkTotalBytes(totalBytes: number) {
    const { maxPayloadBytes } = this.limits;
    if (maxPayloadBytes && maxPayloadBytes > 0 && totalBytes > maxPayloadBytes) {
      this.signal(`Payload size ${totalBytes} bytes exceeds maxPayloadBytes=${maxPayloadBytes}.`);
      throw new HttpErrors.PayloadTooLarge('Batch payload exceeds the configured size limit.');
    }
  }

  ensureDepth(nextDepth: number) {
    const { maxDepth } = this.limits;
    if (maxDepth && maxDepth > 0 && nextDepth >= maxDepth) {
      this.signal(`Multipart nesting depth ${nextDepth} exceeds maxDepth=${maxDepth}.`);
      throw new HttpErrors.BadRequest('Changeset nesting depth exceeds the configured limit.');
    }
  }

  ensurePartSize(size: number) {
    const { maxPartBodyBytes } = this.limits;
    if (maxPartBodyBytes && maxPartBodyBytes > 0 && size > maxPartBodyBytes) {
      this.signal(`Part body size ${size} bytes exceeds maxPartBodyBytes=${maxPartBodyBytes}.`);
      throw new HttpErrors.PayloadTooLarge('Batch part exceeds the configured size limit.');
    }
  }

  private signal(message: string) {
    this.onLimitViolation?.(message);
  }
}

class StreamingBatchParser {
  private readonly boundaryPrefix: Buffer;
  private readonly boundaryMarker: Buffer;
  private readonly closingMarker: Buffer;
  private buffer = Buffer.alloc(0);
  private firstBoundarySeen = false;
  private state: 'headers' | 'body' = 'headers';
  private currentHeaders: Record<string, string> | undefined;
  private ended = false;
  private totalBytes = 0;
  private readonly requests: ParsedBatchRequest[] = [];

  constructor(
    private readonly boundary: string,
    private readonly context: ParserContext,
    private readonly depth: number,
  ) {
    this.boundaryPrefix = Buffer.from(`--${boundary}`);
    this.boundaryMarker = Buffer.from(`\r\n--${boundary}`);
    this.closingMarker = Buffer.from(`\r\n--${boundary}--`);
  }

  async parse(stream: Readable): Promise<ParsedBatchRequest[]> {
    for await (const chunk of stream) {
      const bufferChunk = this.toBuffer(chunk);
      if (this.depth === 0) {
        this.totalBytes += bufferChunk.length;
        this.context.checkTotalBytes(this.totalBytes);
      }
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, bufferChunk])
        : Buffer.from(bufferChunk);
      this.processBuffer(false);
    }
    this.processBuffer(true);

    if (!this.ended) {
      throw new HttpErrors.BadRequest('Malformed batch payload: missing closing boundary.');
    }

    return this.requests;
  }

  private processBuffer(finalPass: boolean) {
    if (this.ended) return;
    // Loop consumes as many complete parts as possible; exits early when more data is required.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this.firstBoundarySeen) {
        const boundaryIndex = this.buffer.indexOf(this.boundaryPrefix);
        if (boundaryIndex === -1) {
          if (finalPass) {
            throw new HttpErrors.BadRequest('Malformed batch payload: boundary not found.');
          }
          return;
        }
        this.buffer = this.buffer.slice(boundaryIndex + this.boundaryPrefix.length);
        this.firstBoundarySeen = true;
        // Handle closing boundary immediately (empty payload)
        if (this.buffer.length >= 2 && this.buffer[0] === 45 && this.buffer[1] === 45) {
          this.buffer = this.buffer.slice(2);
          this.ended = true;
          return;
        }
        if (this.buffer.length >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10) {
          this.buffer = this.buffer.slice(2);
        }
        this.state = 'headers';
      }

      if (this.state === 'headers') {
        const headerIdx = indexOfDoubleCRLF(this.buffer);
        if (headerIdx === -1) {
          if (finalPass) {
            throw new HttpErrors.BadRequest('Malformed multipart part: missing header separator.');
          }
          return;
        }
        const headerBuffer = this.buffer.slice(0, headerIdx);
        this.currentHeaders = parseHeaders(headerBuffer.toString('utf-8'));
        this.buffer = this.buffer.slice(headerIdx + 4);
        this.state = 'body';
      }

      if (this.state === 'body') {
        const boundaryInfo = this.findNextBoundary();
        if (boundaryInfo.index < 0) {
          this.ensurePartBufferLimit();
          if (finalPass) {
            throw new HttpErrors.BadRequest('Malformed multipart part: unterminated body.');
          }
          return;
        }

        const bodyBuffer = this.buffer.slice(0, boundaryInfo.index);
        this.context.ensurePartSize(bodyBuffer.length);
        this.handlePart(bodyBuffer, this.currentHeaders);
        this.currentHeaders = undefined;

        const markerLength = boundaryInfo.closing
          ? this.closingMarker.length
          : this.boundaryMarker.length;
        this.buffer = this.buffer.slice(boundaryInfo.index + markerLength);

        if (boundaryInfo.closing) {
          if (this.buffer.length >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10) {
            this.buffer = this.buffer.slice(2);
          }
          this.ended = true;
          return;
        }

        if (this.buffer.length >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10) {
          this.buffer = this.buffer.slice(2);
        }
        this.state = 'headers';
      }
    }
  }

  private ensurePartBufferLimit() {
    const { maxPartBodyBytes } = this.context.limits;
    if (!maxPartBodyBytes || maxPartBodyBytes <= 0) return;
    if (this.buffer.length > maxPartBodyBytes + this.boundaryMarker.length + 4) {
      this.context.ensurePartSize(this.buffer.length);
    }
  }

  private findNextBoundary(): { index: number; closing: boolean } {
    const closingIndex = this.buffer.indexOf(this.closingMarker);
    const markerIndex = this.buffer.indexOf(this.boundaryMarker);

    if (closingIndex === -1 && markerIndex === -1) {
      return { index: -1, closing: false };
    }

    if (closingIndex >= 0 && (markerIndex === -1 || closingIndex <= markerIndex)) {
      return { index: closingIndex, closing: true };
    }

    return { index: markerIndex, closing: false };
  }

  private handlePart(body: Buffer, headers: Record<string, string> | undefined) {
    if (!headers) {
      throw new HttpErrors.BadRequest('Multipart part is missing headers.');
    }
    const contentType = headers['content-type']?.toLowerCase() ?? '';
    if (contentType.startsWith('multipart/mixed')) {
      const nestedBoundary = extractBoundary(contentType);
      if (!nestedBoundary) {
        throw new HttpErrors.BadRequest('Changeset part is missing boundary attribute.');
      }
      this.context.ensureDepth(this.depth + 1);
      const groupId = headers['content-id'] ?? nestedBoundary;
      const nestedContent = body.toString('utf-8');
      const nestedParts = parseMultipartString(nestedContent, nestedBoundary);
      let index = 0;
      for (const nested of nestedParts) {
        const request = parseHttpPart(nested, () => `auto-${this.context.nextAutoId()}`, groupId);
        index++;
        this.context.recordOperation(groupId, index);
        this.requests.push(request);
      }
      if (nestedParts.length === 0) {
        throw new HttpErrors.BadRequest('Changeset part must contain at least one request.');
      }
    } else if (contentType.startsWith('application/http')) {
      const part: MultipartPart = { headers, body: body.toString('utf-8') };
      const request = parseHttpPart(part, () => `auto-${this.context.nextAutoId()}`);
      this.context.recordOperation();
      this.requests.push(request);
    } else {
      throw new HttpErrors.BadRequest(
        `Unsupported part content-type: ${contentType || 'unknown'}.`,
      );
    }
  }

  private toBuffer(chunk: Buffer | string): Buffer {
    return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
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

function parseMultipartString(content: string, boundary: string): MultipartPart[] {
  const delimiter = `--${boundary}`;
  const segments = content.split(delimiter);
  const parts: MultipartPart[] = [];

  for (const rawSegment of segments) {
    let segment = rawSegment;
    if (!segment) continue;
    segment = segment.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!segment || segment === '--') continue;
    if (segment.startsWith('--')) {
      continue;
    }

    const headerEnd = findHeaderBoundaryString(segment);
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

function indexOfDoubleCRLF(buffer: Buffer): number {
  for (let i = 0; i <= buffer.length - 4; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      return i;
    }
  }
  for (let i = 0; i <= buffer.length - 2; i++) {
    if (buffer[i] === 10 && buffer[i + 1] === 10) {
      return i;
    }
  }
  return -1;
}

function findHeaderBoundaryString(content: string): number {
  const idx = content.indexOf('\r\n\r\n');
  if (idx >= 0) return idx;
  return content.indexOf('\n\n');
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
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

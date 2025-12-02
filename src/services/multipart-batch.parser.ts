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
  rawBody?: Buffer;
  atomicityGroup?: string;
}

interface MultipartPart {
  headers: Record<string, string>;
  body: Buffer;
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
  const limitedStream = Readable.from(enforcePayloadLimit(stream, context));
  const parser = new StreamingBatchParser(boundary, context, 0);
  const requests = await parser.parse(limitedStream);
  return { requests };
}

async function* enforcePayloadLimit(stream: Readable, context: ParserContext) {
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    context.checkTotalBytes(total);
    yield buffer;
  }
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
  private readonly boundaryHeadroom: number;
  private buffer = Buffer.alloc(0);
  private firstBoundarySeen = false;
  private state: 'headers' | 'body' = 'headers';
  private currentHeaders: Record<string, string> | undefined;
  private currentPartBytes = 0;
  private ended = false;
  private readonly requests: ParsedBatchRequest[] = [];
  private changesetOperationIndex = 0;

  constructor(
    private readonly boundary: string,
    private readonly context: ParserContext,
    private readonly depth: number,
    private readonly changesetId?: string,
  ) {
    this.boundaryPrefix = Buffer.from(`--${boundary}`);
    this.boundaryMarker = Buffer.from(`\r\n--${boundary}`);
    this.closingMarker = Buffer.from(`\r\n--${boundary}--`);
    this.boundaryHeadroom = Math.max(this.boundaryMarker.length, this.closingMarker.length) + 4;
  }

  async parse(stream: Readable): Promise<ParsedBatchRequest[]> {
    for await (const chunk of stream) {
      const bufferChunk = this.toBuffer(chunk);
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

  parseBuffer(buffer: Buffer): ParsedBatchRequest[] {
    const chunk = this.toBuffer(buffer);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
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
        this.currentPartBytes = 0;
      }

      if (this.state === 'body') {
        const boundaryInfo = this.findNextBoundary();
        if (boundaryInfo.index < 0) {
          this.enforceStreamingPartLimit();
          if (finalPass) {
            throw new HttpErrors.BadRequest('Malformed multipart part: unterminated body.');
          }
          return;
        }

        const bodyBuffer = this.buffer.slice(0, boundaryInfo.index);
        this.context.ensurePartSize(bodyBuffer.length);
        this.handlePart(bodyBuffer, this.currentHeaders);
        this.currentHeaders = undefined;
        this.currentPartBytes = 0;

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

  private enforceStreamingPartLimit() {
    const { maxPartBodyBytes } = this.context.limits;
    if (!maxPartBodyBytes || maxPartBodyBytes <= 0) return;
    const safeLength = Math.max(0, this.buffer.length - this.boundaryHeadroom);
    if (safeLength <= this.currentPartBytes) return;
    this.currentPartBytes = safeLength;
    this.context.ensurePartSize(this.currentPartBytes);
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
      const nestedParser = new StreamingBatchParser(
        nestedBoundary,
        this.context,
        this.depth + 1,
        groupId,
      );
      const nestedRequests = nestedParser.parseBuffer(body);
      if (!nestedRequests.length) {
        throw new HttpErrors.BadRequest('Changeset part must contain at least one request.');
      }
      for (const nested of nestedRequests) {
        this.requests.push(nested);
      }
      return;
    }

    if (contentType.startsWith('application/http')) {
      const part: MultipartPart = { headers, body };
      const request = parseHttpPart(
        part,
        () => `auto-${this.context.nextAutoId()}`,
        this.changesetId,
      );
      const position = this.nextChangesetOperation();
      this.context.recordOperation(this.changesetId, position);
      this.requests.push(request);
      return;
    }

    throw new HttpErrors.BadRequest(`Unsupported part content-type: ${contentType || 'unknown'}.`);
  }

  private toBuffer(chunk: Buffer | string): Buffer {
    return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }

  private nextChangesetOperation(): number | undefined {
    if (!this.changesetId) return undefined;
    this.changesetOperationIndex += 1;
    return this.changesetOperationIndex;
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
    rawBody: payload.rawBody,
    atomicityGroup,
  };
}

function parseHttpPayload(body: Buffer) {
  const sanitized = stripLeadingEmptyLine(body);
  const requestLineInfo = findLineBreak(sanitized);
  if (!requestLineInfo) {
    throw new HttpErrors.BadRequest('Malformed batch part: missing request line.');
  }
  const requestLine = sanitized.slice(0, requestLineInfo.index).toString('utf-8').trim();
  const rest = sanitized.slice(requestLineInfo.index + requestLineInfo.length);
  const [method, url] = requestLine.split(/\s+/);
  if (!method || !url) {
    throw new HttpErrors.BadRequest('Malformed batch part: invalid request line.');
  }

  const headerInfo = findHeaderSeparator(rest);
  const headerBuffer = headerInfo ? rest.slice(0, headerInfo.index) : rest;
  const headers = parseHeaders(headerBuffer.toString('utf-8'));
  const bodyStart = headerInfo ? headerInfo.index + headerInfo.length : rest.length;
  const rawBody = rest.slice(bodyStart);
  const contentType = headers['content-type'];
  let parsedBody: unknown;
  let rawBodyBuffer: Buffer | undefined;

  if (rawBody.length) {
    if (contentType && /application\/json/i.test(contentType)) {
      try {
        parsedBody = JSON.parse(rawBody.toString('utf-8'));
      } catch {
        throw new HttpErrors.BadRequest('Invalid JSON payload inside batch part.');
      }
    } else {
      rawBodyBuffer = rawBody;
      if (contentType && /^text\//i.test(contentType)) {
        parsedBody = rawBody.toString('utf-8');
      }
    }
  }

  return {
    method: method.toUpperCase(),
    url,
    headers,
    body: parsedBody,
    rawBody: rawBodyBuffer,
  };
}

function stripLeadingEmptyLine(buffer: Buffer): Buffer {
  if (!buffer.length) return buffer;
  if (buffer[0] === 13 && buffer[1] === 10) {
    return buffer.slice(2);
  }
  if (buffer[0] === 10) {
    return buffer.slice(1);
  }
  return buffer;
}

function findLineBreak(buffer: Buffer): { index: number; length: number } | undefined {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 13 && i + 1 < buffer.length && buffer[i + 1] === 10) {
      return { index: i, length: 2 };
    }
    if (buffer[i] === 10) {
      return { index: i, length: 1 };
    }
  }
  return undefined;
}

function findHeaderSeparator(buffer: Buffer): { index: number; length: number } | undefined {
  const crlfIdx = buffer.indexOf(Buffer.from('\r\n\r\n'));
  if (crlfIdx >= 0) return { index: crlfIdx, length: 4 };
  const lfIdx = buffer.indexOf(Buffer.from('\n\n'));
  if (lfIdx >= 0) return { index: lfIdx, length: 2 };
  return undefined;
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

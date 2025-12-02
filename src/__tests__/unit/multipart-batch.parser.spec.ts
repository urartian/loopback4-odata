/// <reference path="../../types/testing.globals.d.ts" />

import { Readable } from 'stream';
import { parseMultipartBatch } from '../../services/multipart-batch.parser';
import { expect } from '@loopback/testlab';

describe('multipart batch parser', () => {
  it('parses nested changesets and individual requests', async () => {
    const batchBoundary = 'batch_123';
    const changesetBoundary = 'changeset_456';
    const body = [
      `--${batchBoundary}`,
      `Content-Type: multipart/mixed; boundary=${changesetBoundary}`,
      '',
      `--${changesetBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 1',
      '',
      'POST /odata/Products HTTP/1.1',
      'Content-Type: application/json',
      '',
      '{"name":"Tablet"}',
      `--${changesetBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 2',
      '',
      'PATCH /odata/Products(1) HTTP/1.1',
      'Content-Type: application/json',
      '',
      '{"price":1199}',
      `--${changesetBoundary}--`,
      `--${batchBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      'Content-ID: 3',
      '',
      'GET /odata/Products HTTP/1.1',
      'Accept: application/json',
      '',
      '',
      `--${batchBoundary}--`,
      '',
    ].join('\r\n');

    const stream = Readable.from(body);
    const result = await parseMultipartBatch(stream, batchBoundary);

    expect(result.requests).to.have.length(3);
    const [createReq, updateReq, listReq] = result.requests;
    expect(createReq.atomicityGroup).to.equal('changeset_456');
    expect(updateReq.atomicityGroup).to.equal('changeset_456');
    expect(createReq.method).to.equal('POST');
    expect(updateReq.method).to.equal('PATCH');
    expect(createReq.body).to.deepEqual({ name: 'Tablet' });
    expect(updateReq.body).to.deepEqual({ price: 1199 });
    expect(listReq.method).to.equal('GET');
    expect(listReq.atomicityGroup).to.be.undefined();
  });

  it('enforces maxOperations limit', async () => {
    const batchBoundary = 'batch_limit';
    const body = [
      `--${batchBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'GET /odata/Products HTTP/1.1',
      '',
      '',
      `--${batchBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'GET /odata/Orders HTTP/1.1',
      '',
      '',
      `--${batchBoundary}--`,
      '',
    ].join('\r\n');
    const stream = Readable.from(body);
    await expect(
      parseMultipartBatch(stream, batchBoundary, {
        limits: { maxOperations: 1 },
      }),
    ).to.be.rejectedWith(/operation limit/i);
  });

  it('enforces maxPartBodyBytes limit', async () => {
    const batchBoundary = 'batch_payload';
    const largeBody = 'POST /odata/Products HTTP/1.1\r\n\r\n' + 'x'.repeat(256);
    const body = [
      `--${batchBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      largeBody,
      '',
      `--${batchBoundary}--`,
      '',
    ].join('\r\n');
    const stream = Readable.from(body);
    await expect(
      parseMultipartBatch(stream, batchBoundary, {
        limits: { maxPartBodyBytes: 128 },
      }),
    ).to.be.rejectedWith(/part exceeds the configured size limit/i);
  });

  it('invokes onLimitViolation callback when limits are exceeded', async () => {
    const batchBoundary = 'batch_notify';
    const body = [
      `--${batchBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'GET /odata/Products HTTP/1.1',
      '',
      '',
      `--${batchBoundary}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'GET /odata/Orders HTTP/1.1',
      '',
      '',
      `--${batchBoundary}--`,
      '',
    ].join('\r\n');
    const stream = Readable.from(body);
    let reported: string | undefined;
    await expect(
      parseMultipartBatch(stream, batchBoundary, {
        limits: { maxOperations: 1 },
        onLimitViolation: (reason) => {
          reported = reason;
        },
      }),
    ).to.be.rejectedWith(/operation limit/i);
    expect(reported).to.be.String();
    expect(reported).to.match(/exceeds maxOperations/);
  });

  it('stops reading when maxPayloadBytes is exceeded mid-stream', async () => {
    const boundary = 'batch_stream_limit';
    const body = buildBatchBody({ boundary, partCount: 2 });
    const stream = new ChunkedReadable(body, 8);
    await expect(
      parseMultipartBatch(stream, boundary, {
        limits: { maxPayloadBytes: body.length - 10 },
      }),
    ).to.be.rejectedWith(/payload exceeds the configured size limit/i);
  });

  it('stops reading part once maxPartBodyBytes is exceeded', async () => {
    const boundary = 'batch_part_limit';
    const body = buildBatchBody({
      boundary,
      parts: [
        {
          headers: {
            'Content-Type': 'application/http',
            'Content-Transfer-Encoding': 'binary',
          },
          body: 'POST /odata/Products HTTP/1.1\r\n\r\n' + 'X'.repeat(512),
        },
      ],
    });
    const stream = new ChunkedReadable(body, 32);
    await expect(
      parseMultipartBatch(stream, boundary, {
        limits: { maxPartBodyBytes: 256 },
      }),
    ).to.be.rejectedWith(/part exceeds the configured size limit/i);
  });

  it('aborts unterminated parts when maxPartBodyBytes is exceeded mid-stream', async () => {
    const boundary = 'batch_unterminated_limit';
    const prefix = Buffer.from(
      [
        `--${boundary}`,
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        '',
        'POST /odata/Products HTTP/1.1',
        'Content-Type: application/json',
        '',
        '',
      ].join('\r\n'),
      'utf-8',
    );
    const stream = new HangingPartReadable(prefix, 64, 8 * 1024);
    let observedBytes: number | undefined;
    await expect(
      parseMultipartBatch(stream, boundary, {
        limits: { maxPartBodyBytes: 512 },
        onLimitViolation: () => {
          observedBytes = stream.bodyBytes;
        },
      }),
    ).to.be.rejectedWith(/part exceeds the configured size limit/i);
    expect(observedBytes).to.be.Number();
    expect(observedBytes).to.be.greaterThanOrEqual(512);
    expect(observedBytes).to.be.lessThan(8 * 1024);
  });

  it('preserves raw binary payloads inside application/http parts', async () => {
    const boundary = 'batch_binary';
    const binaryPayload = Buffer.from([0x00, 0xff, 0x41, 0x42, 0x10, 0x99]);
    const prefix = Buffer.from(
      [
        `--${boundary}`,
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        '',
        'POST /odata/Documents HTTP/1.1',
        'Content-Type: application/octet-stream',
        '',
        '',
      ].join('\r\n'),
      'utf-8',
    );
    const suffix = Buffer.from([`\r\n--${boundary}--`, '', ''].join('\r\n'), 'utf-8');
    const body = Buffer.concat([prefix, binaryPayload, suffix]);
    const stream = Readable.from(body);
    const result = await parseMultipartBatch(stream, boundary);
    expect(result.requests).to.have.length(1);
    const [request] = result.requests;
    expect(request.method).to.equal('POST');
    expect(request.rawBody).to.be.instanceOf(Buffer);
    expect(request.rawBody?.equals(binaryPayload)).to.be.true();
    expect(request.body).to.be.undefined();
  });
});

function buildBatchBody({
  boundary,
  partCount = 0,
  parts,
}: {
  boundary: string;
  partCount?: number;
  parts?: Array<{ headers?: Record<string, string>; body: string }>;
}): Buffer {
  const resolvedParts =
    parts ??
    Array.from({ length: partCount }).map(() => ({
      headers: {
        'Content-Type': 'application/http',
        'Content-Transfer-Encoding': 'binary',
      },
      body: 'GET /odata/Products HTTP/1.1',
    }));
  const segments: string[] = [];
  for (const part of resolvedParts) {
    segments.push(`--${boundary}`);
    const headers = part.headers ?? {
      'Content-Type': 'application/http',
      'Content-Transfer-Encoding': 'binary',
    };
    for (const [name, value] of Object.entries(headers)) {
      segments.push(`${name}: ${value}`);
    }
    segments.push('');
    segments.push(part.body);
    segments.push('');
  }
  segments.push(`--${boundary}--`);
  segments.push('');
  return Buffer.from(segments.join('\r\n'));
}

class ChunkedReadable extends Readable {
  private offset = 0;

  constructor(
    private readonly payload: Buffer,
    private readonly chunkSize: number,
  ) {
    super();
  }

  _read() {
    if (this.offset >= this.payload.length) {
      this.push(null);
      return;
    }
    const chunk = this.payload.slice(this.offset, this.offset + this.chunkSize);
    this.offset += chunk.length;
    this.push(chunk);
  }
}

class HangingPartReadable extends Readable {
  private prefixOffset = 0;
  public bodyBytes = 0;

  constructor(
    private readonly prefix: Buffer,
    private readonly chunkSize: number,
    private readonly maxBodyBytes: number,
  ) {
    super({ highWaterMark: chunkSize });
  }

  _read() {
    if ((this as Readable).destroyed) return;
    if (this.prefixOffset < this.prefix.length) {
      const chunk = this.prefix.slice(this.prefixOffset, this.prefixOffset + this.chunkSize);
      this.prefixOffset += chunk.length;
      this.push(chunk);
      return;
    }
    if (this.bodyBytes >= this.maxBodyBytes) {
      this.push(null);
      return;
    }
    const chunkLength = Math.min(this.chunkSize, this.maxBodyBytes - this.bodyBytes);
    this.bodyBytes += chunkLength;
    this.push(Buffer.alloc(chunkLength, 0x58));
  }
}

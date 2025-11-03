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
});

/// <reference path="../../types/testing.globals.d.ts" />

import { expect } from '@loopback/testlab';
import { serializeMultipartBatch } from '../../services/multipart-batch.serializer';
import { BatchResponseEntry } from '../../controllers/batch.controller';

describe('multipart batch serializer', () => {
  it('renders single and changeset responses with boundaries', () => {
    const responses: BatchResponseEntry[] = [
      {
        id: '1',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { value: [] },
      },
      {
        id: '2',
        atomicityGroup: 'changeset_1',
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: { value: { id: 1 } },
      },
      {
        id: '3',
        atomicityGroup: 'changeset_1',
        status: 204,
      },
    ];

    const { boundary, body } = serializeMultipartBatch(responses);
    expect(boundary).to.match(/^batch_/);
    expect(Buffer.isBuffer(body)).to.be.true();
    const text = body.toString('utf-8');
    expect(text).to.match(new RegExp(`--${boundary}`));
    expect(text).to.match(/Content-Type: multipart\/mixed/);
    expect(text).to.match(/HTTP\/1\.1 200/);
    expect(text).to.match(/HTTP\/1\.1 201/);
    expect(text).to.match(/HTTP\/1\.1 204/);
  });

  it('preserves binary payloads without decoding them', () => {
    const blob = Buffer.from([0x00, 0xff, 0x10]);
    const responses: BatchResponseEntry[] = [
      {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(blob.length),
        },
        body: blob,
      },
    ];

    const { body } = serializeMultipartBatch(responses);
    expect(Buffer.isBuffer(body)).to.be.true();
    expect(body.indexOf(blob)).to.be.greaterThan(-1);
    const asText = body.toString('utf-8');
    expect(asText).to.match(/Content-Type: application\/octet-stream/i);
    expect(asText).to.match(/HTTP\/1\.1 200/);
  });

  it('serializes primitive bodies as JSON with appropriate headers', () => {
    const responses: BatchResponseEntry[] = [
      { status: 200, body: 42 },
      { status: 200, body: true },
    ];

    const { body } = serializeMultipartBatch(responses);
    const text = body.toString('utf-8');
    const matches = text.match(/Content-Type: application\/json; charset=utf-8/gi) ?? [];
    expect(matches.length).to.equal(2);
    expect(text).to.match(/HTTP\/1\.1 200/);
    expect(text).to.match(/\r?\n\r?\n42\r?\n/);
    expect(text).to.match(/\r?\n\r?\ntrue\r?\n/);
  });
});

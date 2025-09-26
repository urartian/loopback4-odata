/// <reference path="../../types/testing.globals.d.ts" />

import {Readable} from 'stream';
import {parseMultipartBatch} from '../../services/multipart-batch.parser';
import {expect} from '@loopback/testlab';

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
    expect(createReq.body).to.deepEqual({name: 'Tablet'});
    expect(updateReq.body).to.deepEqual({price: 1199});
    expect(listReq.method).to.equal('GET');
    expect(listReq.atomicityGroup).to.be.undefined();
  });
});

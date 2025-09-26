/// <reference path="../../types/testing.globals.d.ts" />

import {expect} from '@loopback/testlab';
import {serializeMultipartBatch} from '../../services/multipart-batch.serializer';
import {BatchResponseEntry} from '../../controllers/batch.controller';

describe('multipart batch serializer', () => {
  it('renders single and changeset responses with boundaries', () => {
    const responses: BatchResponseEntry[] = [
      {
        id: '1',
        status: 200,
        headers: {'content-type': 'application/json'},
        body: {value: []},
      },
      {
        id: '2',
        atomicityGroup: 'changeset_1',
        status: 201,
        headers: {'content-type': 'application/json'},
        body: {value: {id: 1}},
      },
      {
        id: '3',
        atomicityGroup: 'changeset_1',
        status: 204,
      },
    ];

    const {boundary, body} = serializeMultipartBatch(responses);
    expect(boundary).to.match(/^batch_/);
    expect(body).to.match(new RegExp(`--${boundary}`));
    expect(body).to.match(/Content-Type: multipart\/mixed/);
    expect(body).to.match(/HTTP\/1\.1 200/);
    expect(body).to.match(/HTTP\/1\.1 201/);
    expect(body).to.match(/HTTP\/1\.1 204/);
  });
});

import { createServerEnvironment, stopServerEnvironment } from '../lib/app';
import { configureLargeMediaHandler, ensureLargePayloadBytes } from '../lib/media-large';
import { BenchScenario } from '../types';

type MediaLargeState = {
  mediaAssetId: number;
  payload: Buffer;
};

export const mediaLargeScenario: BenchScenario = {
  name: 'media-large',
  description: 'Large media upload and download pass for payloads over 100 MiB',
  setup: async (options) => {
    ensureLargePayloadBytes(options.payloadBytes);

    const env = await createServerEnvironment(options, {
      configureApp(app) {
        configureLargeMediaHandler(app, options.payloadBytes);
      },
    });
    const client = env.client;
    if (!client) {
      throw new Error('Large media benchmark requires a REST client.');
    }

    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = Array.isArray(listing.body?.value) ? listing.body.value[0] : undefined;
    if (!asset?.id) {
      throw new Error('Large media benchmark could not resolve a seeded media asset.');
    }

    env.state = {
      ...(env.state ?? {}),
      mediaAssetId: asset.id,
      payload: Buffer.alloc(options.payloadBytes, 0x61),
    } satisfies MediaLargeState;

    return env;
  },
  async run(env) {
    const client = env.client;
    if (!client) {
      throw new Error('Large media benchmark requires a REST client.');
    }

    const state = env.state as MediaLargeState | undefined;
    const mediaAssetId = state?.mediaAssetId;
    const payload = state?.payload;
    if (!mediaAssetId || !payload) {
      throw new Error('Large media benchmark is missing its seeded state.');
    }

    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = Array.isArray(listing.body?.value)
      ? listing.body.value.find((entry: { id?: number }) => entry.id === mediaAssetId)
      : undefined;
    const etag = asset?.['@odata.mediaEtag'];
    if (typeof etag !== 'string') {
      throw new Error('Large media benchmark could not resolve the current media ETag.');
    }

    await client
      .put(`/odata/MediaAssets(${mediaAssetId})/$value`)
      .set('Content-Type', 'application/octet-stream')
      .set('If-Match', etag)
      .send(payload)
      .expect(204);

    await client
      .get(`/odata/MediaAssets(${mediaAssetId})/$value`)
      .buffer(true)
      .expect('Content-Length', String(payload.length))
      .expect(200);
  },
  cleanup: stopServerEnvironment,
};

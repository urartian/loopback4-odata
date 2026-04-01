import { createServerEnvironment, stopServerEnvironment } from '../lib/app';
import { BenchScenario } from '../types';

type MediaWriteState = {
  mediaAssetId: number;
  revision: number;
};

export const mediaWriteScenario: BenchScenario = {
  name: 'media-write',
  description: 'Media stream writes through $value endpoints',
  async setup(options) {
    const env = await createServerEnvironment(options);
    const client = env.client;
    if (!client) {
      throw new Error('Media-write benchmark requires a REST client.');
    }

    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = Array.isArray(listing.body?.value) ? listing.body.value[0] : undefined;
    if (!asset?.id) {
      throw new Error('Media-write benchmark could not resolve a seeded media asset.');
    }

    env.state = {
      ...(env.state ?? {}),
      mediaAssetId: asset.id,
      revision: 0,
    } satisfies MediaWriteState;

    return env;
  },
  async run(env) {
    const client = env.client;
    if (!client) {
      throw new Error('Media-write benchmark requires a REST client.');
    }

    const state = env.state as MediaWriteState | undefined;
    const mediaAssetId = state?.mediaAssetId;
    if (!mediaAssetId || !state) {
      throw new Error('Media-write benchmark is missing its seeded state.');
    }

    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = Array.isArray(listing.body?.value)
      ? listing.body.value.find((entry: { id?: number }) => entry.id === mediaAssetId)
      : undefined;
    const etag = asset?.['@odata.mediaEtag'];
    if (typeof etag !== 'string') {
      throw new Error('Media-write benchmark could not resolve the current media ETag.');
    }

    state.revision += 1;
    const payload = `benchmark-payload-${state.revision}`;

    await client
      .put(`/odata/MediaAssets(${mediaAssetId})/$value`)
      .set('Content-Type', 'text/plain')
      .set('If-Match', etag)
      .send(payload)
      .expect(204);
  },
  cleanup: stopServerEnvironment,
};

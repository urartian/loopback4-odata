import { createServerEnvironment, stopServerEnvironment } from '../lib/app';
import { BenchScenario } from '../types';

type MediaState = {
  mediaAssetId: number;
};

export const mediaScenario: BenchScenario = {
  name: 'media',
  description: 'Media stream reads through $value endpoints',
  async setup(options) {
    const env = await createServerEnvironment(options);
    const client = env.client;
    if (!client) {
      throw new Error('Media benchmark requires a REST client.');
    }

    const listing = await client.get('/odata/MediaAssets').expect(200);
    const asset = Array.isArray(listing.body?.value) ? listing.body.value[0] : undefined;
    if (!asset?.id) {
      throw new Error('Media benchmark could not resolve a seeded media asset.');
    }

    env.state = {
      ...(env.state ?? {}),
      mediaAssetId: asset.id,
    } satisfies MediaState;

    return env;
  },
  async run(env) {
    const client = env.client;
    if (!client) {
      throw new Error('Media benchmark requires a REST client.');
    }

    const state = env.state as MediaState | undefined;
    const mediaAssetId = state?.mediaAssetId;
    if (!mediaAssetId) {
      throw new Error('Media benchmark is missing its seeded asset id.');
    }

    await client
      .get(`/odata/MediaAssets(${mediaAssetId})/$value`)
      .set('Accept', 'text/plain')
      .expect(200);
  },
  cleanup: stopServerEnvironment,
};

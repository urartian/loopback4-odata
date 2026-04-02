import { BindingScope } from '@loopback/core';
import {
  MediaAssetRepository,
  TestApplication,
} from '../../src/__tests__/fixtures/odata-app.fixture';
import { ODATA_BINDINGS } from '../../src/keys';
import { PropertyBackedMediaHandler } from '../../src/services/odata-media-handler';

export const MIN_LARGE_PAYLOAD_BYTES = 100 * 1024 * 1024;

export function ensureLargePayloadBytes(payloadBytes: number): void {
  if (payloadBytes <= MIN_LARGE_PAYLOAD_BYTES) {
    throw new Error(
      `The media-large benchmark requires payload-bytes to exceed ${MIN_LARGE_PAYLOAD_BYTES} bytes (100 MiB).`,
    );
  }
}

export function configureLargeMediaHandler(app: TestApplication, payloadBytes: number): void {
  app
    .bind(`${ODATA_BINDINGS.MEDIA_HANDLERS.key}.MediaAssets`)
    .toDynamicValue(async () => {
      const repo = await app.getRepository(MediaAssetRepository);
      return new PropertyBackedMediaHandler(
        repo as unknown as ConstructorParameters<typeof PropertyBackedMediaHandler>[0],
        'data',
        {
          maxPayloadBytes: payloadBytes,
        },
      );
    })
    .inScope(BindingScope.REQUEST);
}

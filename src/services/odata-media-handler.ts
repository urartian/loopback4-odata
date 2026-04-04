import { DefaultCrudRepository, AnyObject, Options, Entity } from '@loopback/repository';
import { HttpErrors } from '@loopback/rest';
import { Readable } from 'stream';
import { EntitySetDef } from '../registry/entityset-registry';

/** Repository shape used by the built-in media handlers. */
export type ODataMediaRepository = DefaultCrudRepository<Entity & AnyObject, unknown>;

/** Shared context passed to custom media handlers for `$value` operations. */
export interface ODataMediaHandlerContext {
  id: unknown;
  /** @internal Internal entity-set definition currently handling the request. */
  entitySet: EntitySetDef;
  entity?: AnyObject;
  repository: ODataMediaRepository;
  options?: Options;
}

/** Context passed to `read()` handlers for media downloads. */
export interface ODataMediaReadContext extends ODataMediaHandlerContext {}

/** Result returned from `read()` describing the media stream and metadata. */
export interface ODataMediaReadResult {
  stream: Readable;
  contentType?: string;
  etag?: string;
  length?: number;
}

/** Context passed to `write()` handlers for media uploads. */
export interface ODataMediaWriteContext extends ODataMediaHandlerContext {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  slug?: string;
}

/** Result returned from `write()` describing persisted media metadata. */
export interface ODataMediaWriteResult {
  etag?: string;
  contentType?: string;
  length?: number;
}

/** Context passed to optional `delete()` handlers for media removal. */
export interface ODataMediaDeleteContext extends ODataMediaHandlerContext {}

/**
 * Custom media handler contract for `$value` endpoints.
 *
 * Implement this interface when binary payloads should be read from or written
 * to an external store instead of being buffered in entity properties.
 */
export interface ODataMediaHandler {
  read(ctx: ODataMediaReadContext): Promise<ODataMediaReadResult | undefined>;
  write(ctx: ODataMediaWriteContext): Promise<ODataMediaWriteResult | undefined>;
  delete?(ctx: ODataMediaDeleteContext): Promise<void>;
}

/** Repository-side convenience contract adapted by `RepositoryMediaHandlerAdapter`. */
export interface RepositoryMediaAdapterTarget {
  getMedia?: (
    id: unknown,
    options?: Options,
  ) =>
    | ODataMediaReadResult
    | Readable
    | Buffer
    | Promise<ODataMediaReadResult | Readable | Buffer | undefined>
    | undefined;
  setMedia?: (
    id: unknown,
    stream: Readable,
    metadata?: { contentType?: string; contentLength?: number; slug?: string },
    options?: Options,
  ) => ODataMediaWriteResult | Promise<ODataMediaWriteResult | void> | void;
  deleteMedia?: (id: unknown, options?: Options) => Promise<void> | void;
}

/** Options for the built-in property-backed media handler. */
export interface PropertyBackedMediaHandlerOptions {
  maxPayloadBytes?: number;
}

/** Default upload cap for the built-in property-backed media handler (10 MiB). */
export const DEFAULT_PROPERTY_MEDIA_PAYLOAD_LIMIT = 10 * 1024 * 1024; // 10 MiB

/**
 * Built-in media handler that stores binary payloads directly in an entity property.
 *
 * This is a convenient default for small/medium blobs. For large-file streaming,
 * prefer a custom `ODataMediaHandler` backed by object storage or another streaming store.
 */
export class PropertyBackedMediaHandler implements ODataMediaHandler {
  private readonly maxPayloadBytes: number;

  constructor(
    private readonly repository: ODataMediaRepository,
    private readonly field: string,
    options?: PropertyBackedMediaHandlerOptions,
  ) {
    this.maxPayloadBytes = this.normalizeMaxPayloadBytes(options?.maxPayloadBytes);
  }

  async read(ctx: ODataMediaReadContext): Promise<ODataMediaReadResult | undefined> {
    const entity = ctx.entity ?? (await this.loadEntity(ctx));
    if (!entity) return undefined;
    const value = entity[this.field];
    if (value === null || value === undefined) return undefined;
    const stream = this.toReadable(value);
    const length = this.estimateLength(value);
    return { stream, length };
  }

  async write(ctx: ODataMediaWriteContext): Promise<ODataMediaWriteResult | undefined> {
    this.enforceContentLengthLimit(ctx.contentLength);
    const buffer = await this.collectStream(ctx.stream);
    await this.repository.updateById(ctx.id as any, { [this.field]: buffer }, ctx.options);
    return { length: buffer.length };
  }

  async delete(ctx: ODataMediaDeleteContext): Promise<void> {
    await this.repository.updateById(ctx.id as any, { [this.field]: null }, ctx.options);
  }

  private async loadEntity(ctx: ODataMediaHandlerContext): Promise<AnyObject | undefined> {
    try {
      const entity = await this.repository.findById(
        ctx.id as any,
        { fields: { [this.field]: true } },
        ctx.options,
      );
      return entity as AnyObject;
    } catch {
      return undefined;
    }
  }

  private toReadable(value: unknown): Readable {
    if (value instanceof Readable) return value;
    if (Buffer.isBuffer(value)) return Readable.from(value);
    if (value instanceof Uint8Array) return Readable.from(Buffer.from(value));
    if (isSerializedBuffer(value)) {
      return Readable.from(Buffer.from(value.data));
    }
    throw new HttpErrors.InternalServerError('Media field must contain binary data.');
  }

  private estimateLength(value: unknown): number | undefined {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return value.length;
    }
    if (isSerializedBuffer(value)) {
      return value.data.length;
    }
    return undefined;
  }

  private collectStream(stream: Readable): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let rejected = false;

      const handleError = (error: Error) => {
        if (rejected) return;
        rejected = true;
        reject(error);
      };

      stream.on('data', (chunk: Buffer | string) => {
        if (rejected) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > this.maxPayloadBytes) {
          const error = this.buildPayloadTooLargeError();
          stream.destroy(error);
          return;
        }
        chunks.push(buffer);
      });
      stream.once('error', handleError);
      stream.once('end', () => {
        if (rejected) return;
        resolve(Buffer.concat(chunks, total));
      });
    });
  }

  private enforceContentLengthLimit(contentLength?: number) {
    if (
      typeof contentLength === 'number' &&
      Number.isFinite(contentLength) &&
      contentLength > this.maxPayloadBytes
    ) {
      throw this.buildPayloadTooLargeError();
    }
  }

  private buildPayloadTooLargeError(): HttpErrors.HttpError {
    return new HttpErrors.PayloadTooLarge(
      `Media payload exceeds the configured limit of ${this.maxPayloadBytes} bytes.`,
    );
  }

  private normalizeMaxPayloadBytes(limit?: number): number {
    if (limit === undefined || limit === null) return DEFAULT_PROPERTY_MEDIA_PAYLOAD_LIMIT;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error(
        'PropertyBackedMediaHandler maxPayloadBytes must be a positive finite number.',
      );
    }
    return limit;
  }
}

/**
 * Adapter that turns repository-level `getMedia` / `setMedia` / `deleteMedia`
 * methods into an `ODataMediaHandler`.
 */
export class RepositoryMediaHandlerAdapter implements ODataMediaHandler {
  constructor(
    private readonly repository: ODataMediaRepository & RepositoryMediaAdapterTarget,
  ) {}

  async read(ctx: ODataMediaReadContext): Promise<ODataMediaReadResult | undefined> {
    if (typeof this.repository.getMedia !== 'function') {
      throw new HttpErrors.NotImplemented('Repository does not expose getMedia().');
    }
    const result = await this.repository.getMedia(ctx.id, ctx.options);
    return this.normalizeReadResult(result);
  }

  async write(ctx: ODataMediaWriteContext): Promise<ODataMediaWriteResult | undefined> {
    if (typeof this.repository.setMedia !== 'function') {
      throw new HttpErrors.NotImplemented('Repository does not expose setMedia().');
    }
    const meta = {
      contentType: ctx.contentType,
      contentLength: ctx.contentLength,
      slug: ctx.slug,
    };
    const result = await this.repository.setMedia(ctx.id, ctx.stream, meta, ctx.options);
    if (!result) return undefined;
    if (this.isWriteResult(result)) return result;
    return undefined;
  }

  async delete(ctx: ODataMediaDeleteContext): Promise<void> {
    if (typeof this.repository.deleteMedia !== 'function') {
      throw new HttpErrors.NotImplemented('Repository does not expose deleteMedia().');
    }
    await this.repository.deleteMedia(ctx.id, ctx.options);
  }

  private normalizeReadResult(
    result: ODataMediaReadResult | Readable | Buffer | undefined,
  ): ODataMediaReadResult | undefined {
    if (!result) return undefined;
    if (this.isReadResult(result)) return result;
    if (result instanceof Readable) return { stream: result };
    if (Buffer.isBuffer(result)) {
      return { stream: Readable.from(result), length: result.length };
    }
    const serialized = result as unknown;
    if (isSerializedBuffer(serialized)) {
      const buffer = Buffer.from(serialized.data);
      return { stream: Readable.from(buffer), length: buffer.length };
    }
    throw new HttpErrors.InternalServerError(
      'Repository getMedia() must return a stream, Buffer, or ODataMediaReadResult.',
    );
  }

  private isReadResult(value: unknown): value is ODataMediaReadResult {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as AnyObject;
    const stream = candidate.stream;
    return Boolean(stream && typeof (stream as Readable).pipe === 'function');
  }

  private isWriteResult(value: unknown): value is ODataMediaWriteResult {
    return Boolean(value && typeof value === 'object');
  }
}

function isSerializedBuffer(
  value: unknown,
): value is { type?: string; data: Array<number> | Buffer | Uint8Array } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: string; data?: unknown };
  if (!Array.isArray(candidate.data)) return false;
  if (candidate.type && candidate.type !== 'Buffer') return false;
  return true;
}

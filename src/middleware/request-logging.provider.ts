import { inject, Provider } from '@loopback/core';
import { Middleware, MiddlewareContext } from '@loopback/rest';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import {
  ODataConfig,
  ODataRequestLoggingConfig,
  ODataRequestState,
  ODataTelemetryState,
} from '../types';
import { emitTelemetryEvent } from '../util/telemetry';

interface CapturedPayload {
  body?: unknown;
  truncated?: boolean;
}

export class RequestLoggingProvider implements Provider<Middleware> {
  constructor(
    @inject(ODATA_BINDINGS.CONFIG) private readonly cfg: ODataConfig,
    @inject(ODATA_BINDINGS.LOGGER, { optional: true }) private readonly logger?: ODataLogger,
  ) {}

  value(): Middleware {
    const basePath = this.normalizeBasePath(this.cfg?.basePath);

    return async (ctx, next) => {
      if (!this.isODataRequest(ctx.request.url ?? '', basePath)) {
        return next();
      }

      const state = this.resolveRequestState(ctx);
      const telemetry = state?.telemetry;
      const requestLogging = this.resolveRequestLoggingConfig(state, telemetry);
      if (!requestLogging?.enabled) return next();

      const startedAt = process.hrtime.bigint();
      const method = ctx.request.method ?? 'GET';
      const url = ctx.request.url ?? '';
      let result: unknown;
      let error: Error | undefined;

      try {
        result = await next();
        return result;
      } catch (err) {
        error = err as Error;
        throw err;
      } finally {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const status = ctx.response.statusCode ?? (error ? 500 : 200);
        const requestBodyCapture = this.captureRequestBody(ctx.request.body, requestLogging);
        const responseBodyCapture = requestLogging.includeResponseBody
          ? this.captureResponseBody(result, requestLogging.maxPayloadBytes ?? 32 * 1024)
          : undefined;

        emitTelemetryEvent(this.logger, state, {
          category: 'requests',
          event: 'request.log',
          requireSample: false,
          level: error ? 'warn' : 'info',
          context: {
            method,
            url,
            status,
            durationMs,
            headers: requestLogging.includeHeaders
              ? this.maskHeaders(ctx.request.headers ?? {}, requestLogging.maskHeaders ?? [])
              : undefined,
            requestBody: requestBodyCapture?.body,
            requestBodyTruncated: requestBodyCapture?.truncated || undefined,
            responseBody: responseBodyCapture?.body,
            responseBodyTruncated: responseBodyCapture?.truncated || undefined,
            error: error ? { message: error.message, name: error.name } : undefined,
          },
        });
      }
    };
  }

  private normalizeBasePath(configured?: string): string {
    let basePath = configured?.trim() ?? '';
    if (!basePath) return '/odata';
    if (!basePath.startsWith('/')) basePath = `/${basePath}`;
    if (basePath.length > 1 && basePath.endsWith('/')) {
      basePath = basePath.slice(0, -1);
    }
    return basePath || '/';
  }

  private isODataRequest(url: string, configuredBasePath: string): boolean {
    if (!url) return false;
    return this.pathMatches(url, '/odata') || this.pathMatches(url, configuredBasePath);
  }

  private pathMatches(path: string, base: string): boolean {
    if (!base) return false;
    return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`);
  }

  private resolveRequestState(ctx: MiddlewareContext): ODataRequestState | undefined {
    try {
      return ctx.getSync(ODATA_BINDINGS.REQUEST_STATE, { optional: true }) as
        | ODataRequestState
        | undefined;
    } catch {
      return undefined;
    }
  }

  private resolveRequestLoggingConfig(
    state: ODataRequestState | undefined,
    telemetry: ODataTelemetryState | undefined,
  ): ODataRequestLoggingConfig | undefined {
    const config = this.cfg?.telemetry?.requestLogging;
    const preferenceEnabled = state?.telemetryPreferences?.has('request-log');
    const globalEnabled = config?.enabled === true;
    if (!globalEnabled && !preferenceEnabled) return undefined;

    return {
      enabled: true,
      includeHeaders: config?.includeHeaders !== false,
      includeResponseBody: config?.includeResponseBody === true,
      maxPayloadBytes: config?.maxPayloadBytes ?? 32 * 1024,
      maskHeaders: config?.maskHeaders ?? ['authorization', 'cookie'],
      maskBodyPaths: config?.maskBodyPaths ?? [],
    };
  }

  private captureRequestBody(
    payload: unknown,
    config: ODataRequestLoggingConfig,
  ): CapturedPayload | undefined {
    if (payload == null) return undefined;
    const maxBytes = config.maxPayloadBytes ?? 32 * 1024;
    if (typeof payload === 'string') {
      const truncated = Buffer.byteLength(payload, 'utf8') > maxBytes;
      return {
        body: truncated ? payload.slice(0, maxBytes) : payload,
        truncated,
      };
    }
    if (typeof payload === 'object') {
      try {
        const clone = JSON.parse(JSON.stringify(payload));
        const masked = this.maskRequestBody(clone, config.maskBodyPaths ?? []);
        const serialized = JSON.stringify(masked);
        if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
          return { truncated: true };
        }
        return { body: masked };
      } catch {
        return { body: '[unserializable]' };
      }
    }
    return { body: payload };
  }

  private captureResponseBody(payload: unknown, maxBytes: number): CapturedPayload | undefined {
    if (payload == null) return undefined;
    if (typeof payload === 'string') {
      const truncated = Buffer.byteLength(payload, 'utf8') > maxBytes;
      return {
        body: truncated ? payload.slice(0, maxBytes) : payload,
        truncated,
      };
    }
    if (typeof payload === 'object') {
      try {
        const serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
          return { truncated: true };
        }
        return { body: payload };
      } catch {
        return { body: '[unserializable]' };
      }
    }
    return { body: payload };
  }

  private maskHeaders(
    headers: Record<string, unknown>,
    maskList: string[],
  ): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    const lowerMask = maskList.map((item) => item.toLowerCase());
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (lowerMask.includes(key.toLowerCase())) {
        masked[key] = '***';
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }

  private maskRequestBody(body: any, maskPaths: string[]): any {
    if (!body || typeof body !== 'object') return body;
    const clone = Array.isArray(body) ? [...body] : { ...body };
    for (const path of maskPaths) {
      if (!path) continue;
      if (Array.isArray(clone)) {
        const index = Number(path);
        if (!Number.isNaN(index) && index >= 0 && index < clone.length) {
          clone[index] = '***';
        }
      } else if (typeof clone === 'object' && path in clone) {
        clone[path] = '***';
      }
    }
    return clone;
  }
}

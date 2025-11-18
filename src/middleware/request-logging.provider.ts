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
    if (base === '/') {
      return path.startsWith('/');
    }
    if (path === base) return true;
    if (path.startsWith(`${base}/`)) return true;
    if (path.startsWith(`${base}?`)) return true;
    if (path.startsWith(`${base}#`)) return true;
    return false;
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
    const clone = this.cloneValue(body);
    for (const path of maskPaths) {
      const segments = this.parseMaskPath(path);
      if (!segments || !segments.length) continue;
      this.applyMaskAtPath(clone, segments);
    }
    return clone;
  }

  private parseMaskPath(path: string | undefined): Array<string | number> | undefined {
    if (!path || typeof path !== 'string') return undefined;
    const trimmed = path.trim();
    if (!trimmed) return undefined;
    const segments: Array<string | number> = [];
    let buffer = '';
    let index = 0;

    while (index < trimmed.length) {
      const char = trimmed[index];
      if (char === '.') {
        if (buffer) {
          const cleaned = buffer.trim();
          if (cleaned) segments.push(cleaned);
          buffer = '';
        }
        index += 1;
        continue;
      }
      if (char === '[') {
        if (buffer) {
          segments.push(buffer);
          buffer = '';
        }
        index += 1;
        let bracket = '';
        let closed = false;
        while (index < trimmed.length) {
          const next = trimmed[index];
          if (next === ']') {
            closed = true;
            index += 1;
            break;
          }
          bracket += next;
          index += 1;
        }
        if (!closed) return undefined;
        const token = bracket.trim();
        if (!token) return undefined;
        const unquoted =
          (token.startsWith('"') && token.endsWith('"')) ||
          (token.startsWith("'") && token.endsWith("'"))
            ? token.slice(1, -1)
            : token;
        if (/^-?\d+$/.test(unquoted)) {
          segments.push(Number(unquoted));
        } else {
          segments.push(unquoted);
        }
        continue;
      }
      buffer += char;
      index += 1;
    }

    if (buffer) {
      const cleaned = buffer.trim();
      if (cleaned) segments.push(cleaned);
    }

    return segments;
  }

  private applyMaskAtPath(target: unknown, segments: Array<string | number>): void {
    if (!segments.length) return;
    let current: unknown = target;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLast = i === segments.length - 1;
      if (isLast) {
        if (Array.isArray(current)) {
          const index = this.normalizeArrayIndex(segment);
          if (index === undefined || index < 0 || index >= current.length) return;
          current[index] = '***';
          return;
        }
        if (current && typeof current === 'object') {
          const key =
            typeof segment === 'number'
              ? String(segment)
              : typeof segment === 'string'
                ? segment
                : undefined;
          if (!key) return;
          if (Object.prototype.hasOwnProperty.call(current, key)) {
            (current as Record<string, unknown>)[key] = '***';
          }
        }
        return;
      }

      if (Array.isArray(current)) {
        const indexValue = this.normalizeArrayIndex(segment);
        if (indexValue === undefined || indexValue < 0 || indexValue >= current.length) return;
        current = current[indexValue];
        if (current === undefined || current === null) return;
        continue;
      }

      if (current && typeof current === 'object') {
        const key =
          typeof segment === 'number'
            ? String(segment)
            : typeof segment === 'string'
              ? segment
              : undefined;
        if (!key || !Object.prototype.hasOwnProperty.call(current, key)) return;
        current = (current as Record<string, unknown>)[key];
        if (current === undefined || current === null) return;
        continue;
      }

      return;
    }
  }

  private normalizeArrayIndex(segment: string | number): number | undefined {
    if (typeof segment === 'number') {
      return Number.isInteger(segment) ? segment : undefined;
    }
    if (typeof segment === 'string' && /^\d+$/.test(segment.trim())) {
      const parsed = Number(segment);
      return Number.isInteger(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private cloneValue(value: unknown): any {
    if (Array.isArray(value)) {
      return value.map((entry) => this.cloneValue(entry));
    }
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.cloneValue(entry);
      }
      return result;
    }
    return value;
  }
}

import { inject, Provider } from '@loopback/core';
import { AnyObject } from '@loopback/repository';
import { Middleware, MiddlewareContext, Request } from '@loopback/rest';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import {
  ODataConfig,
  ODataRequestLoggingConfig,
  ODataRequestState,
  ODataTelemetryState,
} from '../types';
import { emitTelemetryEvent } from '../util/telemetry';
import { gatherRequestUrls, normalizeBasePath, pathMatches } from '../util/base-path';

interface CapturedPayload {
  body?: unknown;
  truncated?: boolean;
}

interface CloneState {
  remaining: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

const DEFAULT_MAX_CAPTURE_DEPTH = 5;

export class RequestLoggingProvider implements Provider<Middleware> {
  static readonly MAX_CONTAINER_ENTRIES = 100;
  private static readonly ACCESSOR_PLACEHOLDER = '[Getter]';
  private static readonly NON_PLAIN_PLACEHOLDER = '[NonPlainObject]';

  constructor(
    @inject(ODATA_BINDINGS.CONFIG) private readonly cfg: ODataConfig,
    @inject(ODATA_BINDINGS.LOGGER, { optional: true }) private readonly logger?: ODataLogger,
  ) {}

  value(): Middleware {
    const basePath = normalizeBasePath(this.cfg?.basePath);

    return async (ctx, next) => {
      if (!this.isODataRequest(ctx.request, basePath)) {
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

  private isODataRequest(request: Request, configuredBasePath: string): boolean {
    const urls = gatherRequestUrls(request);
    for (const url of urls) {
      if (pathMatches(url, '/odata') || pathMatches(url, configuredBasePath)) {
        return true;
      }
    }
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
    const allowOverrides = config?.allowClientOverride === true;
    const preferenceEnabled = allowOverrides && state?.telemetryPreferences?.has('request-log');
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

  private cloneStructuredPayload(
    payload: unknown,
    maxBytes: number,
    maxDepth: number,
  ): CapturedPayload {
    const state: CloneState = {
      remaining: Math.max(0, maxBytes),
      truncated: false,
      seen: new WeakSet<object>(),
    };
    try {
      const body = this.cloneStructuredValue(payload, 0, maxDepth, state);
      return { body, truncated: state.truncated };
    } catch {
      return { body: '[unserializable]', truncated: true };
    }
  }

  private cloneStructuredValue(
    value: unknown,
    depth: number,
    maxDepth: number,
    state: CloneState,
  ): any {
    if (state.remaining <= 0) {
      state.truncated = true;
      return undefined;
    }
    if (value === null || typeof value !== 'object') {
      return this.clonePrimitiveValue(value, state);
    }
    if (Buffer.isBuffer(value)) {
      return this.clonePrimitiveValue(value.toString('base64'), state);
    }
    if (value instanceof Date) {
      return this.clonePrimitiveValue(value.toISOString(), state);
    }
    const isArray = Array.isArray(value);
    if (!isArray && !this.isPlainObject(value)) {
      return this.cloneNonPlainObject(state);
    }
    if (isArray && Object.getPrototypeOf(value) !== Array.prototype) {
      return this.cloneNonPlainObject(state);
    }
    if (state.seen.has(value as object)) {
      state.truncated = true;
      return '[Circular]';
    }
    if (depth >= maxDepth) {
      state.truncated = true;
      return '[MaxDepth]';
    }
    state.seen.add(value as object);
    try {
      if (isArray) {
        this.consumeBudget(state, 2); // brackets
        const cloned: unknown[] = [];
        let processed = 0;
        for (let index = 0; index < value.length; index += 1) {
          if (processed >= RequestLoggingProvider.MAX_CONTAINER_ENTRIES) {
            state.truncated = true;
            break;
          }
          if (!Object.prototype.hasOwnProperty.call(value, index)) continue;
          if (state.remaining <= 0) {
            state.truncated = true;
            break;
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || descriptor.enumerable === false) continue;
          if (this.hasAccessor(descriptor)) {
            const placeholder = this.cloneAccessorPlaceholder(state);
            cloned.push(placeholder);
            processed += 1;
            this.consumeBudget(state, 1); // comma
            continue;
          }
          const next = this.cloneStructuredValue(descriptor.value, depth + 1, maxDepth, state);
          if (next === undefined && state.truncated) break;
          cloned.push(next);
          processed += 1;
          this.consumeBudget(state, 1); // comma
        }
        return cloned;
      }
      if (this.isPlainObject(value) && typeof (value as AnyObject)?.toJSON === 'function') {
        try {
          const jsonValue = (value as AnyObject).toJSON();
          return this.cloneStructuredValue(jsonValue, depth + 1, maxDepth, state);
        } catch {
          state.truncated = true;
          return '[unserializable]';
        }
      }
      this.consumeBudget(state, 2); // braces
      const cloned: Record<string, unknown> = {};
      const source = value as Record<string, unknown>;
      let processed = 0;
      const descriptors = Object.getOwnPropertyDescriptors(source);
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        if (!descriptor || descriptor.enumerable === false) continue;
        if (processed >= RequestLoggingProvider.MAX_CONTAINER_ENTRIES) {
          state.truncated = true;
          break;
        }
        if (state.remaining <= 0) {
          state.truncated = true;
          break;
        }
        this.consumeBudget(state, this.keyBudget(key));
        if (state.remaining <= 0) {
          state.truncated = true;
          break;
        }
        if (this.hasAccessor(descriptor)) {
          const placeholder = this.cloneAccessorPlaceholder(state);
          cloned[key] = placeholder;
          processed += 1;
          continue;
        }
        const next = this.cloneStructuredValue(descriptor.value, depth + 1, maxDepth, state);
        if (next === undefined && state.truncated) break;
        cloned[key] = next;
        processed += 1;
      }
      return cloned;
    } finally {
      state.seen.delete(value as object);
    }
  }

  private clonePrimitiveValue(value: unknown, state: CloneState): any {
    if (value === null) {
      this.consumeBudget(state, 4);
      return null;
    }
    const type = typeof value;
    if (type === 'string') {
      return this.consumeStringValue(value as string, state);
    }
    if (type === 'number' || type === 'boolean') {
      this.consumeBudget(state, Buffer.byteLength(String(value), 'utf8'));
      return value;
    }
    if (type === 'bigint') {
      return this.consumeStringValue((value as bigint).toString(), state);
    }
    if (value === undefined) {
      this.consumeBudget(state, 4);
      return undefined;
    }
    if (type === 'symbol') {
      return this.consumeStringValue((value as symbol).toString(), state);
    }
    return value;
  }

  private consumeStringValue(value: string, state: CloneState): string {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= state.remaining) {
      state.remaining -= bytes;
      return value;
    }
    if (state.remaining <= 0) {
      state.truncated = true;
      return '';
    }
    const truncated = this.truncateStringByBytes(value, state.remaining);
    state.remaining = 0;
    state.truncated = true;
    return truncated;
  }

  private truncateStringByBytes(value: string, limit: number): string {
    if (limit <= 0) return '';
    let result = '';
    let consumed = 0;
    for (const char of value) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (consumed + charBytes > limit) break;
      consumed += charBytes;
      result += char;
    }
    return result;
  }

  private consumeBudget(state: CloneState, bytes: number): void {
    if (bytes <= 0) return;
    if (state.remaining <= 0) {
      state.truncated = true;
      return;
    }
    if (bytes > state.remaining) {
      state.remaining = 0;
      state.truncated = true;
      return;
    }
    state.remaining -= bytes;
  }

  private keyBudget(key: string): number {
    return Buffer.byteLength(key, 'utf8') + 4;
  }

  private hasAccessor(descriptor: PropertyDescriptor | undefined): boolean {
    if (!descriptor) return false;
    return typeof descriptor.get === 'function' || typeof descriptor.set === 'function';
  }

  private cloneAccessorPlaceholder(state: CloneState): string {
    state.truncated = true;
    return this.clonePrimitiveValue(RequestLoggingProvider.ACCESSOR_PLACEHOLDER, state);
  }

  private cloneNonPlainObject(state: CloneState): string {
    state.truncated = true;
    return this.clonePrimitiveValue(RequestLoggingProvider.NON_PLAIN_PLACEHOLDER, state);
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  private captureRequestBody(
    payload: unknown,
    config: ODataRequestLoggingConfig,
  ): CapturedPayload | undefined {
    if (payload == null) return undefined;
    const maxBytes = config.maxPayloadBytes ?? 32 * 1024;
    if (Buffer.isBuffer(payload)) {
      const truncated = payload.length > maxBytes;
      return {
        body: truncated
          ? payload.slice(0, maxBytes).toString('base64')
          : payload.toString('base64'),
        truncated,
      };
    }
    if (typeof payload === 'string') {
      const truncated = Buffer.byteLength(payload, 'utf8') > maxBytes;
      return {
        body: truncated ? payload.slice(0, maxBytes) : payload,
        truncated,
      };
    }
    if (typeof payload === 'object') {
      const cloned = this.cloneStructuredPayload(payload, maxBytes, DEFAULT_MAX_CAPTURE_DEPTH);
      if (!cloned.body && cloned.truncated) {
        return { truncated: true };
      }
      const masked = cloned.body
        ? this.maskRequestBody(cloned.body, config.maskBodyPaths ?? [], false)
        : undefined;
      return { body: masked, truncated: cloned.truncated || undefined };
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
      const cloned = this.cloneStructuredPayload(payload, maxBytes, DEFAULT_MAX_CAPTURE_DEPTH);
      return { body: cloned.body, truncated: cloned.truncated || undefined };
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

  private maskRequestBody(body: any, maskPaths: string[], cloneBody = true): any {
    if (!body || typeof body !== 'object') return body;
    const clone = cloneBody ? this.cloneValue(body) : body;
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
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return RequestLoggingProvider.NON_PLAIN_PLACEHOLDER;
      }
      const clone = new Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.enumerable === false) continue;
        if (this.hasAccessor(descriptor)) {
          clone[index] = RequestLoggingProvider.ACCESSOR_PLACEHOLDER;
          continue;
        }
        clone[index] = this.cloneValue(descriptor.value);
      }
      return clone;
    }
    if (value && typeof value === 'object') {
      if (!this.isPlainObject(value)) {
        return RequestLoggingProvider.NON_PLAIN_PLACEHOLDER;
      }
      const result: Record<string, unknown> = {};
      const descriptors = Object.getOwnPropertyDescriptors(value as AnyObject);
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        if (!descriptor || descriptor.enumerable === false) continue;
        if (this.hasAccessor(descriptor)) {
          result[key] = RequestLoggingProvider.ACCESSOR_PLACEHOLDER;
          continue;
        }
        result[key] = this.cloneValue(descriptor.value);
      }
      return result;
    }
    return value;
  }
}

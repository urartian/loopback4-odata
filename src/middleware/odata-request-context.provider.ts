import { BindingScope, inject, Provider } from '@loopback/core';
import { Middleware, Request } from '@loopback/rest';
import { AnyObject } from '@loopback/repository';
import { randomUUID } from 'node:crypto';
import { ODATA_BINDINGS } from '../keys';
import { EntitySetRegistry } from '../registry/entityset-registry';
import { ODATA_BATCH_DEPTH, ODATA_BATCH_DEPTH_PROP } from '../constants';
import {
  ODataConfig,
  ODataCorrelationConfig,
  ODataRequestState,
  ODataTelemetryConfig,
  ODataTelemetryCategory,
  ODataTelemetryState,
} from '../types';
import {
  buildODataRootRouteNames,
  gatherRequestUrls,
  matchesConfiguredODataPath,
  normalizeBasePath,
  pathMatches,
} from '../util/base-path';

type TelemetryPreference = 'statistics' | 'request-log';
type MiddlewareContext = Parameters<Middleware>[0];

export class ODataRequestContextProvider implements Provider<Middleware> {
  private cachedRootNames?: Set<string>;
  private cachedRegistryVersion = -1;

  constructor(
    @inject(ODATA_BINDINGS.CONFIG) private readonly cfg: ODataConfig,
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY, { optional: true })
    private readonly registry?: EntitySetRegistry,
  ) {}

  value(): Middleware {
    const basePath = normalizeBasePath(this.cfg?.basePath);

    return async (ctx, next) => {
      if (!this.isODataRequest(ctx.request, basePath)) {
        return next();
      }

      const requestState: ODataRequestState = {
        startedAtNs: process.hrtime.bigint(),
      };

      const batchDepth = this.readBatchDepth(ctx.request);
      if (batchDepth !== undefined) {
        requestState.batchDepth = batchDepth;
      }

      this.applyCorrelation(ctx, requestState, this.cfg?.correlation);
      this.applyTenantId(ctx, requestState);
      const preferences = this.parseTelemetryPreferences(ctx.request.header('prefer'));
      if (preferences.size) {
        requestState.telemetryPreferences = preferences;
      }
      this.applyTelemetry(ctx, requestState, preferences, this.cfg?.telemetry);

      ctx.bind(ODATA_BINDINGS.REQUEST_STATE).to(requestState).inScope(BindingScope.REQUEST);

      try {
        return await next();
      } finally {
        this.finalizeResponse(ctx, requestState, this.cfg?.telemetry);
      }
    };
  }

  private isODataRequest(request: Request, configuredBasePath: string): boolean {
    const urls = gatherRequestUrls(request);
    for (const url of urls) {
      if (
        pathMatches(url, '/odata') ||
        matchesConfiguredODataPath(url, configuredBasePath, this.getConfiguredRootRouteNames())
      ) {
        return true;
      }
    }
    return false;
  }

  private getConfiguredRootRouteNames(): ReadonlySet<string> | undefined {
    if (!this.registry) return undefined;
    const version = this.registry.getVersion();
    if (this.cachedRootNames && this.cachedRegistryVersion === version) {
      return this.cachedRootNames;
    }

    this.cachedRootNames = buildODataRootRouteNames(this.registry.list());
    this.cachedRegistryVersion = version;
    return this.cachedRootNames;
  }

  private applyCorrelation(
    ctx: MiddlewareContext,
    state: ODataRequestState,
    config?: ODataCorrelationConfig,
  ): void {
    if (config?.enabled === false) {
      return;
    }
    const headerName = (config?.headerName ?? 'x-correlation-id').toLowerCase();
    let correlationId = this.readHeader(ctx.request, headerName);
    if (!correlationId && config?.generateWhenMissing !== false) {
      correlationId = randomUUID();
    }
    if (correlationId) {
      state.correlationId = correlationId;
      const responseHeader = config?.responseHeaderName;
      if (responseHeader) {
        ctx.response.setHeader(responseHeader, correlationId);
      }
    }
  }

  private applyTenantId(ctx: MiddlewareContext, state: ODataRequestState): void {
    const resolver = this.cfg?.tenantResolver;
    if (!resolver) return;
    try {
      const resolved = resolver(ctx.request as any);
      if (typeof resolved === 'string' && resolved.trim().length) {
        state.tenantId = resolved;
      }
    } catch {
      // ignore tenant resolution errors in middleware; downstream guards may enforce tenancy
    }
  }

  private applyTelemetry(
    ctx: MiddlewareContext,
    state: ODataRequestState,
    preferences: Set<TelemetryPreference>,
    telemetry?: ODataTelemetryConfig,
  ): void {
    const allowClientOverrides = telemetry?.requestLogging?.allowClientOverride === true;
    const forcedRequestLogging = allowClientOverrides && preferences.has('request-log');
    const requestLoggingConfigured = telemetry?.requestLogging?.enabled === true;
    const telemetryEnabled = Boolean(telemetry?.enabled);
    const shouldEmitRequestLogs = requestLoggingConfigured || forcedRequestLogging;
    const effectiveEnabled = telemetryEnabled || shouldEmitRequestLogs;

    if (!effectiveEnabled) {
      state.telemetry = {
        enabled: false,
        level: telemetry?.level ?? 'info',
        sampled: false,
        includeApplyPlanOnFallback: Boolean(telemetry?.includeApplyPlanOnFallback),
      };
      return;
    }

    let categories: Set<ODataTelemetryCategory> | undefined;
    if (telemetryEnabled && telemetry?.categories && telemetry.categories.length > 0) {
      categories = new Set(telemetry.categories);
    } else if (!telemetryEnabled && shouldEmitRequestLogs) {
      categories = new Set(['requests']);
    }
    const level = telemetry?.level ?? 'info';
    const sampleRate = telemetry?.sampleRate ?? 1;
    const sampled =
      !telemetryEnabled && shouldEmitRequestLogs
        ? true
        : sampleRate >= 1
          ? true
          : Math.random() < sampleRate;

    const telemetryState: ODataTelemetryState = {
      enabled: effectiveEnabled,
      level,
      categories,
      sampled,
      includeApplyPlanOnFallback: Boolean(telemetry?.includeApplyPlanOnFallback),
      emitStatisticsHeader: telemetryEnabled && Boolean(telemetry?.emitStatisticsHeader),
      statisticsHeaderName: telemetry?.statisticsHeaderName ?? 'OData-Statistics',
      statisticsPrecision: telemetry?.statisticsPrecision ?? 2,
    };

    if (shouldEmitRequestLogs) {
      telemetryState.requestLoggingEnabled = true;
      if (categories) {
        categories.add('requests');
      } else if (telemetryEnabled) {
        telemetryState.categories = undefined;
      } else {
        telemetryState.categories = new Set(['requests']);
      }
    }

    state.telemetry = telemetryState;

    if (
      preferences.has('statistics') &&
      telemetryState.emitStatisticsHeader &&
      telemetryState.enabled
    ) {
      state.statistics = {
        requested: true,
        startTimeNs: state.startedAtNs ?? process.hrtime.bigint(),
        dbTimeNs: BigInt(0),
        roundTrips: 0,
        rows: 0,
      };
      this.appendPreferenceApplied(ctx.response, 'telemetry=statistics');
    }
    if (forcedRequestLogging) {
      this.appendPreferenceApplied(ctx.response, 'telemetry=request-log');
    }
  }

  private parseTelemetryPreferences(
    header: string | string[] | undefined,
  ): Set<TelemetryPreference> {
    const preferences = new Set<TelemetryPreference>();
    if (!header) return preferences;
    const values = Array.isArray(header) ? header : [header];
    for (const raw of values) {
      if (!raw) continue;
      const segments = raw.split(',');
      for (const segment of segments) {
        const [token, value] = segment.split('=');
        if (!token) continue;
        if (token.trim().toLowerCase() !== 'telemetry') continue;
        const normalized = (value ?? '')
          .trim()
          .replace(/^\"(.*)\"$/, '$1')
          .toLowerCase();
        if (normalized === 'statistics') {
          preferences.add('statistics');
        } else if (normalized === 'request-log' || normalized === 'requestlog') {
          preferences.add('request-log');
        }
      }
    }
    return preferences;
  }

  private finalizeResponse(
    ctx: MiddlewareContext,
    state: ODataRequestState,
    telemetry?: ODataTelemetryConfig,
  ): void {
    if (!state.statistics || !telemetry?.emitStatisticsHeader) return;
    if (ctx.response.headersSent) return;

    const endedAt = process.hrtime.bigint();
    const startedAt = state.startedAtNs ?? endedAt;
    const processingNs = endedAt - startedAt;
    const precision = telemetry.statisticsPrecision ?? 2;

    const statsPayload = {
      processingTime: this.roundNumber(Number(processingNs) / 1e6, precision),
      dbTime: this.roundNumber(Number(state.statistics.dbTimeNs) / 1e6, precision),
      roundTrips: state.statistics.roundTrips,
      rows: state.statistics.rows,
    };

    const headerName = telemetry.statisticsHeaderName ?? 'OData-Statistics';
    ctx.response.setHeader(headerName, JSON.stringify(statsPayload));
    this.appendPreferenceApplied(ctx.response, 'telemetry=statistics');
  }

  private readHeader(
    request: MiddlewareContext['request'],
    headerName: string,
  ): string | undefined {
    const raw = request.header(headerName);
    if (!raw) return undefined;
    if (Array.isArray(raw)) return raw[0];
    const value = raw.toString().trim();
    return value.length > 0 ? value : undefined;
  }

  private readBatchDepth(request: MiddlewareContext['request']): number | undefined {
    const carriers: Array<unknown> = [
      request,
      (request as AnyObject)?.res,
      (request as AnyObject)?.socket,
      (request as AnyObject)?.connection,
    ];
    for (const carrier of carriers) {
      const depth = this.extractBatchDepth(carrier);
      if (depth !== undefined) return depth;
    }
    return undefined;
  }

  private extractBatchDepth(carrier: unknown): number | undefined {
    if (!carrier || typeof carrier !== 'object') return undefined;
    const depth =
      (Reflect.get(carrier as object, ODATA_BATCH_DEPTH) as number | undefined) ??
      ((carrier as AnyObject)[ODATA_BATCH_DEPTH_PROP] as number | undefined);
    if (typeof depth === 'number' && Number.isFinite(depth) && depth >= 0) {
      return Math.floor(depth);
    }
    return undefined;
  }

  private appendPreferenceApplied(response: MiddlewareContext['response'], token: string) {
    const existing =
      typeof response.getHeader === 'function'
        ? response.getHeader('Preference-Applied')
        : undefined;
    if (!existing) {
      response.setHeader('Preference-Applied', token);
      return;
    }

    const normalized = Array.isArray(existing) ? existing.join(', ') : existing.toString();
    if (normalized.toLowerCase().includes(token.toLowerCase())) return;
    response.setHeader('Preference-Applied', `${normalized}, ${token}`);
  }

  private roundNumber(value: number, precision?: number): number {
    if (!Number.isFinite(value)) return value;
    const decimals = Math.max(0, precision ?? 2);
    return Number(value.toFixed(decimals));
  }
}

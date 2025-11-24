import { BindingScope, inject, Provider } from '@loopback/core';
import { Middleware, Request } from '@loopback/rest';
import { randomUUID } from 'node:crypto';
import { ODATA_BINDINGS } from '../keys';
import {
  ODataConfig,
  ODataCorrelationConfig,
  ODataRequestState,
  ODataTelemetryConfig,
  ODataTelemetryCategory,
  ODataTelemetryState,
} from '../types';
import { gatherRequestUrls, normalizeBasePath, pathMatches } from '../util/base-path';

type TelemetryPreference = 'statistics' | 'request-log';
type MiddlewareContext = Parameters<Middleware>[0];

export class ODataRequestContextProvider implements Provider<Middleware> {
  constructor(@inject(ODATA_BINDINGS.CONFIG) private readonly cfg: ODataConfig) {}

  value(): Middleware {
    const basePath = normalizeBasePath(this.cfg?.basePath);

    return async (ctx, next) => {
      if (!this.isODataRequest(ctx.request, basePath)) {
        return next();
      }

      const requestState: ODataRequestState = {
        startedAtNs: process.hrtime.bigint(),
      };

      this.applyCorrelation(ctx, requestState, this.cfg?.correlation);
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
      if (pathMatches(url, '/odata') || pathMatches(url, configuredBasePath)) {
        return true;
      }
    }
    return false;
  }

  private applyCorrelation(
    ctx: MiddlewareContext,
    state: ODataRequestState,
    config?: ODataCorrelationConfig,
  ): void {
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

  private applyTelemetry(
    ctx: MiddlewareContext,
    state: ODataRequestState,
    preferences: Set<TelemetryPreference>,
    telemetry?: ODataTelemetryConfig,
  ): void {
    const forcedRequestLogging = preferences.has('request-log');
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

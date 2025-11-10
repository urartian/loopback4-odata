import { BindingScope, inject, Provider } from '@loopback/core';
import { Middleware } from '@loopback/rest';
import { randomUUID } from 'node:crypto';
import { ODATA_BINDINGS } from '../keys';
import {
  ODataConfig,
  ODataCorrelationConfig,
  ODataRequestState,
  ODataTelemetryConfig,
  ODataTelemetryState,
} from '../types';

type TelemetryPreference = 'statistics';
type MiddlewareContext = Parameters<Middleware>[0];

export class ODataRequestContextProvider implements Provider<Middleware> {
  constructor(@inject(ODATA_BINDINGS.CONFIG) private readonly cfg: ODataConfig) {}

  value(): Middleware {
    const basePath = this.normalizeBasePath(this.cfg?.basePath);

    return async (ctx, next) => {
      if (!this.isODataRequest(ctx.request.url ?? '', basePath)) {
        return next();
      }

      const requestState: ODataRequestState = {
        startedAtNs: process.hrtime.bigint(),
      };

      this.applyCorrelation(ctx, requestState, this.cfg?.correlation);
      this.applyTelemetry(ctx, requestState, this.cfg?.telemetry);

      ctx.bind(ODATA_BINDINGS.REQUEST_STATE).to(requestState).inScope(BindingScope.REQUEST);

      try {
        return await next();
      } finally {
        this.finalizeResponse(ctx, requestState, this.cfg?.telemetry);
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
    telemetry?: ODataTelemetryConfig,
  ): void {
    const enabled = Boolean(telemetry?.enabled);
    if (!enabled) {
      state.telemetry = {
        enabled: false,
        level: telemetry?.level ?? 'info',
        sampled: false,
        includeApplyPlanOnFallback: Boolean(telemetry?.includeApplyPlanOnFallback),
      };
      return;
    }

    const categories =
      telemetry?.categories && telemetry.categories.length > 0
        ? new Set(telemetry.categories)
        : undefined;
    const level = telemetry?.level ?? 'info';
    const sampleRate = telemetry?.sampleRate ?? 1;
    const sampled = sampleRate >= 1 ? true : Math.random() < sampleRate;

    const telemetryState: ODataTelemetryState = {
      enabled: true,
      level,
      categories,
      sampled,
      includeApplyPlanOnFallback: Boolean(telemetry?.includeApplyPlanOnFallback),
      emitStatisticsHeader: Boolean(telemetry?.emitStatisticsHeader),
      statisticsHeaderName: telemetry?.statisticsHeaderName ?? 'OData-Statistics',
      statisticsPrecision: telemetry?.statisticsPrecision ?? 2,
    };

    state.telemetry = telemetryState;

    const preference = this.parseTelemetryPreference(ctx.request.header('prefer'));
    if (
      preference === 'statistics' &&
      telemetryState.emitStatisticsHeader &&
      telemetryState.enabled
    ) {
      state.telemetryPreference = preference;
      state.statistics = {
        requested: true,
        startTimeNs: state.startedAtNs ?? process.hrtime.bigint(),
        dbTimeNs: BigInt(0),
        roundTrips: 0,
        rows: 0,
      };
    }
  }

  private parseTelemetryPreference(
    header: string | string[] | undefined,
  ): TelemetryPreference | undefined {
    if (!header) return undefined;
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
          .replace(/^"(.*)"$/, '$1')
          .toLowerCase();
        if (normalized === 'statistics') {
          return 'statistics';
        }
      }
    }
    return undefined;
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

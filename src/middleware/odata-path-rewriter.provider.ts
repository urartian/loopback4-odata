import { inject, Provider } from '@loopback/core';
import { Middleware, MiddlewareContext } from '@loopback/rest';
import { rewriteODataUrl } from './odata-path-rewriter';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import { ODataConfig, ODataRequestState } from '../types';
import { emitTelemetryEvent } from '../util/telemetry';
import { RequestContext } from '@loopback/rest';
import { EntitySetRegistry } from '../registry/entityset-registry';
import {
  findMatchingRequestUrl,
  normalizeBasePath,
  pathMatches,
  stripBasePath,
} from '../util/base-path';

export class OdataPathRewriterProvider implements Provider<Middleware> {
  constructor(
    @inject(ODATA_BINDINGS.CONFIG) private readonly cfg: ODataConfig,
    @inject(ODATA_BINDINGS.LOGGER) private readonly logger: ODataLogger,
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY) private readonly registry: EntitySetRegistry,
  ) {}

  value(): Middleware {
    const basePath = normalizeBasePath(this.cfg?.basePath);
    const needsRewrite = basePath !== '/odata';
    let cachedOperationNames: Set<string> | undefined;

    const middleware: Middleware = async (ctx, next) => {
      const originalUrl = ctx.request.originalUrl ?? ctx.request.url ?? '';
      let basePathRewritten = false;
      let targetsODataRoute = false;

      if (needsRewrite) {
        const currentUrl = ctx.request.url || '';
        const alreadyCanonical = pathMatches(currentUrl, '/odata');
        if (!alreadyCanonical) {
          const match = findMatchingRequestUrl(ctx.request, basePath);
          if (match) {
            ctx.request.url = '/odata' + stripBasePath(match, basePath);
            basePathRewritten = true;
          }
        }
      }

      const normalizedUrl = ctx.request.url || '';
      if (pathMatches(normalizedUrl, '/odata')) {
        targetsODataRoute = true;
      }

      let keyRewritten = false;
      if (targetsODataRoute) {
        if (!cachedOperationNames) {
          cachedOperationNames = new Set<string>();
          for (const def of this.registry.list()) {
            for (const op of def.actions ?? []) cachedOperationNames.add(op.name);
            for (const op of def.functions ?? []) cachedOperationNames.add(op.name);
          }
        }
        const rewritten = rewriteODataUrl(normalizedUrl, {
          namespace: this.cfg?.namespace,
          namespaceAlias: this.cfg?.namespaceAlias,
          operationNames: cachedOperationNames,
        });
        keyRewritten = rewritten !== normalizedUrl;
        if (keyRewritten) {
          ctx.request.url = rewritten;
        }
      }

      if (basePathRewritten || keyRewritten) {
        this.resetRequestUrlState(ctx.request);
        this.emitRewriteTelemetry(ctx, {
          originalUrl,
          rewrittenUrl: ctx.request.url ?? originalUrl,
          basePath,
          mode:
            basePathRewritten && keyRewritten ? 'base-and-key' : basePathRewritten ? 'base' : 'key',
        });
      }

      return next();
    };

    return middleware;
  }

  private resetRequestUrlState(request: unknown): void {
    const req = request as any;
    if (!req || typeof req !== 'object') return;
    try {
      delete req._parsedUrl;
      delete req._parsedOriginalUrl;
      delete req._query;
      if (Object.prototype.hasOwnProperty.call(req, 'query')) {
        delete req.query;
      }
    } catch {
      // Best-effort: URL rewrite must never fail the request pipeline.
    }

    // LoopBack may read query params early. Ensure consumers see the rewritten query string.
    const url = typeof req.url === 'string' ? req.url : '';
    const queryIndex = url.indexOf('?');
    const hashIndex = url.indexOf('#');
    const queryString =
      queryIndex >= 0 ? url.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined) : '';
    req.query = parseQueryString(queryString);
  }

  private emitRewriteTelemetry(ctx: MiddlewareContext, context: Record<string, unknown>) {
    emitTelemetryEvent(this.logger, this.getRequestState(ctx), {
      category: 'rewrite',
      event: 'path-rewrite',
      level: 'debug',
      context,
    });
  }

  private getRequestState(ctx: MiddlewareContext): ODataRequestState | undefined {
    try {
      return (ctx as RequestContext).getSync(ODATA_BINDINGS.REQUEST_STATE, {
        optional: true,
      }) as ODataRequestState | undefined;
    } catch {
      return undefined;
    }
  }
}

function parseQueryString(query: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!query) return result;

  try {
    const params = new URLSearchParams(query);
    for (const [key, value] of params.entries()) {
      const existing = result[key];
      if (existing === undefined) {
        result[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    }
  } catch {
    return result;
  }

  return result;
}

import { inject, Provider } from '@loopback/core';
import { Middleware, MiddlewareContext } from '@loopback/rest';
import { rewriteODataUrl } from './odata-path-rewriter';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import { ODataConfig, ODataRequestState } from '../types';
import { emitTelemetryEvent } from '../util/telemetry';
import { RequestContext } from '@loopback/rest';
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
  ) {}

  value(): Middleware {
    const basePath = normalizeBasePath(this.cfg?.basePath);
    const needsRewrite = basePath !== '/odata';

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
        const rewritten = rewriteODataUrl(normalizedUrl, {
          namespace: this.cfg?.namespace,
          namespaceAlias: this.cfg?.namespaceAlias,
        });
        keyRewritten = rewritten !== normalizedUrl;
        if (keyRewritten) {
          ctx.request.url = rewritten;
        }
      }

      if (basePathRewritten || keyRewritten) {
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

import { inject, Provider } from '@loopback/core';
import { Middleware, MiddlewareContext } from '@loopback/rest';
import { rewriteODataUrl } from './odata-path-rewriter';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import { ODataConfig, ODataRequestState } from '../types';
import { emitTelemetryEvent } from '../util/telemetry';
import { RequestContext } from '@loopback/rest';

export class OdataPathRewriterProvider implements Provider<Middleware> {
  constructor(
    @inject(ODATA_BINDINGS.CONFIG) private readonly cfg: ODataConfig,
    @inject(ODATA_BINDINGS.LOGGER) private readonly logger: ODataLogger,
  ) {}

  value(): Middleware {
    const normalizeBasePath = (configured?: string): string => {
      let basePath = configured?.trim() ?? '';
      if (!basePath) return '/odata';
      if (!basePath.startsWith('/')) basePath = `/${basePath}`;
      if (basePath.length > 1 && basePath.endsWith('/')) {
        basePath = basePath.slice(0, -1);
      }
      return basePath || '/';
    };

    const basePath = normalizeBasePath(this.cfg?.basePath);
    const needsRewrite = basePath !== '/odata';

    const middleware: Middleware = async (ctx, next) => {
      const originalUrl = ctx.request.url ?? '';
      let basePathRewritten = false;

      if (needsRewrite) {
        const url = ctx.request.url || '';
        if (url === basePath || url.startsWith(basePath + '/') || url.startsWith(basePath + '?')) {
          ctx.request.url = '/odata' + url.substring(basePath.length);
          basePathRewritten = true;
        }
      }

      const afterBaseRewrite = ctx.request.url ?? '';
      const rewritten = rewriteODataUrl(afterBaseRewrite);
      const keyRewritten = rewritten !== afterBaseRewrite;
      if (keyRewritten) {
        ctx.request.url = rewritten;
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

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
    const basePath = this.normalizeBasePath(this.cfg?.basePath);
    const needsRewrite = basePath !== '/odata';

    const middleware: Middleware = async (ctx, next) => {
      const originalUrl = ctx.request.url ?? '';
      let basePathRewritten = false;
      let targetsODataRoute = false;

      if (needsRewrite) {
        const url = ctx.request.url || '';
        if (this.pathMatches(url, basePath)) {
          ctx.request.url = '/odata' + this.stripBasePath(url, basePath);
          basePathRewritten = true;
        }
      }

      const normalizedUrl = ctx.request.url || '';
      if (this.pathMatches(normalizedUrl, '/odata')) {
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

  private normalizeBasePath(configured?: string): string {
    let basePath = configured?.trim() ?? '';
    if (!basePath) return '/odata';
    if (!basePath.startsWith('/')) basePath = `/${basePath}`;
    if (basePath.length > 1 && basePath.endsWith('/')) {
      basePath = basePath.slice(0, -1);
    }
    return basePath || '/';
  }

  private pathMatches(url: string, basePath: string): boolean {
    if (!basePath) return false;
    if (basePath === '/') {
      return url.startsWith('/');
    }
    if (url === basePath) return true;
    if (url.startsWith(basePath + '/')) return true;
    if (url.startsWith(basePath + '?')) return true;
    if (url.startsWith(basePath + '#')) return true;
    return false;
  }

  private stripBasePath(url: string, basePath: string): string {
    if (basePath === '/') {
      const remainder = url.slice(1);
      if (!remainder) return '';
      if (remainder.startsWith('?') || remainder.startsWith('#')) {
        return remainder;
      }
      return `/${remainder}`;
    }
    const remainder = url.substring(basePath.length);
    return remainder || '/';
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

import { inject, Provider } from '@loopback/core';
import { Middleware } from '@loopback/rest';
import { odataPathRewriter } from './odata-path-rewriter';
import { ODATA_BINDINGS } from '../keys';
import { ODataConfig } from '../types';

export class OdataPathRewriterProvider implements Provider<Middleware> {
    constructor(
        @inject(ODATA_BINDINGS.CONFIG) private readonly cfg: ODataConfig,
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
            if (needsRewrite) {
                const url = ctx.request.url || '';
                if (url === basePath || url.startsWith(basePath + '/') || url.startsWith(basePath + '?')) {
                    ctx.request.url = '/odata' + url.substring(basePath.length);
                }
            }
            return odataPathRewriter(ctx, next);
        };

        return middleware;
    }
}

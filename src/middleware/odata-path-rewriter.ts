import { Middleware, MiddlewareContext } from '@loopback/rest';

/**
 * Middleware to rewrite OData-style entity paths `(id)` into OpenAPI-compliant `/id`.
 *
 * Example:
 *   /odata/Products(1) -> /odata/Products/1
 *   /odata/Orders('abc') -> /odata/Orders/abc
 */
export const odataPathRewriter: Middleware = (ctx: MiddlewareContext, next) => {
    ctx.request.url = ctx.request.url.replace(
        /\/(\w+)\(([^)]+)\)/g,
        (_match, set, id) => `/${set}/${id}`,
    );
    return next();
};

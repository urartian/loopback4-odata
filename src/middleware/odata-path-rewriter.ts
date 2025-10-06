import { Middleware, MiddlewareContext } from '@loopback/rest';

/**
 * Middleware to rewrite OData-style entity paths `(id)` into OpenAPI-compliant `/id`.
 *
 * Example:
 *   /odata/Products(1) -> /odata/Products/1
 *   /odata/Orders('abc') -> /odata/Orders/abc
 */
function normalizeKeyLiteral(raw: string): string {
    const decoded = decodeURIComponent(raw);
    let literal = decoded.trim();

    const guidPrefix = /^guid'/i;
    if (guidPrefix.test(literal)) {
        literal = literal.replace(guidPrefix, '');
        if (literal.endsWith("'")) literal = literal.slice(0, -1);
    }

    if (literal.startsWith("'") && literal.endsWith("'")) {
        literal = literal.slice(1, -1);
    }

    literal = literal.replace(/''/g, "'");
    return literal;
}

export const odataPathRewriter: Middleware = (ctx: MiddlewareContext, next) => {
    ctx.request.url = ctx.request.url.replace(
        /(\/(\w+))\(([^)]+)\)/g,
        (_match, prefix, set, id) => {
            const normalized = normalizeKeyLiteral(id);
            const encoded = encodeURIComponent(normalized).replace(/'/g, '%27');
            return `${prefix}/${encoded}`;
        },
    );
    return next();
};

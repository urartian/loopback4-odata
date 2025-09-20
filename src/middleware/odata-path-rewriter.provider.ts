import { Provider } from '@loopback/core';
import { Middleware } from '@loopback/rest';
import { odataPathRewriter } from './odata-path-rewriter';

export class OdataPathRewriterProvider implements Provider<Middleware> {
    value(): Middleware {
        return odataPathRewriter;
    }
}

import { Component, Binding, BindingScope } from '@loopback/core';
import { createMiddlewareBinding } from '@loopback/rest';
import { ODataConfig } from './types';
import { ODATA_BINDINGS } from './keys';
import { CsdlGenerator } from './metadata/csdl-generator';
import { ODataMetadataController } from './controllers/metadata.controller';
import { EntitySetRegistry } from './registry/entityset-registry';
import { ODataBooter } from './booters/odata.booter';
import { OdataPathRewriterProvider } from './middleware/odata-path-rewriter.provider';

export class ODataComponent implements Component {
    bindings = [
        Binding.bind(ODATA_BINDINGS.CONFIG).to({ basePath: '/odata' } as ODataConfig),
        Binding.bind(ODATA_BINDINGS.CSDL_GEN).toClass(CsdlGenerator).inScope(BindingScope.SINGLETON),
        Binding.bind(ODATA_BINDINGS.ENTITY_SET_REGISTRY).toClass(EntitySetRegistry).inScope(BindingScope.SINGLETON),
        createMiddlewareBinding(OdataPathRewriterProvider, {
            key: 'middleware.odataPathRewriter',
        }),
    ];

    controllers = [ODataMetadataController];
    booters = [ODataBooter];
}

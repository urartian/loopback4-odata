import { Component, Binding, BindingScope } from '@loopback/core';
import { RestBindings, createMiddlewareBinding } from '@loopback/rest';
import { ODataConfig } from './types';
import { ODATA_BINDINGS } from './keys';
import { CsdlGenerator } from './metadata/csdl-generator';
import { ODataMetadataController } from './controllers/metadata.controller';
import { ODataBatchController } from './controllers/batch.controller';
import { ODataServiceDocumentController } from './controllers/service-document.controller';
import { EntitySetRegistry } from './registry/entityset-registry';
import { ODataBooter } from './booters/odata.booter';
import { OdataPathRewriterProvider } from './middleware/odata-path-rewriter.provider';
import { ODataErrorProvider } from './providers/odata-error.provider';
import { ODataApplyExecutorRegistry } from './services/odata-apply-executor.registry';
import { PostgresApplyExecutor } from './services/postgres-apply-executor';

export class ODataComponent implements Component {
    bindings = [
        Binding.bind(ODATA_BINDINGS.CONFIG).to({
            basePath: '/odata',
            strict: true,
            namespace: 'Default',
            entityContainerName: 'DefaultContainer',
            searchMode: 'annotated',
            maxSearchFields: 5,
            maxSearchTerms: 5,
            maxApplyResultSize: 2000,
            capabilities: {
                aggregation: true,
                applySupported: true,
            },
            logApplyTelemetry: false,
            maxApplyNavigationFanout: 1000,
        } as ODataConfig),
        Binding.bind(ODATA_BINDINGS.CSDL_GEN).toClass(CsdlGenerator).inScope(BindingScope.SINGLETON),
        Binding.bind(ODATA_BINDINGS.ENTITY_SET_REGISTRY).toClass(EntitySetRegistry).inScope(BindingScope.SINGLETON),
        Binding.bind(ODATA_BINDINGS.APPLY_EXECUTOR_REGISTRY)
            .toDynamicValue(() => {
                const registry = new ODataApplyExecutorRegistry();
                registry.register(new PostgresApplyExecutor());
                return registry;
            })
            .inScope(BindingScope.SINGLETON),
        createMiddlewareBinding(OdataPathRewriterProvider, {
            key: 'middleware.odataPathRewriter',
        }),
        Binding.bind(RestBindings.SequenceActions.REJECT)
            .toProvider(ODataErrorProvider)
            .inScope(BindingScope.SINGLETON),
    ];

    controllers = [ODataMetadataController, ODataBatchController, ODataServiceDocumentController];
    booters = [ODataBooter];
}

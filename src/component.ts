import { Component, Binding, BindingScope, createBindingFromClass } from '@loopback/core';
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
import { MySqlApplyExecutor } from './services/mysql-apply-executor';
import { ODataVisibilitySpecEnhancer } from './spec/odata-visibility.spec-enhancer';
import { ODataLoggerProvider } from './providers/odata-logger.provider';
import { ODataConfigValidatorObserver } from './observers/odata-config.validator';

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
      pageSize: 200,
      enableDelta: false,
      capabilities: {
        aggregation: true,
        applySupported: true,
      },
      logApplyTelemetry: false,
      maxApplyNavigationFanout: 1000,
      documentInOpenApiDefault: 'auto',
      removeUndocumentedFromSpec: true,
      skipTokenTtl: 900,
      deltaTokenTtl: 604800,
      allowLegacyUnsignedTokens: false,
      batch: {
        maxPayloadBytes: 16 * 1024 * 1024,
        maxOperations: 100,
        maxChangesetOperations: 50,
        maxDepth: 2,
        maxPartBodyBytes: 4 * 1024 * 1024,
      },
      pagination: {
        maxPageSize: 200,
        maxApplyPageSize: 200,
      },
    } as ODataConfig),
    Binding.bind(ODATA_BINDINGS.CSDL_GEN).toClass(CsdlGenerator).inScope(BindingScope.SINGLETON),
    Binding.bind(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
      .toClass(EntitySetRegistry)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ODATA_BINDINGS.LOGGER)
      .toProvider(ODataLoggerProvider)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ODATA_BINDINGS.APPLY_EXECUTOR_REGISTRY)
      .toDynamicValue(() => {
        const registry = new ODataApplyExecutorRegistry();
        registry.register(new PostgresApplyExecutor());
        registry.register(new MySqlApplyExecutor());
        return registry;
      })
      .inScope(BindingScope.SINGLETON),
    createMiddlewareBinding(OdataPathRewriterProvider, {
      key: 'middleware.odataPathRewriter',
    }),
    Binding.bind(RestBindings.SequenceActions.REJECT)
      .toProvider(ODataErrorProvider)
      .inScope(BindingScope.SINGLETON),
    createBindingFromClass(ODataVisibilitySpecEnhancer),
    createBindingFromClass(ODataConfigValidatorObserver),
  ];

  controllers = [ODataMetadataController, ODataBatchController, ODataServiceDocumentController];
  booters = [ODataBooter];
}

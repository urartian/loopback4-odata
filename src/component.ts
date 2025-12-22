import { Component, Binding, BindingScope, createBindingFromClass } from '@loopback/core';
import { RestBindings, createMiddlewareBinding } from '@loopback/rest';
import { randomBytes } from 'crypto';
import { ODataConfig } from './types';
import { ODATA_BINDINGS } from './keys';
import { CsdlGenerator } from './metadata/csdl-generator';
import { ODataMetadataController } from './controllers/metadata.controller';
import { ODataBatchController } from './controllers/batch.controller';
import { ODataServiceDocumentController } from './controllers/service-document.controller';
import { EntitySetRegistry } from './registry/entityset-registry';
import { ODataBooter } from './booters/odata.booter';
import { OdataPathRewriterProvider } from './middleware/odata-path-rewriter.provider';
import { ODataRequestContextProvider } from './middleware/odata-request-context.provider';
import { RequestLoggingProvider } from './middleware/request-logging.provider';
import { ODataErrorProvider } from './providers/odata-error.provider';
import { ODataApplyExecutorRegistry } from './services/odata-apply-executor.registry';
import { PostgresApplyExecutor } from './services/postgres-apply-executor';
import { MySqlApplyExecutor } from './services/mysql-apply-executor';
import { ODataVisibilitySpecEnhancer } from './spec/odata-visibility.spec-enhancer';
import { ODataLoggerProvider } from './providers/odata-logger.provider';
import { ODataConfigValidatorObserver } from './observers/odata-config.validator';
import { TenantThrottlerProvider } from './providers/tenant-throttler.provider';
import { InMemoryTenantThrottleStore } from './services/tenant-throttle-store';

let loggedGeneratedSecretTip = false;

function detectRuntimeEnvironment(): string {
  const raw = process.env.ODATA_ENV ?? process.env.NODE_ENV ?? 'development';
  return raw.trim().toLowerCase();
}

function isProductionEnvironment(): boolean {
  return detectRuntimeEnvironment() === 'production';
}

function resolveTokenSecretOrThrow(): string {
  const envValue = process.env.ODATA_TOKEN_SECRET;
  if (typeof envValue === 'string') {
    const trimmed = envValue.trim();
    if (trimmed) return trimmed;
  }
  if (isProductionEnvironment()) {
    throw new Error(
      'ODATA_TOKEN_SECRET is required in production. Please set it via environment variable before booting the OData component (see README tokenSecret section).',
    );
  }
  const generated = randomBytes(32).toString('hex');
  if (!loggedGeneratedSecretTip) {
    loggedGeneratedSecretTip = true;
    console.info(
      `[OData] Generated per-boot OData token secret for ${detectRuntimeEnvironment()} env. Set ODATA_TOKEN_SECRET=$(openssl rand -hex 32) to keep paging/delta tokens stable across restarts.`,
    );
  }
  return generated;
}

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
        maxResponseBodyBytes: 4 * 1024 * 1024,
        maxResponsePayloadBytes: 32 * 1024 * 1024,
      },
      pagination: {
        maxPageSize: 200,
        maxApplyPageSize: 200,
      },
      appendKeysForClientPaging: true,
      telemetry: {
        enabled: false,
        level: 'info',
        categories: [],
        sampleRate: 1,
        emitStatisticsHeader: false,
        statisticsHeaderName: 'OData-Statistics',
        statisticsPrecision: 2,
        includeApplyPlanOnFallback: false,
        requestLogging: {
          enabled: false,
          allowClientOverride: false,
          includeHeaders: true,
          includeResponseBody: false,
          maxPayloadBytes: 32 * 1024,
          maskHeaders: ['authorization', 'cookie'],
          maskBodyPaths: [],
        },
      },
      correlation: {
        headerName: 'x-correlation-id',
        generateWhenMissing: true,
        propagateToRepositories: false,
      },
      tokenSecret: resolveTokenSecretOrThrow(),
    } as ODataConfig),
    Binding.bind(ODATA_BINDINGS.CSDL_GEN).toClass(CsdlGenerator).inScope(BindingScope.SINGLETON),
    Binding.bind(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
      .toClass(EntitySetRegistry)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ODATA_BINDINGS.LOGGER)
      .toProvider(ODataLoggerProvider)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ODATA_BINDINGS.THROTTLE_STORE)
      .toClass(InMemoryTenantThrottleStore)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ODATA_BINDINGS.THROTTLER)
      .toProvider(TenantThrottlerProvider)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ODATA_BINDINGS.APPLY_EXECUTOR_REGISTRY)
      .toDynamicValue(() => {
        const registry = new ODataApplyExecutorRegistry();
        registry.register(new PostgresApplyExecutor());
        registry.register(new MySqlApplyExecutor());
        return registry;
      })
      .inScope(BindingScope.SINGLETON),
    createMiddlewareBinding(ODataRequestContextProvider, {
      key: 'middleware.odataRequestContext',
    }),
    createMiddlewareBinding(OdataPathRewriterProvider, {
      key: 'middleware.odataPathRewriter',
    }),
    createMiddlewareBinding(RequestLoggingProvider, {
      key: 'middleware.odataRequestLogging',
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

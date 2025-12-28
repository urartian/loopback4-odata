export interface ODataConfig {
  basePath?: string; // default '/odata'
  /**
   * When true, always trust Forwarded/X-Forwarded-* headers for origin/host/protocol detection.
   * When false/omitted, proxy headers are ignored unless `trustedProxySubnets` is configured.
   */
  trustProxyHeaders?: boolean;
  /**
   * CIDR/IP strings describing which remote addresses are allowed to influence host/protocol.
   */
  trustedProxySubnets?: string[];
  csdlFormat?: 'xml' | 'json'; // default 'xml'
  namespace?: string; // default 'Default'
  entityContainerName?: string; // default 'DefaultContainer'
  namespaceAlias?: string; // optional schema alias
  capabilities?: ODataCapabilityDefaults;
  maxTop?: number;
  enableCount?: boolean;
  strict?: boolean;
  enableDeepInsert?: boolean;
  enableDeepUpdate?: boolean;
  maxDeepInsertDepth?: number;
  maxDeepUpdateDepth?: number;
  enableNavigationRefEndpoints?: boolean;
  logApplyFallbacks?: boolean;
  maxApplyResultSize?: number;
  onApplyFallback?: (event: ODataApplyFallbackEvent) => void;
  logApplyTelemetry?: boolean;
  onApplyTelemetry?: (event: ODataApplyTelemetryEvent) => void;
  maxApplyNavigationFanout?: number;
  onDeltaTokenInvalid?: (event: ODataDeltaTokenInvalidEvent) => void;
  tenantResolver?: (request: import('@loopback/rest').Request) => string | undefined;
  tenantQuotas?: ODataTenantQuotaConfig;
  // Search configuration
  searchMode?: 'annotated' | 'config-only' | 'all' | 'disabled';
  searchFields?: Record<string, string[]>; // per entity set
  maxSearchFields?: number; // cap number of fields used in $search
  maxSearchTerms?: number; // cap number of tokens parsed from $search
  // Limits & safety
  maxExpandDepth?: number; // maximum allowed $expand nesting depth (strict enforced)
  maxSkip?: number; // maximum allowed $skip (strict enforced)
  maxFilterPatternLength?: number; // caps underscore patterns generated for some $filter functions
  maxSubstringStart?: number; // caps substring() start used for pattern translation
  maxSubstringLength?: number; // caps substring() length argument
  maxFilterFieldNameLength?: number; // caps length of field identifiers in $filter
  maxDecimalExponentAbs?: number; // caps absolute exponent in decimal scientific notation normalization
  // $apply pushdown
  enableApplyPushdown?: boolean; // opt-in for datastore-backed $apply execution
  pageSize?: number; // default page size for server-driven paging
  enableDelta?: boolean; // opt-in for delta link emission
  pagination?: ODataPaginationConfig;
  // OpenAPI visibility
  documentInOpenApiDefault?: boolean | 'auto'; // default 'auto'
  removeUndocumentedFromSpec?: boolean; // default true
  // Token security
  tokenSecret?: string; // required for signed skip/delta tokens
  skipTokenTtl?: number; // seconds before a $skiptoken expires (default 900)
  deltaTokenTtl?: number; // seconds before a $deltatoken expires (optional)
  allowLegacyUnsignedTokens?: boolean; // allow decoding legacy unsinged tokens (default false)
  batch?: ODataBatchConfig;
  onLog?: (entry: ODataLogEntry) => void;
  telemetry?: ODataTelemetryConfig;
  correlation?: ODataCorrelationConfig;
  appendKeysForClientPaging?: boolean; // default true - stabilize manual $skip order
  writeTransactions?: ODataWriteTransactionsConfig;
}

export interface ODataWriteTransactionsConfig {
  enabled?: boolean; // default false
  isolationLevel?: 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE'; // default READ_COMMITTED
  requireTransactionSupport?: boolean; // default: true when strict=true, else false
  rejectMultiDataSource?: boolean; // default true
}

export interface ODataNavigationRestriction {
  navigable?: boolean;
}

export interface ODataPermissionScope {
  scope: string;
  description?: string;
}

export interface ODataEntityPermission {
  scheme?: string;
  scopes: Array<string | ODataPermissionScope>;
}

export interface ODataInsertRestrictionsConfig {
  insertable?: boolean;
  description?: string;
  longDescription?: string;
  requiredProperties?: string[];
  requiredNavigationProperties?: string[];
  nonInsertableProperties?: string[];
  nonInsertableNavigationProperties?: string[];
}

export interface ODataUpdateRestrictionsConfig {
  updatable?: boolean;
  description?: string;
  longDescription?: string;
  requiredProperties?: string[];
  nonUpdatableProperties?: string[];
  nonUpdatableNavigationProperties?: string[];
}

export interface ODataDeleteRestrictionsConfig {
  deletable?: boolean;
  description?: string;
  longDescription?: string;
  requiresFilter?: boolean;
  nonDeletableNavigationProperties?: string[];
}

export type ODataSearchExpression =
  | 'none'
  | 'and'
  | 'or'
  | 'not'
  | 'phrase'
  | 'grouping'
  | 'propertyExpressions'
  | 'searchTerms'
  | `Org.OData.Capabilities.V1.SearchExpressions/${string}`;

export interface ODataSearchRestrictionsConfig {
  searchable?: boolean;
  unsupportedExpressions?: ODataSearchExpression[];
}

export interface ODataCapabilitiesConfig {
  filterFunctions?: string[];
  countable?: boolean;
  navigationRestrictions?: Record<string, ODataNavigationRestriction>;
  permissions?: ODataEntityPermission[];
  hasStream?: boolean;
  aggregation?: boolean;
  aggregationMethods?: string[];
  applySupported?: boolean;
  insertRestrictions?: ODataInsertRestrictionsConfig;
  updateRestrictions?: ODataUpdateRestrictionsConfig;
  deleteRestrictions?: ODataDeleteRestrictionsConfig;
  searchRestrictions?: ODataSearchRestrictionsConfig;
}

export interface ODataCapabilityDefaults extends ODataCapabilitiesConfig {
  navigationRestrictionDefaults?: ODataNavigationRestriction;
}

export interface ODataApplyFallbackEvent {
  event: string;
  entitySet: string;
  transformations?: number;
  rows?: number;
  limit?: number;
}

export interface ODataApplyTelemetryEvent {
  entitySet: string;
  stageIndex: number;
  stageCount: number;
  mode: 'pushdown' | 'fallback';
  executorId?: string;
  durationMs?: number;
  rows?: number;
  joinCount?: number;
  reason?: string;
  navigationPaths?: string[];
}

export type ODataDeltaTokenInvalidCode =
  | 'delta-not-supported'
  | 'entity-mismatch'
  | 'expired'
  | 'invalid';

export interface ODataDeltaTokenInvalidEvent {
  event: 'delta-token-invalid';
  code: ODataDeltaTokenInvalidCode;
  entitySet: string;
}

export interface ODataTenantQuotaConfig {
  maxRequestsPerMinute?: number;
  maxConcurrentRequests?: number;
  maxLeaseRefreshers?: number; // global cap on active tenant lease timers
  overrides?: Record<string, { maxRequestsPerMinute?: number; maxConcurrentRequests?: number }>;
}

export interface ODataTenantThrottleContext {
  entitySet?: string;
  operation?: string;
  scope?: string;
  method?: string;
  url?: string;
  requestId?: string;
  correlationId?: string;
}

export interface ODataLogEntry {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

export interface ODataBatchConfig {
  maxPayloadBytes?: number; // total bytes allowed in a single $batch request
  maxOperations?: number; // total operations (requests) allowed per batch
  maxChangesetOperations?: number; // max operations inside a single changeset
  maxDepth?: number; // maximum multipart nesting depth
  maxPartBodyBytes?: number; // maximum body size for an individual part
  maxResponseBodyBytes?: number; // maximum bytes allowed in a single batch sub-response
  maxResponsePayloadBytes?: number; // maximum aggregate bytes buffered + serialized for the full batch response
  allowedSubRequestHeaders?: string[]; // additional header names that batch entries may override
  subRequestTimeoutMs?: number; // max duration for each sub-request before it is aborted
}

export interface ODataPaginationConfig {
  maxTop?: number; // maximum client-requested $top
  maxSkip?: number; // maximum client-requested $skip
  maxPageSize?: number; // maximum server-driven page size for collections
  maxApplyPageSize?: number; // maximum server-driven page size for $apply pipelines
}

export type ODataTelemetryCategory =
  | 'apply'
  | 'rewrite'
  | 'hooks'
  | 'batch'
  | 'throttle'
  | 'tokens'
  | 'requests';

export type ODataTelemetryLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface ODataTelemetryConfig {
  enabled?: boolean;
  level?: ODataTelemetryLevel;
  categories?: ODataTelemetryCategory[];
  sampleRate?: number;
  emitStatisticsHeader?: boolean;
  statisticsHeaderName?: string;
  statisticsPrecision?: number;
  includeApplyPlanOnFallback?: boolean;
  requestLogging?: ODataRequestLoggingConfig;
}

export interface ODataCorrelationConfig {
  headerName?: string;
  responseHeaderName?: string;
  generateWhenMissing?: boolean;
  propagateToRepositories?: boolean;
}

export interface ODataRequestLoggingConfig {
  enabled?: boolean;
  allowClientOverride?: boolean;
  includeHeaders?: boolean;
  includeResponseBody?: boolean;
  maxPayloadBytes?: number;
  maskHeaders?: string[];
  maskBodyPaths?: string[];
}

export interface ODataTelemetryState {
  enabled: boolean;
  level: ODataTelemetryLevel;
  categories?: Set<ODataTelemetryCategory>;
  sampled: boolean;
  includeApplyPlanOnFallback: boolean;
  emitStatisticsHeader?: boolean;
  statisticsHeaderName?: string;
  statisticsPrecision?: number;
  requestLoggingEnabled?: boolean;
}

export interface ODataStatisticsState {
  requested: boolean;
  startTimeNs: bigint;
  dbTimeNs: bigint;
  roundTrips: number;
  rows: number;
}

export interface ODataRequestState {
  correlationId?: string;
  telemetryPreferences?: Set<'statistics' | 'request-log'>;
  telemetry?: ODataTelemetryState;
  statistics?: ODataStatisticsState;
  startedAtNs?: bigint;
  batchDepth?: number;
}

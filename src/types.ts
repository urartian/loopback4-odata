/**
 * Top-level runtime configuration for the LoopBack OData component.
 *
 * Bind this to `ODATA_BINDINGS.CONFIG` in your LB4 application to customize
 * routing, guardrails, telemetry, pagination, batching, media handling, and
 * multi-tenant behavior.
 *
 * @example
 * ```ts
 * app.bind(ODATA_BINDINGS.CONFIG).to({
 *   basePath: '/api/odata',
 *   strict: true,
 *   pagination: {maxTop: 100, maxPageSize: 100},
 *   tokenSecret: process.env.ODATA_TOKEN_SECRET,
 * });
 * ```
 */
export interface ODataConfig {
  /** Externally visible OData service root. Defaults to `/odata`. */
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
  /** Metadata format exposed from `$metadata`. Defaults to `'xml'`. */
  csdlFormat?: 'xml' | 'json'; // default 'xml'
  /** EDM namespace used for generated schemas. Defaults to `'Default'`. */
  namespace?: string; // default 'Default'
  /** Entity container name used in generated metadata. Defaults to `'DefaultContainer'`. */
  entityContainerName?: string; // default 'DefaultContainer'
  /** Optional EDM namespace alias for shorter generated schema references. */
  namespaceAlias?: string; // optional schema alias
  /** Default OData capability annotations applied across entity sets. */
  capabilities?: ODataCapabilityDefaults;
  /** Legacy top-level cap for `$top`. Prefer `pagination.maxTop` for new configs. */
  maxTop?: number;
  /** Enables `$count` responses on collection endpoints. */
  enableCount?: boolean;
  /** When true, rejects unsupported/unsafe queries instead of clamping or falling back. */
  strict?: boolean;
  /** Enables deep insert payloads for navigation graphs. */
  enableDeepInsert?: boolean;
  /** Enables deep update payloads for navigation graphs. */
  enableDeepUpdate?: boolean;
  /** Maximum traversal depth accepted for deep inserts. */
  maxDeepInsertDepth?: number;
  /** Maximum traversal depth accepted for deep updates. */
  maxDeepUpdateDepth?: number;
  /** Enables navigation `$ref` link/unlink endpoints where relations allow them. */
  enableNavigationRefEndpoints?: boolean;
  /** Emits logs whenever `$apply` falls back from pushdown to in-memory execution. */
  logApplyFallbacks?: boolean;
  /** Maximum rows processed by in-memory `$apply` fallback before rejecting the request. */
  maxApplyResultSize?: number;
  /** Callback fired whenever the runtime performs `$apply` fallback. */
  onApplyFallback?: (event: ODataApplyFallbackEvent) => void;
  /** Enables telemetry events for `$apply` execution stages. */
  logApplyTelemetry?: boolean;
  /** Callback fired for detailed `$apply` pushdown/fallback telemetry. */
  onApplyTelemetry?: (event: ODataApplyTelemetryEvent) => void;
  /** Caps navigation fanout during in-memory `$apply` execution. */
  maxApplyNavigationFanout?: number;
  /** Callback fired when a client supplies an invalid or expired `$deltatoken`. */
  onDeltaTokenInvalid?: (event: ODataDeltaTokenInvalidEvent) => void;
  /** Resolves a tenant identifier from the current LB4 request. */
  tenantResolver?: (request: import('@loopback/rest').Request) => string | undefined;
  /** Optional per-tenant throttling policy keyed by the resolved tenant id. */
  tenantQuotas?: ODataTenantQuotaConfig;
  // Search configuration
  /** Controls which fields participate in `$search`. */
  searchMode?: 'annotated' | 'config-only' | 'all' | 'disabled';
  /** Explicit searchable field allow-list per entity set. */
  searchFields?: Record<string, string[]>; // per entity set
  /** Maximum number of fields used when translating a single `$search` query. */
  maxSearchFields?: number; // cap number of fields used in $search
  /** Maximum number of parsed search tokens allowed in one `$search` expression. */
  maxSearchTerms?: number; // cap number of tokens parsed from $search
  // Limits & safety
  /** Maximum allowed `$expand` nesting depth. */
  maxExpandDepth?: number; // maximum allowed $expand nesting depth (strict enforced)
  /** Legacy top-level cap for `$skip`. Prefer `pagination.maxSkip`. */
  maxSkip?: number; // maximum allowed $skip (strict enforced)
  /** Caps wildcard/pattern size generated from supported `$filter` functions. */
  maxFilterPatternLength?: number; // caps underscore patterns generated for some $filter functions
  /** Caps the `substring()` start index accepted for pushdown translation. */
  maxSubstringStart?: number; // caps substring() start used for pattern translation
  /** Caps the `substring()` length accepted for pushdown translation. */
  maxSubstringLength?: number; // caps substring() length argument
  /** Caps field identifier length accepted in `$filter`. */
  maxFilterFieldNameLength?: number; // caps length of field identifiers in $filter
  /** Caps absolute exponent size accepted when normalizing decimal scientific notation. */
  maxDecimalExponentAbs?: number; // caps absolute exponent in decimal scientific notation normalization
  /** Fine-grained `$filter` validation and fallback limits. */
  filter?: ODataFilterConfig;
  // $apply pushdown
  /** Enables datastore-backed `$apply` execution where an executor is available. */
  enableApplyPushdown?: boolean; // opt-in for datastore-backed $apply execution
  /** Default server-driven page size for collection endpoints. */
  pageSize?: number; // default page size for server-driven paging
  /** Enables delta link emission on configured entity sets. */
  enableDelta?: boolean; // opt-in for delta link emission
  /** Pagination guardrails for collection and `$apply` requests. */
  pagination?: ODataPaginationConfig;
  /** Lambda-specific validation and pushdown controls. */
  lambda?: ODataLambdaConfig;
  // OpenAPI visibility
  /** Controls whether generated OData routes are published in the OpenAPI document. */
  documentInOpenApiDefault?: boolean | 'auto'; // default 'auto'
  /** Removes undocumented OData routes from the published OpenAPI document when true. */
  removeUndocumentedFromSpec?: boolean; // default true
  // Token security
  /** Secret used to sign `$skiptoken` and `$deltatoken` payloads. */
  tokenSecret?: string; // required for signed skip/delta tokens
  /** `$skiptoken` lifetime in seconds. Defaults to 900. */
  skipTokenTtl?: number; // seconds before a $skiptoken expires (default 900)
  /** Optional `$deltatoken` lifetime in seconds. */
  deltaTokenTtl?: number; // seconds before a $deltatoken expires (optional)
  /** Allows legacy unsigned paging/delta tokens during migration windows. */
  allowLegacyUnsignedTokens?: boolean; // allow decoding legacy unsinged tokens (default false)
  /** Guardrails for JSON and multipart `$batch` processing. */
  batch?: ODataBatchConfig;
  /** Hook invoked for each structured log entry emitted by the component. */
  onLog?: (entry: ODataLogEntry) => void;
  /** Telemetry and request logging configuration. */
  telemetry?: ODataTelemetryConfig;
  /** Correlation id extraction and propagation settings. */
  correlation?: ODataCorrelationConfig;
  /** Appends key columns to manual paging order clauses to stabilize offsets. */
  appendKeysForClientPaging?: boolean; // default true - stabilize manual $skip order
  /** Transaction strategy for create/update/delete flows outside `$batch`. */
  writeTransactions?: ODataWriteTransactionsConfig;
  /** Composition delete semantics and deep graph safety limits. */
  composition?: ODataCompositionConfig;
}

/** Per-request context passed to singleton id resolvers. */
export interface ODataSingletonResolveContext {
  request: import('@loopback/rest').Request;
  response: import('@loopback/rest').Response;
  httpCtx: import('@loopback/rest').RequestContext;
}

/** Resolves a singleton identifier dynamically for the current request. */
export type ODataSingletonIdResolver = (
  ctx: ODataSingletonResolveContext,
) => unknown | Promise<unknown>;

/** Configures how a model is exposed as an OData singleton. */
export interface ODataSingletonConfig {
  /**
   * Singleton name exposed under `/odata/<name>`, e.g. "Me".
   */
  name: string;
  /**
   * Static singleton key. Exactly one of `id` or `resolveId` must be provided.
   */
  id?: unknown;
  /**
   * Contextual singleton key resolver (per-request). Exactly one of `id` or `resolveId` must be provided.
   */
  resolveId?: ODataSingletonIdResolver;
  /**
   * When true, DELETE is allowed and the singleton may not exist (404 on GET).
   */
  nullable?: boolean;
}

/** Controls transaction use for non-batch write operations. */
export interface ODataWriteTransactionsConfig {
  /** Enables transaction-wrapped writes when supported by the datasource. */
  enabled?: boolean; // default false
  /** Requested isolation level for started transactions. */
  isolationLevel?: 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE'; // default READ_COMMITTED
  /** Rejects writes when the datasource cannot provide transactions. */
  requireTransactionSupport?: boolean; // default: true when strict=true, else false
  /** Rejects writes spanning multiple datasources. */
  rejectMultiDataSource?: boolean; // default true
}

/** Selects whether composition semantics are enforced by the database or the application layer. */
export type ODataCompositionEnforcement = 'database' | 'application';

/** Delete policy applied to composition relations. */
export type ODataCompositionDeletePolicy = 'restrict' | 'cascade';

/** Per-relation composition override. */
export interface ODataCompositionRelationConfig {
  delete?: ODataCompositionDeletePolicy;
}

/** Per-entity-set composition overrides keyed by relation name. */
export interface ODataCompositionEntitySetConfig {
  relations?: Record<string, ODataCompositionRelationConfig>;
}

/** Global composition behavior for deletes and deep graph operations. */
export interface ODataCompositionConfig {
  enforcement?: ODataCompositionEnforcement; // default: 'database'
  defaultDeletePolicy?: ODataCompositionDeletePolicy; // default: 'restrict'
  requireTransactionSupport?: boolean; // default: true
  maxDepth?: number; // default: 8
  maxEntities?: number; // default: 5000
  entitySets?: Record<string, ODataCompositionEntitySetConfig>;
}

/** Fully resolved composition settings after defaults and overrides are merged. */
export interface ODataCompositionResolvedConfig {
  enforcement: ODataCompositionEnforcement;
  defaultDeletePolicy: ODataCompositionDeletePolicy;
  requireTransactionSupport: boolean;
  maxDepth: number;
  maxEntities: number;
  relations: Record<string, { delete: ODataCompositionDeletePolicy }>;
}

/** Navigation capability annotation for a single property. */
export interface ODataNavigationRestriction {
  navigable?: boolean;
}

/** Security scope description used in capability annotations. */
export interface ODataPermissionScope {
  scope: string;
  description?: string;
}

/** OData permission annotation describing a scheme plus required scopes. */
export interface ODataEntityPermission {
  scheme?: string;
  scopes: Array<string | ODataPermissionScope>;
}

/** Insert capability annotations for an entity set. */
export interface ODataInsertRestrictionsConfig {
  insertable?: boolean;
  description?: string;
  longDescription?: string;
  requiredProperties?: string[];
  requiredNavigationProperties?: string[];
  nonInsertableProperties?: string[];
  nonInsertableNavigationProperties?: string[];
}

/** Update capability annotations for an entity set. */
export interface ODataUpdateRestrictionsConfig {
  updatable?: boolean;
  description?: string;
  longDescription?: string;
  requiredProperties?: string[];
  nonUpdatableProperties?: string[];
  nonUpdatableNavigationProperties?: string[];
}

/** Delete capability annotations for an entity set. */
export interface ODataDeleteRestrictionsConfig {
  deletable?: boolean;
  description?: string;
  longDescription?: string;
  requiresFilter?: boolean;
  nonDeletableNavigationProperties?: string[];
}

/** Search capability expression names used by OData capability annotations. */
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

/** Search capability annotations for an entity set. */
export interface ODataSearchRestrictionsConfig {
  searchable?: boolean;
  unsupportedExpressions?: ODataSearchExpression[];
}

/** Filter capability annotations for an entity set. */
export interface ODataFilterRestrictionsConfig {
  filterable?: boolean;
  requiresFilter?: boolean;
  nonFilterableProperties?: string[];
  nonFilterableNavigationProperties?: string[];
}

/** OData capability annotations applied globally or per entity set. */
export interface ODataCapabilitiesConfig {
  filterFunctions?: string[];
  filterFunctionsPreset?: 'default' | 'postgres';
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
  filterRestrictions?: ODataFilterRestrictionsConfig;
}

/** Global capability defaults merged into individual entity-set metadata. */
export interface ODataCapabilityDefaults extends ODataCapabilitiesConfig {
  navigationRestrictionDefaults?: ODataNavigationRestriction;
}

/** Event payload emitted when `$apply` falls back to in-memory execution. */
export interface ODataApplyFallbackEvent {
  event: string;
  entitySet: string;
  transformations?: number;
  rows?: number;
  limit?: number;
}

/** Telemetry event describing a single `$apply` execution stage. */
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

/** Stable reason codes emitted when delta token validation fails. */
export type ODataDeltaTokenInvalidCode =
  | 'delta-not-supported'
  | 'entity-mismatch'
  | 'expired'
  | 'invalid';

/** Event payload emitted when a `$deltatoken` is rejected. */
export interface ODataDeltaTokenInvalidEvent {
  event: 'delta-token-invalid';
  code: ODataDeltaTokenInvalidCode;
  entitySet: string;
}

/** Per-tenant throttling limits and optional per-tenant overrides. */
export interface ODataTenantQuotaConfig {
  /** Rolling request-per-minute limit applied to each tenant bucket. */
  maxRequestsPerMinute?: number;
  /** Maximum concurrent in-flight requests per tenant bucket. */
  maxConcurrentRequests?: number;
  /** Global cap on active tenant lease refresh timers. */
  maxLeaseRefreshers?: number; // global cap on active tenant lease timers
  /** Tenant-specific overrides keyed by the exact value returned from `tenantResolver`. */
  overrides?: Record<string, { maxRequestsPerMinute?: number; maxConcurrentRequests?: number }>;
}

/** Context passed into the tenant throttler for logging and telemetry. */
export interface ODataTenantThrottleContext {
  entitySet?: string;
  operation?: string;
  scope?: string;
  method?: string;
  url?: string;
  requestId?: string;
  correlationId?: string;
}

/** Structured log entry emitted by the OData component. */
export interface ODataLogEntry {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

/** Guardrails for JSON and multipart `$batch` processing. */
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

/** Pagination limits for collection and `$apply` requests. */
export interface ODataPaginationConfig {
  maxTop?: number; // maximum client-requested $top
  maxSkip?: number; // maximum client-requested $skip
  maxPageSize?: number; // maximum server-driven page size for collections
  maxApplyPageSize?: number; // maximum server-driven page size for $apply pipelines
}

/** Validation and fallback limits for `$filter` execution. */
export interface ODataFilterConfig {
  maxInListItems?: number; // maximum allowed items inside `in (...)`
  pushdownMaxJoinCount?: number; // maximum joins allowed for $filter pushdown (e.g. to-one navigation filters)
  /**
   * Maximum number of rows that may be scanned in-memory when evaluating $filter post-processing.
   * When exceeded, the request is rejected instead of falling back to an unbounded scan.
   */
  maxPostFilterScanRows?: number;
  /**
   * When true (default), require client-provided $top when a request needs post-filter evaluation.
   */
  requireTopWhenPostFilter?: boolean;
}

/** Validation and pushdown controls for lambda `any`/`all` filters. */
export interface ODataLambdaConfig {
  /** Maximum rows scanned while evaluating lambda fallback logic. */
  maxLambdaScanRows?: number;
  /** Requires a client-provided `$top` when lambda fallback would scan in memory. */
  requireTopWhenLambda?: boolean;
  /** Emits telemetry/logging when lambda filters fall back from pushdown. */
  warnOnLambdaFallback?: boolean;
  /** Enables lambda pushdown for supported backends. */
  pushdown?: 'disabled' | 'postgres';
  /** Rejects unsupported lambda shapes instead of falling back when true. */
  pushdownStrict?: boolean;
  /** Caps nested EXISTS depth used by lambda pushdown. */
  pushdownMaxExistsDepth?: number;
  /** Caps JOIN count used by lambda pushdown. */
  pushdownMaxJoinCount?: number;
}

/** Telemetry categories that can be emitted by the component. */
export type ODataTelemetryCategory =
  | 'apply'
  | 'rewrite'
  | 'hooks'
  | 'batch'
  | 'throttle'
  | 'tokens'
  | 'requests';

/** Log levels used by OData telemetry and structured logging. */
export type ODataTelemetryLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Telemetry and request-logging configuration for OData requests. */
export interface ODataTelemetryConfig {
  /** Enables component telemetry. */
  enabled?: boolean;
  /** Minimum level emitted for telemetry events. */
  level?: ODataTelemetryLevel;
  /** Optional allow-list of telemetry categories to emit. */
  categories?: ODataTelemetryCategory[];
  /** Sampling rate between `0` and `1`. */
  sampleRate?: number;
  /** Emits a statistics response header when request statistics are collected. */
  emitStatisticsHeader?: boolean;
  /** Response header name used for serialized statistics. */
  statisticsHeaderName?: string;
  /** Decimal precision used in serialized statistics. */
  statisticsPrecision?: number;
  /** Includes apply-plan details when fallback occurs. */
  includeApplyPlanOnFallback?: boolean;
  /** Fine-grained request logging options. */
  requestLogging?: ODataRequestLoggingConfig;
}

/** Correlation id extraction and propagation settings. */
export interface ODataCorrelationConfig {
  /** Enables correlation id processing. */
  enabled?: boolean;
  /** Request header name read for incoming correlation ids. */
  headerName?: string;
  /** Optional response header used to echo the effective correlation id. */
  responseHeaderName?: string;
  /** Generates a correlation id when the request does not provide one. */
  generateWhenMissing?: boolean;
  /** Propagates correlation ids into repository option bags. */
  propagateToRepositories?: boolean;
  /** Repository options key used when propagating correlation ids. */
  repositoryOptionsKey?: string;
}

/** Correlation information attached to an OData request. */
export interface ODataCorrelationContext {
  correlationId: string;
  tenantId?: string;
  upstreamCorrelationId?: string;
}

/** Request logging controls used by telemetry-enabled deployments. */
export interface ODataRequestLoggingConfig {
  /** Enables request log emission. */
  enabled?: boolean;
  /** Allows clients to opt in via `Prefer: request-log`. */
  allowClientOverride?: boolean;
  /** Includes request headers in emitted log payloads. */
  includeHeaders?: boolean;
  /** Includes response bodies in emitted log payloads. */
  includeResponseBody?: boolean;
  /** Caps payload bytes captured for structured logging. */
  maxPayloadBytes?: number;
  /** Header names that should be masked in logs. */
  maskHeaders?: string[];
  /** JSON body paths that should be masked in logs. */
  maskBodyPaths?: string[];
}

/** Effective telemetry state attached to the current request. */
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

/** Per-request statistics accumulated while serving an OData request. */
export interface ODataStatisticsState {
  requested: boolean;
  startTimeNs: bigint;
  dbTimeNs: bigint;
  roundTrips: number;
  rows: number;
}

/** Request-scoped state stored in `ODATA_BINDINGS.REQUEST_STATE`. */
export interface ODataRequestState {
  correlationId?: string;
  tenantId?: string;
  telemetryPreferences?: Set<'statistics' | 'request-log'>;
  telemetry?: ODataTelemetryState;
  statistics?: ODataStatisticsState;
  startedAtNs?: bigint;
  batchDepth?: number;
}

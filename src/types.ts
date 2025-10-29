export interface ODataConfig {
  basePath?: string; // default '/odata'
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
  // Search configuration
  searchMode?: 'annotated' | 'config-only' | 'all' | 'disabled';
  searchFields?: Record<string, string[]>; // per entity set
  maxSearchFields?: number; // cap number of fields used in $search
  maxSearchTerms?: number; // cap number of tokens parsed from $search
  // Limits & safety
  maxExpandDepth?: number; // maximum allowed $expand nesting depth (strict enforced)
  maxSkip?: number; // maximum allowed $skip (strict enforced)
  // $apply pushdown
  enableApplyPushdown?: boolean; // opt-in for datastore-backed $apply execution
  pageSize?: number; // default page size for server-driven paging
  enableDelta?: boolean; // opt-in for delta link emission
  // OpenAPI visibility
  documentInOpenApiDefault?: boolean | 'auto'; // default 'auto'
  removeUndocumentedFromSpec?: boolean; // default true
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

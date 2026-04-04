/**
 * Stable OData error codes emitted by the component.
 *
 * Applications can rely on these values when asserting API behavior,
 * building client-side handling, or mapping server failures into
 * observability dashboards.
 */
export const ODataErrorCodes = {
  // Default/fallback OData codes (derived from HTTP status when no explicit code is set)
  BadRequest: 'BadRequest',
  Unauthorized: 'Unauthorized',
  Forbidden: 'Forbidden',
  NotFound: 'NotFound',
  Conflict: 'Conflict',
  MethodNotAllowed: 'MethodNotAllowed',
  PreconditionFailed: 'PreconditionFailed',
  PreconditionRequired: 'PreconditionRequired',
  PayloadTooLarge: 'PayloadTooLarge',
  NotImplemented: 'NotImplemented',
  InternalServerError: 'InternalServerError',
  NotAcceptable: 'NotAcceptable',
  UnsupportedMediaType: 'UnsupportedMediaType',
  UnprocessableEntity: 'UnprocessableEntity',
  Gone: 'Gone',
  TooManyRequests: 'TooManyRequests',
  ServiceUnavailable: 'ServiceUnavailable',

  // Batch (JSON/multipart)
  InvalidUrl: 'InvalidUrl',
  InvalidMethod: 'InvalidMethod',
  ResponseTooLarge: 'ResponseTooLarge',
  TooManyRedirects: 'TooManyRedirects',
  BatchExecutionError: 'BatchExecutionError',
  BatchSubRequestTimeout: 'BatchSubRequestTimeout',
  BatchOperationLimitExceeded: 'batch-operation-limit-exceeded',
  ChangesetOperationLimitExceeded: 'changeset-operation-limit-exceeded',
  BatchPayloadSizeLimitExceeded: 'batch-payload-size-limit-exceeded',
  BatchPartSizeLimitExceeded: 'batch-part-size-limit-exceeded',
  BatchDepthLimitExceeded: 'batch-depth-limit-exceeded',

  // Preferences / tenancy / transactions
  PreferenceNotSupported: 'PreferenceNotSupported',
  TenantResolutionFailed: 'TenantResolutionFailed',
  TransactionCommitFailed: 'TransactionCommitFailed',
  TransactionsNotSupported: 'TransactionsNotSupported',
  MultiDataSourceChangesetNotSupported: 'MultiDataSourceChangesetNotSupported',
  AtomicityGroupNotSupported: 'AtomicityGroupNotSupported',

  // Content-ID resolution
  ContentIdReferenceInvalid: 'content-id-reference-invalid',

  // Lambda/filter / pushdown / guardrails
  LambdaOrUnsupported: 'lambda-or-unsupported',
  NestedLambdaDepthExceeded: 'nested-lambda-depth-exceeded',
  LambdaAliasPrefixRequired: 'lambda-alias-prefix-required',
  PushdownJoinCountExceeded: 'pushdown-join-count-exceeded',
  ThroughRelationUnsupported: 'through-relation-unsupported',
  NavigationFilterRequiresPushdown: 'navigation-filter-requires-pushdown',
  PostfilterRequiresPushdown: 'postfilter-requires-pushdown',
  PostfilterTopRequired: 'postfilter-top-required',
  PostfilterScanLimitExceeded: 'postfilter-scan-limit-exceeded',
  LambdaPushdownNotEligible: 'lambda-pushdown-not-eligible',
  LambdaScanLimitExceeded: 'lambda-scan-limit-exceeded',

  // Typed literal validation
  InvalidGuidLiteral: 'invalid-guid-literal',
  InvalidDateLiteral: 'invalid-date-literal',
  InvalidDateTimeOffsetLiteral: 'invalid-datetimeoffset-literal',
  InvalidInt64Literal: 'invalid-int64-literal',
  InvalidDecimalLiteral: 'invalid-decimal-literal',
  InListTooLarge: 'in-list-too-large',
  InOperatorRequiresList: 'in-operator-requires-list',
  InOperatorRequiresLiteralListItems: 'in-operator-requires-literal-list-items',
  InOperatorRequiresNonEmptyList: 'in-operator-requires-non-empty-list',
} as const;

/** Union of every stable OData error code emitted by the component. */
export type ODataErrorCode = (typeof ODataErrorCodes)[keyof typeof ODataErrorCodes];

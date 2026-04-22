# Troubleshooting and FAQ

This guide collects the most common production issues for `@urartian/loopback4-odata` and the fastest ways to diagnose them.

For v1, the supported SQL path is PostgreSQL. Connector-specific advice below assumes a PostgreSQL-backed LoopBack 4 application.

## Common configuration errors and solutions

### The app fails to boot in production with a token-secret error

Symptoms:

- boot fails in production mode
- logs mention `ODATA_TOKEN_SECRET`

Cause:

- signed `$skiptoken` and `$deltatoken` links require a stable secret
- in production, the component refuses to boot without one

Fix:

```bash
export ODATA_TOKEN_SECRET=$(openssl rand -hex 32)
```

Recommended posture:

- inject the secret through your normal deployment secret store
- rotate it deliberately
- expect secret rotation to invalidate existing paging and delta links

### Generated OData links use the wrong base URL

Symptoms:

- `@odata.context` points at an internal URL
- clients see mismatched service roots behind a reverse proxy

Cause:

- `basePath`, `trustProxyHeaders`, or `trustedProxySubnets` is missing or misconfigured

Fix:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  basePath: '/api/odata',
  trustedProxySubnets: ['10.0.0.0/8'],
});
```

Check:

- `GET <basePath>`
- `GET <basePath>/$metadata`

Examples:

- if `basePath: '/api/odata'`, check `GET /api/odata` and `GET /api/odata/$metadata`
- if `basePath: '/'`, check `GET /` and `GET /$metadata`

Both should advertise the externally visible root, not the internal LB4 path. When `basePath: '/'`, unrelated app routes such as `/health` should still behave like normal non-OData routes.

### Routes are missing from OpenAPI output

Symptoms:

- generated OData routes work
- but they do not appear in the OpenAPI spec you expected

Cause:

- OpenAPI visibility controls are hiding them

Fix:

- review `documentInOpenApiDefault`
- review `removeUndocumentedFromSpec`
- decide whether OData routes should be public in your generated OpenAPI document

### Requests fail unexpectedly under multi-tenant throttling

Symptoms:

- requests return `TenantResolutionFailed`
- throttling appears to treat requests as anonymous or unresolved

Cause:

- `tenantResolver` is configured, but it returns `undefined`, an empty string, or whitespace

Fix:

- make sure authentication runs before OData routes
- make `tenantResolver` read already-established tenant identity from headers or request context
- when running multiple instances, use a shared tenant throttle store rather than the process-local default

Example:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  tenantResolver: req => req.headers['x-tenant-id'] as string | undefined,
  tenantQuotas: {
    maxRequestsPerMinute: 120,
    maxConcurrentRequests: 5,
  },
});
```

### Media uploads larger than expected fail

Symptoms:

- upload returns `413 Payload Too Large`
- `PUT .../$value` works for small files but not larger ones

Cause:

- the default property-backed media handler is intentionally bounded
- the default path is not intended for very large-file ingestion

Fix:

- increase `mediaMaxPayloadBytes` only if bounded in-memory buffering is acceptable
- for large-file workloads, provide a custom streaming `ODataMediaHandler`

Example:

```ts
@odataModel({
  hasStream: true,
  mediaField: 'data',
  mediaContentTypeField: 'contentType',
  mediaLengthField: 'size',
  mediaMaxPayloadBytes: 10 * 1024 * 1024,
})
export class MediaAsset extends Entity {}
```

## Performance troubleshooting guide

### `$apply` is slower than expected

Symptoms:

- analytical requests are much slower than simple CRUD reads
- memory usage rises during aggregation-heavy requests

Most common cause:

- `$apply` is falling back to in-memory execution instead of staying in PostgreSQL

What to check:

- `enableApplyPushdown`
- per-model `applyPushdown`
- `logApplyFallbacks`
- `logApplyTelemetry`

Recommended production posture:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  logApplyTelemetry: true,
  maxApplyResultSize: 2000,
});
```

If a request still falls back:

- inspect the fallback log
- simplify the transformation if needed
- keep guardrails on instead of lifting limits blindly

See also [Performance Optimization](./performance-optimization.md) and [benchmark baselines](../benchmarks/results.md).

### Collection reads are causing load spikes

Symptoms:

- large feeds are slow
- memory and response time jump on list endpoints

Cause:

- paging is too loose, or clients are requesting too much data at once

Fix:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  strict: true,
  pageSize: 100,
  pagination: {
    maxTop: 200,
    maxSkip: 5000,
    maxPageSize: 100,
  },
});
```

Recommended posture:

- keep `strict: true`
- set `pageSize`
- cap `pagination.maxTop`
- keep list endpoints predictable

### `$batch` requests are timing out or failing under load

Symptoms:

- large `$batch` requests fail with payload, timeout, or response-size issues

Cause:

- one request is concentrating too much work into a single batch

Fix:

- lower `batch.maxOperations`
- lower `batch.maxChangesetOperations`
- lower `batch.maxPayloadBytes`
- set `subRequestTimeoutMs`
- keep response limits bounded

## Database connector specific issues

For v1, connector guidance is PostgreSQL-only.

### `$apply` pushdown does not activate on PostgreSQL

Symptoms:

- a PostgreSQL datasource is configured
- but requests still use fallback behavior

Check:

- the datasource is actually PostgreSQL-backed
- `enableApplyPushdown` is enabled
- the request shape is supported by the PostgreSQL executor

Important:

- not every valid OData transformation is guaranteed to push down
- fallback is expected for unsupported shapes
- the right response is usually to observe and tune, not disable the safety bounds

### Write transactions are rejected

Symptoms:

- writes fail with transaction-support errors
- multi-entity writes are rejected unexpectedly

Common causes:

- datasource transaction support is unavailable
- multiple datasources are involved while `rejectMultiDataSource` is enabled

Fix:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  writeTransactions: {
    enabled: true,
    requireTransactionSupport: true,
    rejectMultiDataSource: true,
  },
});
```

### Binary or JSON columns behave unexpectedly

For PostgreSQL-backed models:

- use `bytea` for property-backed binary media when storing bytes directly in the database
- use `jsonb` where queryable JSON storage is intended
- ensure your LoopBack model property metadata matches the actual PostgreSQL column type

If the database schema and model metadata drift apart, media, serialization, and filtering behavior can all become confusing very quickly.

## Query optimization tips

### Strict mode is rejecting client queries

Symptoms:

- requests fail because clients ask for unsupported or unbounded query shapes

Cause:

- `strict: true` is doing its job

Do not treat this as a bug by default. Strict mode is the safer production posture.

Instead:

- teach clients the supported query subset
- expose paging defaults clearly
- document allowed filter/search patterns

### Expensive `$filter` requests are being rejected or slowed down

Check these knobs:

- `filter.maxInListItems`
- `filter.pushdownMaxJoinCount`
- `filter.maxPostFilterScanRows`
- `filter.requireTopWhenPostFilter`

Recommended posture:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  filter: {
    maxInListItems: 200,
    pushdownMaxJoinCount: 6,
    maxPostFilterScanRows: 5000,
    requireTopWhenPostFilter: true,
  },
});
```

These limits help you avoid:

- giant `in (...)` clauses
- navigation-heavy filters with too many joins
- unbounded fallback scans

### Lambda queries are expensive or rejected

Lambda support can be powerful, but it is also easy to make expensive.

Check:

- `lambda.maxLambdaScanRows`
- `lambda.requireTopWhenLambda`
- `lambda.warnOnLambdaFallback`
- `lambda.pushdown`
- `lambda.pushdownMaxExistsDepth`
- `lambda.pushdownMaxJoinCount`

Recommended posture:

- prefer PostgreSQL pushdown where possible
- keep warnings on
- require `$top` when lambda fallback could scan too much data

### Skiptoken or deltatoken links stop working

Symptoms:

- clients report invalid paging or delta links
- links worked before a deploy or restart and now fail

Common causes:

- `ODATA_TOKEN_SECRET` changed
- clients are reusing expired or tampered links
- legacy unsigned tokens are disabled and the client is still using them

Fix:

- keep `ODATA_TOKEN_SECRET` stable across restarts
- restart the client flow from a fresh collection read or fresh delta snapshot
- only enable `allowLegacyUnsignedTokens` during controlled compatibility windows

## Monitoring and debugging guide

### Turn on the right logs first

When debugging production behavior, start with focused OData logging instead of ad-hoc request dumps.

Useful options include:

- `onLog`
- `requestLogging`
- `logApplyFallbacks`
- `logApplyTelemetry`
- lambda fallback warnings

That combination usually tells you:

- whether a request fell back from PostgreSQL
- whether throttling or guardrails rejected it
- whether query shape or payload size triggered the failure

### Use telemetry and correlation consistently

If you already run structured logging or traces in your LB4 app:

- pass correlation identifiers through request context or headers
- keep OData logs aligned with your app-wide request IDs
- make fallback and throttling events searchable in your observability stack

This is especially important for:

- paging and delta issues that span multiple requests
- `$batch` failures where one sub-request is the real problem
- multi-tenant throttling events

### What to inspect for common 4xx and 5xx issues

If you see repeated client errors:

- inspect the exact query shape
- inspect paging and filter limits
- inspect ETag and `If-Match` behavior on writes
- inspect token-secret stability
- inspect tenant resolution and throttling configuration

If you see repeated server errors:

- inspect datasource and transaction support
- inspect PostgreSQL pushdown fallback logs
- inspect custom media handler behavior
- inspect reverse-proxy headers and externally visible base path

## FAQ

### Should I disable strict mode to make clients happier?

Usually no. `strict: true` is the safer production posture. If clients keep failing, it is usually better to document the supported query subset and paging behavior than to make the server accept everything.

### Should I raise every limit when a request gets rejected?

Usually no. Rejections are often telling you that a request shape is too expensive or too broad. Raise limits only when you understand the workload and have measured the impact.

### Does the default media handler support very large uploads?

No. The default property-backed handler is intentionally bounded. Large-file strategies should use a custom streaming `ODataMediaHandler`.

### Where should CORS and security headers be configured?

In the host LoopBack 4 app or at the proxy/ingress layer, not inside the OData component.

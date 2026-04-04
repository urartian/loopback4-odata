# Advanced Configuration

This guide pulls the most important production-oriented OData settings into one place. It is intentionally narrower than the full [README](README.md) configuration reference and focuses on the settings you are most likely to tune in a real LoopBack 4 service.

For v1, the supported SQL path is PostgreSQL.

## Start from the default config

When overriding configuration, always start from the component's current config instead of replacing it outright.

```ts
import {ODATA_BINDINGS, ODataConfig} from '@urartian/loopback4-odata';

const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
});
```

This preserves defaults such as token handling, capability flags, and other nested settings unless you intentionally replace them.

## Core service settings

Use these options to control how the service is exposed externally.

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  basePath: '/api/odata',
  namespace: 'CatalogService',
  entityContainerName: 'CatalogContainer',
  documentInOpenApiDefault: 'auto',
  removeUndocumentedFromSpec: true,
});
```

Recommended defaults:

- `basePath`: set this to the externally visible OData root
- `namespace` and `entityContainerName`: set these once before clients depend on your metadata
- `documentInOpenApiDefault`: keep `'auto'` unless you want every generated route published
- `removeUndocumentedFromSpec`: keep `true` unless you explicitly want internal routes left in `/openapi.json`

## Query guardrails

Guardrails are one of the most important production controls. They keep analytical or accidental high-cost requests from turning into unbounded scans.

### Paging and collection limits

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  strict: true,
  pagination: {
    maxTop: 200,
    maxSkip: 5000,
    maxPageSize: 100,
    maxApplyPageSize: 50,
  },
  pageSize: 100,
  appendKeysForClientPaging: true,
});
```

Recommended posture:

- keep `strict: true`
- set `pagination.maxTop` and `pageSize` explicitly
- keep `appendKeysForClientPaging: true` for stable manual paging

### `$filter` and `$expand` safety

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  maxExpandDepth: 4,
  filter: {
    maxInListItems: 200,
    pushdownMaxJoinCount: 6,
    maxPostFilterScanRows: 5000,
    requireTopWhenPostFilter: true,
  },
});
```

Use this pattern when you want:

- bounded `in (...)` lists
- bounded join-heavy pushdown
- bounded in-memory post-filter fallback
- explicit client pagination whenever post-filter evaluation is required

### `$batch` limits

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  batch: {
    maxPayloadBytes: 16 * 1024 * 1024,
    maxOperations: 100,
    maxChangesetOperations: 50,
    maxPartBodyBytes: 4 * 1024 * 1024,
    maxResponseBodyBytes: 4 * 1024 * 1024,
    maxResponsePayloadBytes: 32 * 1024 * 1024,
    maxDepth: 2,
    subRequestTimeoutMs: 30_000,
  },
});
```

Keep these budgets tight unless you have a clear integration need to raise them.

## Write behavior and graph operations

### Transactional writes

For PostgreSQL-backed services, transaction-wrapped writes are usually the right default.

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  writeTransactions: {
    enabled: true,
    isolationLevel: 'READ_COMMITTED',
    requireTransactionSupport: true,
    rejectMultiDataSource: true,
  },
});
```

Recommended posture:

- enable transactions for write-heavy APIs
- keep `rejectMultiDataSource: true`
- treat external side effects such as object storage as best-effort unless you coordinate them separately

### Deep insert, deep update, and composition

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  enableDeepInsert: true,
  enableDeepUpdate: true,
  composition: {
    enforcement: 'database',
    defaultDeletePolicy: 'restrict',
    requireTransactionSupport: true,
    maxDepth: 8,
    maxEntities: 5000,
  },
});
```

Recommended posture:

- keep composition enforcement in the database when possible
- start with `restrict` delete semantics unless your domain clearly wants cascade behavior
- cap graph depth and total entity count

## Tokens, paging state, and optimistic concurrency

Signed tokens protect server-driven paging and delta links.

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  tokenSecret: process.env.ODATA_TOKEN_SECRET ?? current.tokenSecret,
  skipTokenTtl: 900,
  deltaTokenTtl: 3600,
  allowLegacyUnsignedTokens: false,
});
```

Recommended posture:

- always provide `ODATA_TOKEN_SECRET` in production
- leave `allowLegacyUnsignedTokens: false` for new deployments
- set token TTLs deliberately so stale links expire on a predictable schedule

For entity concurrency, use ETags on models where clients may overwrite each other:

```ts
@odataModel({etag: 'updatedAt'})
export class Product extends Entity {}
```

## Tenant-aware throttling

If your LB4 app is multi-tenant, bind tenant throttling explicitly instead of depending on app-level rate limits alone.

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  tenantResolver: req => req.headers['x-tenant-id'] as string | undefined,
  tenantQuotas: {
    maxRequestsPerMinute: 120,
    maxConcurrentRequests: 5,
    overrides: {
      premium: {
        maxRequestsPerMinute: 600,
        maxConcurrentRequests: 20,
      },
    },
  },
});
```

Important behavior:

- if `tenantResolver` returns nothing, the request fails with `400 TenantResolutionFailed`
- throttling is per tenant id, based on whatever your resolver returns
- the default backend is process-local unless you bind a shared throttle store

## PostgreSQL `$apply` pushdown

For analytical workloads, enable PostgreSQL pushdown instead of relying on in-memory `$apply` fallback.

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  logApplyTelemetry: true,
  maxApplyResultSize: 2000,
});
```

You can also opt in per model:

```ts
@odataModel({applyPushdown: true})
export class Order extends Entity {}
```

Recommended posture:

- enable pushdown for production PostgreSQL deployments
- keep `logApplyFallbacks` or `onApplyFallback` enabled during rollout
- keep `maxApplyResultSize` bounded so unexpected fallbacks do not become unbounded in-memory work

## Media and large payload guidance

The default property-backed media path is intentionally bounded.

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

Recommended posture:

- keep the default `10 MiB` limit unless you have a clear reason to change it
- for large-file uploads, use a custom `ODataMediaHandler`
- for PostgreSQL binary columns, use `bytea`

Example:

```ts
@property({
  type: 'buffer',
  jsonSchema: {type: 'string', format: 'byte'},
  postgresql: {dataType: 'bytea'},
})
data?: Buffer;
```

## A practical production baseline

This is a reasonable starting point for a PostgreSQL-backed service:

```ts
const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  tokenSecret: process.env.ODATA_TOKEN_SECRET ?? current.tokenSecret,
  strict: true,
  pageSize: 100,
  pagination: {
    maxTop: 200,
    maxSkip: 5000,
    maxPageSize: 100,
    maxApplyPageSize: 50,
  },
  batch: {
    ...(current.batch ?? {}),
    maxOperations: 100,
    maxPayloadBytes: 16 * 1024 * 1024,
  },
  writeTransactions: {
    enabled: true,
    isolationLevel: 'READ_COMMITTED',
    requireTransactionSupport: true,
    rejectMultiDataSource: true,
  },
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  logApplyTelemetry: true,
  maxApplyResultSize: 2000,
  filter: {
    maxInListItems: 200,
    pushdownMaxJoinCount: 6,
    maxPostFilterScanRows: 5000,
    requireTopWhenPostFilter: true,
  },
});
```

## Related docs

- [docs/getting-started.md](getting-started.md)
- [README.md](../README.md)
- [benchmarks/README.md](../benchmarks/README.md)
- [docs/api/index.html](api/index.html)

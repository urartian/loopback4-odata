# Performance Optimization

This guide explains how to tune `@loopback/odata` for production workloads, with a PostgreSQL-first mindset for v1.

The goal is not to make every request as fast as possible at any cost. The goal is to:

- keep expensive work inside PostgreSQL when possible
- bound fallback work when pushdown is not possible
- keep request sizes predictable
- avoid unbounded media buffering on the default path
- use the benchmark harness to validate changes instead of guessing

## Start with measurement

The repository includes a lightweight benchmark harness under [benchmarks](../benchmarks).

Useful commands:

```bash
npm run bench -- --scenario=crud,apply,apply-executor,batch,media,media-write,tokens
npm run bench:soak:gc
npm run bench:postgres:apply
npm run bench:postgres:large
```

Before tuning anything:

- capture a baseline
- make one change
- rerun the relevant scenario
- compare the result to the current baseline in [benchmarks/results.md](/workspace/benchmarks/results.md)

## What to optimize first

In most services, performance issues come from one of these buckets:

1. `$apply` fallback work happening in memory
2. unbounded collection reads without tight paging
3. expensive post-filter or lambda fallback evaluation
4. oversized `$batch` requests
5. large media uploads going through the default property-backed handler

That means the highest-value knobs are usually:

- `enableApplyPushdown`
- `maxApplyResultSize`
- `pageSize`
- `pagination.maxTop`
- `$filter` guardrails
- `$batch` guardrails
- `mediaMaxPayloadBytes`

## Prefer PostgreSQL `$apply` pushdown

For analytical workloads, this is the biggest win.

Enable it globally:

```ts
const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  logApplyTelemetry: true,
  maxApplyResultSize: 2000,
});
```

Or opt in per model:

```ts
@odataModel({applyPushdown: true})
export class Order extends Entity {}
```

Why this matters:

- pushdown keeps aggregation, filtering, ordering, and paging in PostgreSQL
- fallback executes in memory and is intentionally bounded
- logs and telemetry help you detect when a request unexpectedly leaves the database

From the current benchmark baseline in [benchmarks/results.md](/workspace/benchmarks/results.md):

- `$apply` fallback: `67.19 ops/s`, `p95 20.1 ms`
- PostgreSQL pushdown: `268.57 ops/s`, `p95 4.7 ms`

That is a meaningful improvement, and it is why PostgreSQL pushdown should be the default production posture for analytics-heavy workloads.

## Keep collection reads bounded

Large feeds are one of the easiest ways to introduce avoidable load.

Use server-driven paging and tight limits:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  strict: true,
  pageSize: 100,
  pagination: {
    maxTop: 200,
    maxSkip: 5000,
    maxPageSize: 100,
    maxApplyPageSize: 50,
  },
  appendKeysForClientPaging: true,
});
```

Recommended posture:

- keep `strict: true`
- set `pageSize` explicitly
- cap `pagination.maxTop`
- keep `appendKeysForClientPaging: true` for stable client-driven offset paging

## Bound filter and lambda fallback work

Some requests are valid but still expensive. The right answer is usually to bound them, not to let them run forever.

### `$filter` guardrails

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

This helps with:

- large `in (...)` clauses
- join-heavy navigation filters
- expensive post-filter fallback scans
- requests that should be paged explicitly when fallback is needed

### Lambda guardrails

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  lambda: {
    maxLambdaScanRows: 2000,
    requireTopWhenLambda: true,
    warnOnLambdaFallback: true,
    pushdown: 'postgres',
    pushdownStrict: false,
    pushdownMaxExistsDepth: 2,
    pushdownMaxJoinCount: 8,
  },
});
```

Recommended posture:

- enable PostgreSQL lambda pushdown when the workload needs it
- keep fallback warnings on
- cap row scans and join count
- require `$top` when lambda fallback might get expensive

## Tune `$batch` defensively

Large or deeply nested batch requests can concentrate too much work into one request.

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

These limits matter even for internal clients. They protect the service from accidental overload just as much as hostile input.

## Use transactions deliberately

For PostgreSQL-backed write-heavy APIs, transaction support improves correctness and often reduces failure cleanup costs.

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

This is mainly a correctness setting, but it also affects performance behavior under failure because partial graph writes are avoided.

## Treat media carefully

The default property-backed handler is intentionally safe, not designed for huge uploads.

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

Guidance:

- keep the default `10 MiB` limit unless you have a clear bounded use case
- do not treat the property-backed default handler as your large-file ingestion path
- for very large uploads, implement a custom streaming `ODataMediaHandler`

This is especially important because the default handler buffers uploads before persistence.

## Use the benchmark results as your baseline

The current baseline is captured in [benchmarks/results.md](/workspace/benchmarks/results.md).

Highlights:

- in-memory CRUD baseline: `129.69 ops/s`, `p95 13.3 ms`
- in-memory `$batch`: `123.88 ops/s`, `p95 10.0 ms`
- token hot path: `100270.40 token actions/s`
- GC-aware soak runs stayed stable across the covered request loops
- PostgreSQL large dataset `$apply` pushdown: `230.24 ops/s`, `p95 5.0 ms`

Use these numbers as:

- a local regression reference
- a sanity check when changing config defaults
- a way to validate that new feature work does not accidentally force more fallback execution

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

- [docs/getting-started.md](/workspace/docs/getting-started.md)
- [docs/advanced-configuration.md](/workspace/docs/advanced-configuration.md)
- [benchmarks/README.md](/workspace/benchmarks/README.md)
- [benchmarks/results.md](/workspace/benchmarks/results.md)

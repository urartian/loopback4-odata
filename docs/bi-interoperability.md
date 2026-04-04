# BI Interoperability Notes

This guide explains how `@urartian/loopback4-odata` behaves from the perspective of metadata-driven OData consumers such as BI and analytics tools.

It is intentionally tool-neutral. For v1, the goal is not to provide vendor-specific walkthroughs for Power BI, Tableau, or Excel. The goal is to document what those kinds of clients can rely on when they connect to this service.

## What metadata-driven clients care about

Most BI-style OData consumers depend on a small set of behaviors:

- a stable service document at `/odata`
- a reliable `$metadata` document
- predictable paging behavior
- accurate capability annotations
- server-side aggregation support for analytical queries
- correct count and navigation metadata

This library is designed to expose those signals clearly so clients can make better decisions before issuing large or complex requests.

## Service discovery

The first two endpoints to validate are:

- `GET /odata`
- `GET /odata/$metadata`

Clients use them to discover:

- entity sets
- singleton definitions
- actions and functions
- capability annotations
- stream support
- navigation shape

Because the library generates CSDL from your LoopBack models and entity-set registry, metadata-driven consumers can often discover the service surface without any hand-written OData metadata.

## Capability annotations

The generated metadata includes capability annotations that help BI-style clients understand what the service supports.

Important examples:

- `Org.OData.Capabilities.V1.FilterFunctions`
- `Org.OData.Capabilities.V1.FilterRestrictions`
- `Org.OData.Capabilities.V1.CountRestrictions`
- `Org.OData.Capabilities.V1.NavigationRestrictions`
- `Org.OData.Capabilities.V1.InsertRestrictions`
- `Org.OData.Capabilities.V1.UpdateRestrictions`
- `Org.OData.Capabilities.V1.DeleteRestrictions`
- `Org.OData.Capabilities.V1.SearchRestrictions`
- `Org.OData.Capabilities.V1.ApplySupported`
- `Org.OData.Capabilities.V1.BatchSupported`

Why this matters:

- analytical clients can see whether `$apply` is actually supported
- filter UIs can avoid presenting unsupported expressions
- tooling can understand whether batch changesets are allowed
- generated clients can distinguish between read-oriented and write-oriented entity sets

## PostgreSQL `$apply` matters for analytics

For analytical workloads, the most important interoperability point is `$apply`.

Out of the box, `$apply` is functionally correct but may execute in memory. For BI-style workloads, you should enable PostgreSQL pushdown:

```ts
const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  logApplyTelemetry: true,
});
```

When pushdown is active:

- aggregation stages stay in PostgreSQL
- post-aggregate filters stay in SQL
- pagination for eligible `$apply` stages stays in SQL
- metadata reflects that pushdown is really available through `Org.OData.Capabilities.V1.ApplySupported`

This is the recommended v1 posture for analytics-heavy consumers.

## Paging behavior

Collection responses use server-driven paging by default.

Clients should expect:

- `@odata.nextLink` on paged collection reads
- signed `$skiptoken` values
- deterministic ordering safeguards

This is important for metadata-driven clients that read large tables incrementally.

Recommended configuration:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  pageSize: 100,
  pagination: {
    maxTop: 200,
    maxPageSize: 100,
    maxApplyPageSize: 50,
  },
});
```

Notes:

- clients that ignore `@odata.nextLink` and use `$skip` manually may still work, but server-driven paging is the safer path
- `appendKeysForClientPaging: true` helps preserve stable ordering for offset-based consumers

## Counts, deltas, and sync-style consumers

Clients can also rely on:

- inline counts when `enableCount` is enabled
- standalone `$count`
- `@odata.deltaLink` when `enableDelta` is enabled and the entity set has a stable change stamp

This is useful for sync-style analytical clients or data extraction flows that need incremental refresh behavior.

## Actions and functions in metadata-driven tools

Bound and unbound actions/functions appear in the generated CSDL.

That means metadata-driven tooling can discover:

- operation names
- parameters
- return types
- whether an operation is bound to an entity or collection

This is especially helpful when downstream tooling inspects the service model rather than relying only on hand-written client code.

## Recommended interoperability posture

For a production service intended for analytics-friendly consumers, this is a good starting point:

```ts
const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  strict: true,
  enableCount: true,
  enableDelta: true,
  pageSize: 100,
  pagination: {
    maxTop: 200,
    maxPageSize: 100,
    maxApplyPageSize: 50,
  },
  capabilities: {
    ...current.capabilities,
    aggregation: true,
    applySupported: true,
  },
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  logApplyTelemetry: true,
});
```

## Things to watch for

Even when the protocol surface is correct, some client behaviors still deserve attention:

- large analytical requests can still fall back to memory if pushdown is not possible
- aggressive manual paging can create unstable offsets if clients ignore `@odata.nextLink`
- very large media payloads are not part of the default BI path and should use a custom streaming handler strategy
- `$batch` write semantics depend on transaction support and should not be assumed blindly by clients

## Validation checklist

Before calling a service “BI-friendly,” verify:

- `/odata` loads and lists the expected entity sets
- `/odata/$metadata` contains capability annotations for the main analytical entity sets
- `Org.OData.Capabilities.V1.ApplySupported` is present where PostgreSQL pushdown is enabled
- the main analytical feed returns `@odata.nextLink` when paged
- `$count` works for the intended entity sets
- a representative `$apply` query runs successfully against PostgreSQL

Example validation commands:

```bash
curl http://127.0.0.1:3000/odata
curl http://127.0.0.1:3000/odata/\$metadata
curl "http://127.0.0.1:3000/odata/Products?\$top=20&\$count=true"
curl "http://127.0.0.1:3000/odata/OrderItems?\$apply=groupby((order/customer/country),aggregate(order/total%20with%20sum%20as%20TotalSpend))"
```

## Related docs

- [docs/database-postgresql.md](/workspace/docs/database-postgresql.md)
- [docs/performance-optimization.md](/workspace/docs/performance-optimization.md)
- [README.md](/workspace/README.md)

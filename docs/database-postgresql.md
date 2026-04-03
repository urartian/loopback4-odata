# PostgreSQL Setup

This guide covers the supported SQL path for v1: PostgreSQL.

Use it when you want to move beyond the in-memory quick start and run `@loopback/odata` with:

- PostgreSQL-backed repositories
- transactional writes
- PostgreSQL `$apply` pushdown
- PostgreSQL-specific column metadata for binary and JSON payloads

## Prerequisites

- a running PostgreSQL instance
- a LoopBack 4 app using `@loopback/odata`
- the PostgreSQL connector installed in your app

Example:

```bash
npm install loopback-connector-postgresql pg
```

## Environment variables

The example app in this repository uses these variables:

```bash
export USE_POSTGRES=true
export PG_HOST=127.0.0.1
export PG_PORT=5432
export PG_USER=postgres
export PG_PASSWORD=pass
export PG_DATABASE=odata_dev
export PG_SSL=false
export ENABLE_APPLY_PUSHDOWN=true
export LOG_APPLY_TELEMETRY=true
```

You should also provide a stable token secret:

```bash
export ODATA_TOKEN_SECRET=$(openssl rand -hex 32)
```

## Datasource configuration

A basic PostgreSQL datasource looks like this:

```ts
const POSTGRES_DS_CONFIG = {
  name: 'db',
  connector: 'postgresql',
  host: process.env.PG_HOST ?? '127.0.0.1',
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASSWORD ?? 'pass',
  database: process.env.PG_DATABASE ?? 'odata_dev',
  ssl: process.env.PG_SSL === 'true',
};

this.dataSource(new juggler.DataSource(POSTGRES_DS_CONFIG), POSTGRES_DS_CONFIG.name);
```

The repository example app already includes this path in [examples/basic-app/index.ts](/workspace/examples/basic-app/index.ts).

## Recommended OData config for PostgreSQL

This is a solid starting point for a PostgreSQL-backed deployment:

```ts
const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  tokenSecret: process.env.ODATA_TOKEN_SECRET ?? current.tokenSecret,
  strict: true,
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  logApplyTelemetry: process.env.LOG_APPLY_TELEMETRY === 'true',
  maxApplyResultSize: 2000,
  writeTransactions: {
    enabled: true,
    isolationLevel: 'READ_COMMITTED',
    requireTransactionSupport: true,
    rejectMultiDataSource: true,
  },
});
```

Why these settings:

- `enableApplyPushdown`: keeps eligible aggregation workloads in PostgreSQL
- `logApplyFallbacks`: shows when a request leaves the database
- `maxApplyResultSize`: bounds in-memory fallback
- `writeTransactions`: makes write behavior safer and more predictable on PostgreSQL

## Model metadata for PostgreSQL

### Table mapping

If you need an explicit PostgreSQL table name, set it in the model metadata:

```ts
@odataModel({
  lbModel: {
    settings: {
      postgresql: {table: 'products'},
    },
  },
})
export class Product extends Entity {}
```

### Binary columns (`bytea`)

For PostgreSQL-backed stream storage, use `bytea`:

```ts
@property({
  type: 'buffer',
  jsonSchema: {type: 'string', format: 'byte'},
  postgresql: {dataType: 'bytea'},
})
data?: Buffer;
```

This matters for property-backed media entities and other binary payloads.

### JSON / JSONB

If you store structured JSON in PostgreSQL, prefer `jsonb`:

```ts
@property({
  type: 'object',
  required: true,
  postgresql: {dataType: 'jsonb'},
})
decisionSchema!: object;
```

This pairs well with the OData JSON stream-property pattern documented in [README.md](/workspace/README.md).

## PostgreSQL `$apply` pushdown

Pushdown is opt-in. Without it, `$apply` executes in memory.

Enable it globally:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  logApplyTelemetry: true,
});
```

Or per model:

```ts
@odataModel({applyPushdown: true})
export class Order extends Entity {}
```

For v1, PostgreSQL is the supported native pushdown path.

Current benchmark evidence in [benchmarks/results.md](/workspace/benchmarks/results.md):

- `$apply` fallback: `67.19 ops/s`, `p95 20.1 ms`
- PostgreSQL pushdown: `268.57 ops/s`, `p95 4.7 ms`

That is why PostgreSQL pushdown should be your default production posture for analytics-heavy workloads.

## Transactions

For PostgreSQL-backed services, enable transactional writes unless you have a strong reason not to.

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

This applies to:

- create, update, and delete operations
- deep insert and deep update
- `$ref` link and unlink operations
- metadata updates associated with `$value` media routes

`$batch` changesets also take advantage of PostgreSQL transaction support.

## Media on PostgreSQL

For small to medium bounded payloads, the default property-backed media path can be enough:

```ts
@odataModel({
  hasStream: true,
  mediaField: 'data',
  mediaContentTypeField: 'contentType',
  mediaEtagField: 'mediaVersion',
  mediaLengthField: 'size',
  mediaMaxPayloadBytes: 10 * 1024 * 1024,
})
export class MediaAsset extends Entity {
  @property({id: true})
  id?: number;

  @property({type: 'string'})
  contentType?: string;

  @property({type: 'number'})
  size?: number;

  @property({type: 'string'})
  mediaVersion?: string;

  @property({
    type: 'buffer',
    jsonSchema: {type: 'string', format: 'byte'},
    postgresql: {dataType: 'bytea'},
  })
  data?: Buffer;
}
```

Guidance:

- keep the default `10 MiB` limit unless you know the memory cost is acceptable
- for very large uploads, use a custom streaming `ODataMediaHandler`
- do not treat the property-backed default handler as your large-file ingestion strategy

## Example app run command

To run the example app against PostgreSQL with pushdown enabled:

```bash
USE_POSTGRES=true \
PG_HOST=127.0.0.1 \
PG_USER=postgres \
PG_PASSWORD=pass \
PG_DATABASE=odata_dev \
ENABLE_APPLY_PUSHDOWN=true \
LOG_APPLY_TELEMETRY=true \
ODATA_TOKEN_SECRET=$(openssl rand -hex 32) \
npm run dev
```

## Verification checklist

After booting the app, verify:

- `GET /odata` returns the service document
- `GET /odata/$metadata` returns the generated CSDL
- `GET /odata/Products` returns data from PostgreSQL
- a transactional write succeeds
- an `$apply` query works with pushdown enabled

Example:

```bash
curl http://127.0.0.1:3001/odata
curl http://127.0.0.1:3001/odata/\$metadata
curl "http://127.0.0.1:3001/odata/Products?\$top=10"
curl "http://127.0.0.1:3001/odata/OrderItems?\$apply=groupby((order/customer/country),aggregate(order/total%20with%20sum%20as%20TotalSpend))"
```

## Related docs

- [docs/getting-started.md](/workspace/docs/getting-started.md)
- [docs/advanced-configuration.md](/workspace/docs/advanced-configuration.md)
- [docs/performance-optimization.md](/workspace/docs/performance-optimization.md)
- [README.md](/workspace/README.md)
- [benchmarks/results.md](/workspace/benchmarks/results.md)

# Benchmark Results

This file captures the current Section 1.3 benchmark baselines for `@loopback/odata`.

Update this file only with fresh benchmark runs that you want to keep as the current reference point.

## Environment

- Date: 2026-04-02
- Machine / container: local dev environment / devcontainer-style setup
- Node.js: not recorded in this file
- Database: in-memory baseline plus PostgreSQL benchmark database
- Dataset scale:
  - in-memory baseline: 500 rows
  - soak baseline: 1000 rows
  - Postgres apply comparison: 1000 rows
  - Postgres large baseline: 10000 rows
- Notes:
  - Repeated benchmark runs emitted non-failing warnings about missing `params` metadata for `resetInventory` and `resetInventoryRaw`.
  - Large media on the default property-backed handler remains a diagnostic scenario, not a v1 default-path guarantee.

## Commands Run

- `npm run bench -- --scenario=crud,apply,apply-executor,batch,media,media-write,tokens`
- `npm run bench:soak:gc`
- `npm run bench:postgres:apply`
- `npm run bench:postgres:large`
- Optional diagnostic: `npm run bench:postgres:payload`

## In-Memory Baseline

### `npm run bench -- --scenario=crud,apply,apply-executor,batch,media,media-write,tokens`

- CRUD:
  - `129.69 ops/s`
  - `p95 13.3 ms`
  - memory delta `4.97 / 2.38 MiB` heap/rss
- `$apply` fallback:
  - `109.48 ops/s`
  - `p95 11.6 ms`
  - memory delta `-6.71 / 1.88 MiB`
- `$apply` synthetic executor path:
  - `148.84 ops/s`
  - `p95 8.5 ms`
  - memory delta `-3.29 / 1.38 MiB`
- `$batch`:
  - `123.88 ops/s`
  - `p95 10.0 ms`
  - memory delta `-5.21 / 2.13 MiB`
- Media read:
  - `391.39 ops/s`
  - `p95 5.7 ms`
  - memory delta `-7.03 / 1.00 MiB`
- Media write:
  - `272.18 ops/s`
  - `p95 4.4 ms`
  - memory delta `8.44 / 0.25 MiB`
- Tokens:
  - `100270.40 token actions/s`
  - `p95 215.5 ms`
  - memory delta `5.62 / 0.00 MiB`

### `npm run bench:soak:gc`

- CRUD soak:
  - `42.41 ops/s`
  - final delta `3.99 / 2.41 MiB`
  - peak delta `3.99 / 2.41 MiB`
- `$apply` soak:
  - `35.66 ops/s`
  - final delta `1.32 / 0.50 MiB`
  - peak delta `1.32 / 0.50 MiB`
- `$batch` soak:
  - `37.68 ops/s`
  - final delta `2.65 / 1.25 MiB`
  - peak delta `2.66 / 1.25 MiB`
- Media read soak:
  - `57.83 ops/s`
  - final delta `0.26 / 0.25 MiB`
  - peak delta `0.28 / 0.25 MiB`
- Media write soak:
  - `45.95 ops/s`
  - final delta `0.69 / 0.55 MiB`
  - peak delta `0.71 / 0.55 MiB`

## Postgres Baseline

### `npm run bench:postgres:apply`

- `$apply` fallback:
  - `67.19 ops/s`
  - `p95 20.1 ms`
  - memory delta `-9.58 / 2.50 MiB`
- `$apply` pushdown:
  - `268.57 ops/s`
  - `p95 4.7 ms`
  - memory delta `10.18 / 0.38 MiB`
- Conclusion:
  - real Postgres pushdown is materially faster than fallback on the benchmark workload

### `npm run bench:postgres:large`

- CRUD:
  - `144.82 ops/s`
  - `p95 10.6 ms`
  - memory delta `3.25 / 2.13 MiB`
- `$apply` pushdown:
  - `230.24 ops/s`
  - `p95 5.0 ms`
  - memory delta `5.37 / 0.38 MiB`
- `$batch`:
  - `114.03 ops/s`
  - `p95 11.2 ms`
  - memory delta `3.81 / 1.50 MiB`
- Media read:
  - `251.02 ops/s`
  - `p95 5.3 ms`
  - memory delta `4.43 / 0.13 MiB`
- Media write:
  - `148.03 ops/s`
  - `p95 7.9 ms`
  - memory delta `8.99 / 0.38 MiB`

## Large Payload Diagnostic

### `npm run bench:postgres:payload`

- Result:
  - not included in this baseline set
- Interpretation:
  - keep this command as a diagnostic for custom streaming-handler validation, not as a default-path v1 benchmark gate

## Conclusions

- Critical paths benchmarked:
  - CRUD, `$apply`, `$batch`, media read/write, and token hot paths all have recorded baselines
- Memory/soak conclusion:
  - GC-aware soak runs stayed stable and did not show alarming unbounded growth on the covered in-memory scenarios
- Pushdown conclusion:
  - Postgres `$apply` pushdown is significantly faster than fallback on the benchmarked aggregation workload
- Token conclusion:
  - token signing and validation are not a current bottleneck at roughly `100k` token actions per second
- Large media conclusion:
  - the default property-backed media handler remains intentionally bounded; very large media should use a custom streaming handler strategy

## Caveats

- These are local baseline measurements, not CI regression gates.
- The default property-backed media handler is intentionally bounded by `mediaMaxPayloadBytes` and is not the v1 path for very large media ingestion.
- `>100MB` media should be treated as a custom streaming-handler scenario.

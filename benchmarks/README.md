# Section 1.3 Benchmark Harness

This folder contains the first performance harness for `Section 1.3 Performance & Memory Management`.

It is intentionally lightweight:

- no extra benchmark framework dependency
- reuses the existing OData test fixture application
- focuses on repeatable local measurements before CI automation

## Scenarios

- `crud`: collection reads with filtering, ordering, and paging
- `apply`: `$apply` aggregation flow on the selected datasource
- `apply-postgres`: real Postgres `$apply` pushdown for comparison with the fallback path
- `apply-executor`: synthetic in-memory executor path for harness verification
- `batch`: JSON `$batch` execution with multiple read-only sub-requests
- `media`: `$value` media stream reads
- `media-write`: `$value` media stream writes
- `media-large`: one-shot large media upload and download pass
- `tokens`: skip/delta token signing and verification

## Run

```bash
npm run bench
```

Run a single scenario:

```bash
npm run bench -- --scenario=tokens
```

Use smaller smoke settings while iterating:

```bash
npm run bench:smoke
```

Run the server-backed smoke scenarios on a normal local dev machine:

```bash
npm run bench:smoke:server
```

Run a longer memory/soak pass:

```bash
npm run bench:soak
```

Run the soak pass with forced GC sampling:

```bash
npm run bench:soak:gc
```

Run a larger dataset benchmark pass:

```bash
npm run bench:large
```

`bench:large` intentionally uses `apply-executor` instead of the fallback `apply` scenario. The fallback path is bounded by `maxApplyResultSize` and is expected to reject oversized in-memory workloads with `400 Bad Request` once the result set exceeds the configured server limit.

Tune the harness:

```bash
npm run bench -- --scenario=crud,apply --iterations=20 --warmup=5 --concurrency=4 --dataset-scale=1000
```

Compare `$apply` fallback and the synthetic executor-path timings:

```bash
npm run bench -- --scenario=apply,apply-executor --iterations=20 --warmup=5 --dataset-scale=1000
```

Use the plain `apply` scenario for bounded fallback measurements. Use `apply-executor` only to confirm the benchmark harness still exercises the executor branch in memory mode.

## Postgres

Use a dedicated disposable Postgres database for real pushdown checks. The benchmark harness runs `automigrate()` before seeding data, so it will replace the schema in the configured benchmark database.

Required environment:

```bash
export ODATA_BENCH_PG_DATABASE=odata_bench
export ODATA_BENCH_PG_HOST=127.0.0.1
export ODATA_BENCH_PG_PORT=5432
export ODATA_BENCH_PG_USER=postgres
export ODATA_BENCH_PG_PASSWORD=pass
```

Compare fallback vs real Postgres pushdown:

```bash
npm run bench:postgres:apply
```

Run the larger Postgres dataset pass:

```bash
npm run bench:postgres:large
```

Run the `>100 MiB` payload pass:

```bash
npm run bench:postgres:payload
```

Run the release-scale `>1M records` validation pass:

```bash
npm run bench:postgres:million
```

Run the release-scale `>100 concurrent requests` validation pass:

```bash
npm run bench:postgres:concurrency
```

`bench:postgres:payload` uses a separate server process and a separate streaming client process so the upload/download validation does not collapse under a single shared Node heap.

`media-large` installs a benchmark-only `MediaAssets` handler override with a larger payload limit so the test can probe `>100 MiB` behavior without changing the library's default `10 MiB` media safety limit.

At the moment this benchmark is primarily a diagnostic for large-payload support. The default property-backed media path still buffers uploads before persistence, so a failing `bench:postgres:payload` run is expected evidence that `>100 MiB` uploads should use a custom streaming media handler instead of the default in-entity storage path.

`apply-postgres` is the production-style benchmark for Section 1.3. `apply-executor` is intentionally kept separate as a synthetic harness check and should not be used as evidence for real SQL pushdown performance.

`bench:postgres:million` and `bench:postgres:concurrency` are manual release-validation commands for Section 3.3. They are intentionally not part of the default CI path because they require a dedicated Postgres database and can be expensive on shared runners.

When seeding very large datasets, the harness automatically increases the product insert batch size and logs progress every `100,000` records. Override the batch size with `ODATA_BENCH_INSERT_BATCH_SIZE` if your local Postgres setup prefers a different insert size.

`bench:postgres:concurrency` uses a dedicated started server plus real `fetch` requests so the concurrency validation exercises the runtime more like a real deployment instead of relying on the in-process test client path.

## Output

Each scenario reports:

- total operations
- total runtime
- min / avg / max latency
- p50 / p95 latency
- throughput in ops/s
- heap/RSS delta for the scenario window

Scenario counts are workload-specific. For example, the `tokens` scenario reports individual token actions (`signSkip`, `verifySkip`, `signDelta`, `verifyDelta`) instead of only counting outer benchmark iterations.

If you run Node with `--expose-gc`, the harness forces GC before and after each scenario to reduce noise in memory deltas.

Server-backed scenarios (`crud`, `apply`, `apply-postgres`, `batch`, `media`, `media-write`, `media-large`) use the real OData request handler and require an environment that permits ephemeral HTTP listeners. In restricted sandboxes, use `tokens` or run the full harness locally.

The soak runner samples memory over time for long-running request loops and is intended to support the remaining `Section 1.3` checklist items around leak detection and stream stability. Use `npm run bench:soak:gc` when you want more trustworthy leak signals from forced garbage-collection checkpoints.

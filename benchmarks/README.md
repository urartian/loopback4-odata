# Section 1.3 Benchmark Harness

This folder contains the first performance harness for `Section 1.3 Performance & Memory Management`.

It is intentionally lightweight:

- no extra benchmark framework dependency
- reuses the existing OData test fixture application
- focuses on repeatable local measurements before CI automation

## Scenarios

- `crud`: collection reads with filtering, ordering, and paging
- `apply`: `$apply` aggregation flow
- `apply-executor`: `$apply` through the executor path for comparison with fallback mode
- `batch`: JSON `$batch` execution with multiple read-only sub-requests
- `media`: `$value` media stream reads
- `media-write`: `$value` media stream writes
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

Compare `$apply` fallback and executor-path timings:

```bash
npm run bench -- --scenario=apply,apply-executor --iterations=20 --warmup=5 --dataset-scale=1000
```

Use the plain `apply` scenario for bounded fallback measurements. Use `apply-executor` for larger datasets when you want to simulate the production path for high-volume analytics queries.

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

Server-backed scenarios (`crud`, `apply`, `batch`) use the real OData request handler and require an environment that permits ephemeral HTTP listeners. In restricted sandboxes, use `tokens` or run the full harness locally.

The soak runner samples memory over time for long-running request loops and is intended to support the remaining `Section 1.3` checklist items around leak detection and stream stability. Use `npm run bench:soak:gc` when you want more trustworthy leak signals from forced garbage-collection checkpoints.

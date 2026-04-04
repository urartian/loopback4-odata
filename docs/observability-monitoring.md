# Observability and Monitoring

This guide explains how to operate `@urartian/loopback4-odata` in production with a host-first observability model.

The extension already emits structured events and telemetry-friendly context. Your LoopBack 4 application should decide where those events go: console logs, Pino/Winston, OpenTelemetry, Sentry, CloudWatch, Datadog, or another platform.

## Mental model

Treat the OData component as an event source inside your LB4 app.

The component owns:

- OData-specific structured log events
- telemetry categories for apply, rewrite, hooks, batch, throttling, tokens, and requests
- correlation ID capture and propagation
- optional per-request statistics headers

The host LB4 app owns:

- logger implementation
- trace/export pipeline
- alert routing
- dashboards
- retention policy
- error reporting destinations

That separation keeps the package reusable while still making production monitoring practical.

## Structured logging

The easiest integration point is `ODATA_BINDINGS.LOGGER`.

Bind your application logger so OData events join the rest of your service logs:

```ts
import pino from 'pino';
import {ODATA_BINDINGS, ODataLogger} from '@urartian/loopback4-odata';

const logger = pino();

const odataLogger: ODataLogger = {
  trace(message, context) {
    logger.trace(context ?? {}, message);
  },
  debug(message, context) {
    logger.debug(context ?? {}, message);
  },
  info(message, context) {
    logger.info(context ?? {}, message);
  },
  warn(message, context) {
    logger.warn(context ?? {}, message);
  },
  error(message, context, error) {
    logger.error({...(context ?? {}), err: error}, message);
  },
};

app.bind(ODATA_BINDINGS.LOGGER).to(odataLogger);
```

Recommended posture:

- keep logs structured
- preserve the emitted `context` object
- include the correlation ID in your normal app log format
- send OData events to the same sink as the rest of the service

## Metrics and telemetry configuration

The component can emit telemetry about:

- `$apply` pushdown and fallback
- path rewriting
- hook execution
- batch handling
- tenant throttling
- token validation
- request logging

Typical production-oriented configuration:

```ts
const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  telemetry: {
    enabled: true,
    level: 'info',
    categories: ['apply', 'batch', 'throttle', 'tokens', 'requests'],
    sampleRate: 0.25,
    emitStatisticsHeader: true,
    includeApplyPlanOnFallback: true,
    requestLogging: {
      enabled: false,
      allowClientOverride: true,
      includeHeaders: true,
      includeResponseBody: false,
      maxPayloadBytes: 32 * 1024,
      maskHeaders: ['authorization', 'cookie'],
      maskBodyPaths: ['password', 'token'],
    },
  },
  correlation: {
    enabled: true,
    headerName: 'x-correlation-id',
    responseHeaderName: 'x-correlation-id',
    generateWhenMissing: true,
  },
});
```

Recommended posture:

- keep `sampleRate < 1` for very high-traffic services
- leave response-body logging off unless actively debugging
- mask auth/session headers by default
- enable apply fallback telemetry in PostgreSQL-backed environments

Useful event families:

- `apply-fallback`
- `batch.request`
- `tenant-throttle`
- `tenant-throttle-check`
- `token.validation`
- `request.log`

## OpenTelemetry guidance for host LB4 apps

The package does not ship a built-in OpenTelemetry SDK integration.

That is intentional. OTel setup belongs to the host app.

Recommended integration model:

1. initialize OpenTelemetry in the LB4 app
2. bind a logger that forwards OData events into your logging/tracing pipeline
3. use `onLog(entry)` for any extra translation into spans, metrics, or events

Example shape:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  onLog(entry) {
    if (entry.context?.telemetryCategory === 'apply') {
      // translate to your OTel event/span/metric model
      // for example:
      // activeSpan?.addEvent(entry.message, entry.context);
    }
  },
});
```

Good OTel uses for OData events:

- attach `apply-fallback` as span events
- count throttling rejections as metrics
- record token validation failures as diagnostic events
- enrich request spans with `entitySet`, `telemetryCategory`, and `correlationId`

The key point is:

- OData exposes structured data
- your app decides how to map it into OTel primitives

## Error tracking guidance for host LB4 apps

The package also does not ship direct Sentry or Bugsnag integration.

That belongs to the host app’s exception/reporting layer.

Recommended approach:

- capture application errors in your normal LB4 error pipeline
- use `onLog(entry)` to forward notable OData operational events
- avoid turning every expected OData client error into an error-tracker incident

Good candidates for forwarding:

- repeated `apply-fallback` spikes when they indicate a regression
- `tenant-throttle-store-error`
- unexpected `InternalServerError` responses
- repeated token validation failures that suggest misuse or attack traffic

Example shape:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  onLog(entry) {
    if (entry.level === 'error') {
      // Sentry.captureException(entry.error ?? new Error(entry.message), {
      //   tags: {telemetryCategory: String(entry.context?.telemetryCategory ?? 'odata')},
      //   extra: entry.context,
      // });
    }
  },
});
```

Recommended posture:

- do not page on normal `400`/`404` client misuse
- do not forward sensitive request bodies
- group alerts around sustained operational signals, not single noisy requests

## Performance monitoring setup

The existing telemetry and benchmark tooling already give you most of what you need.

Use telemetry in production to watch:

- `$apply` fallback rate
- request latency distribution
- tenant throttling frequency
- token validation failures
- batch request size and duration

Use the benchmark harness in this repo to establish and compare baselines:

- [benchmarks/results.md](../benchmarks/results.md)
- [docs/performance-optimization.md](performance-optimization.md)

Recommended production workflow:

1. keep a local or internal baseline from the benchmark harness
2. monitor OData telemetry in production for drift
3. investigate changes in fallback rate, p95 latency, or throttle events
4. rerun the relevant benchmark scenario before changing defaults blindly

## Correlation IDs

Correlation is enabled by default and should stay part of your normal logging/tracing posture.

Recommended practice:

- pass `x-correlation-id` from clients or edge services when available
- allow the component to generate one when missing
- include that ID in app logs, traces, and error reports

Because repository calls can receive propagated correlation context, downstream logging can still be stitched back to the OData request.

## Related docs

- [README.md](../README.md)
- [docs/performance-optimization.md](performance-optimization.md)
- [docs/troubleshooting.md](troubleshooting.md)
- [docs/deployment-boundaries.md](deployment-boundaries.md)

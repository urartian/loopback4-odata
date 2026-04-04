# Deployment and Service-Boundary Guidance for LB4 Apps

This guide explains how to deploy `@loopback/odata` cleanly inside a LoopBack 4 application.

The main question it answers is:

What should the OData component own, and what should the host LB4 app or infrastructure own?

That separation matters for maintainability, security, and predictable behavior in production.

## Mental model

Treat `@loopback/odata` as a focused protocol component inside your LB4 app.

It should own:

- OData routes and metadata
- query parsing and OData guardrails
- paging and signed tokens
- `$batch` behavior
- OData error shaping
- PostgreSQL `$apply` pushdown
- OData-specific telemetry hooks

Your host LB4 app should own:

- authentication and authorization
- CORS policy
- security headers
- deployment topology
- reverse proxy and ingress behavior
- datasource lifecycle and secrets
- object storage / external file storage
- application-wide logging and monitoring strategy

That boundary is the safest v1 operating model.

## Base path and reverse proxies

If your service is exposed behind an ingress or reverse proxy, configure the externally visible OData root with `basePath`.

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  basePath: '/api/odata',
});
```

This matters because:

- OData routes are still handled internally under `/odata`
- response metadata such as `@odata.context` uses the configured external base path
- generated links need to match what clients actually see

### Proxy header trust

Only trust forwarded headers when you mean to.

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  basePath: '/api/odata',
  trustedProxySubnets: ['10.0.0.0/8'],
});
```

Or, if you explicitly want unconditional trust:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  trustProxyHeaders: true,
});
```

Recommended posture:

- prefer `trustedProxySubnets` over blanket trust
- do not rely on Express global `trust proxy` behavior to configure OData implicitly
- verify that generated `@odata.context` and links match the externally visible service root

## Authentication and authorization

The host LB4 app should own auth policy.

Keep these concerns outside the OData component:

- JWT/session validation
- principal resolution
- RBAC/ABAC checks
- tenant membership checks

The OData component already runs inside the normal LoopBack request pipeline, so your middleware, authentication strategies, and interceptors still apply to generated routes.

Recommended pattern:

- authenticate before OData controllers run
- expose tenant identity through request context or headers
- use `tenantResolver` only to read already-established tenant context, not to invent security policy on its own

## CORS and security headers

These are host-app or edge concerns, not component concerns.

For LB4 apps, configure them in:

- the `RestApplication`
- app middleware
- ingress / reverse proxy

Examples of app-owned concerns:

- CORS origins, methods, and allowed headers
- `X-Content-Type-Options`
- `Content-Security-Policy`
- `Strict-Transport-Security`
- `X-Frame-Options`

This is intentional. A reusable OData component should not silently impose global HTTP policy on the whole app.

## Token secrets and paging state

Signed paging and delta links depend on `ODATA_TOKEN_SECRET`.

In production, set it before boot:

```bash
export ODATA_TOKEN_SECRET=$(openssl rand -hex 32)
```

Recommended posture:

- treat this like any other application secret
- inject it through your deployment secret store or environment management
- rotate it deliberately

Operational note:

- rotating the secret invalidates existing `$skiptoken` and `$deltatoken` links
- clients should be prepared to recover by starting a fresh read or snapshot flow

## Docker-friendly configuration guidance

For containerized LB4 apps, prefer environment-driven configuration instead of baking OData settings into the image.

Recommended posture:

- inject `ODATA_TOKEN_SECRET` through the container runtime or secret manager
- inject PostgreSQL connection settings through environment variables
- keep the image generic and move environment-specific values to deployment config
- avoid checking secrets into `Dockerfile`, `.env`, or source control

Typical variables for a PostgreSQL-backed deployment:

```bash
ODATA_TOKEN_SECRET=...
PG_HOST=postgres
PG_PORT=5432
PG_USER=app_user
PG_PASSWORD=...
PG_DATABASE=app_db
PG_SSL=false
ENABLE_APPLY_PUSHDOWN=true
LOG_APPLY_TELEMETRY=false
```

At the application layer, bind those variables into your datasource and OData config instead of hardcoding them:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  tokenSecret: process.env.ODATA_TOKEN_SECRET ?? current.tokenSecret,
  enableApplyPushdown: process.env.ENABLE_APPLY_PUSHDOWN === 'true',
  logApplyTelemetry: process.env.LOG_APPLY_TELEMETRY === 'true',
});
```

The OData component does not require a custom Docker image layout. A normal LB4 container image is the right baseline.

## Kubernetes deployment guidance

For Kubernetes, keep the same boundary:

- the host LB4 app owns manifests
- the OData component owns config behavior and runtime expectations

Recommended posture:

- store `ODATA_TOKEN_SECRET` in a `Secret`
- store non-secret tuning values in a `ConfigMap`
- inject PostgreSQL credentials from a `Secret`
- use a shared throttle store if you run multiple replicas and need consistent tenant quotas

Suggested split:

- `Secret`
  - `ODATA_TOKEN_SECRET`
  - `PG_PASSWORD`
  - `REDIS_URL` when using a shared tenant throttle store
- `ConfigMap`
  - `PG_HOST`
  - `PG_PORT`
  - `PG_DATABASE`
  - `PG_USER`
  - `ENABLE_APPLY_PUSHDOWN`
  - `LOG_APPLY_TELEMETRY`

In multi-replica deployments, do not rely on the default in-memory throttle store when tenant quotas must apply consistently across pods. Bind a shared store such as `RedisTenantThrottleStore` instead.

## Health check guidance for host LB4 apps

The OData component does not register its own `/health`, `/ready`, or `/live` endpoints.

That is intentional. In LB4, health endpoints belong to the host application.

Recommended posture:

- expose liveness/readiness endpoints from the app, not the component
- keep liveness cheap and independent of heavy downstream checks
- use readiness for checks that may depend on datasource or infrastructure state

Practical guidance:

- `liveness`
  - process is up
  - app boot completed
- `readiness`
  - app boot completed
  - primary datasource can be reached if your operational model requires it
  - optional shared infrastructure dependencies (for example Redis throttle store) are reachable when they are mandatory for the deployment

The OData component should be treated as one dependency inside that app-level readiness decision, not as the owner of the health endpoint contract.

## PostgreSQL deployment posture

For v1, PostgreSQL is the supported SQL path.

Recommended service posture:

- use PostgreSQL for production persistence
- enable write transactions
- enable PostgreSQL `$apply` pushdown
- keep fallback guardrails enabled

Example:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  enableApplyPushdown: true,
  logApplyFallbacks: true,
  writeTransactions: {
    enabled: true,
    isolationLevel: 'READ_COMMITTED',
    requireTransactionSupport: true,
    rejectMultiDataSource: true,
  },
});
```

Keep datasource ownership in the host app:

- datasource creation
- credentials
- SSL mode
- migrations
- connection pool tuning

## Media storage boundaries

The default property-backed media handler is intentionally a bounded convenience path.

Use it when:

- payloads are small to medium
- bounded in-memory buffering is acceptable
- storing binary content in PostgreSQL is operationally acceptable

Do not use it as your large-file ingestion strategy.

For large files, the host app should provide a custom `ODataMediaHandler` that streams to:

- S3 or compatible object storage
- blob storage
- another dedicated file service

That boundary keeps the OData component focused on protocol behavior while your app owns storage architecture.

## Multi-tenant throttling and scaling

Tenant throttling can be enabled inside the component:

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

But the storage strategy is still a deployment concern.

The default throttle store is process-local. For multi-instance deployments, bind a shared store:

```ts
import Redis from 'ioredis';
import {BindingScope} from '@loopback/core';
import {ODATA_BINDINGS, RedisTenantThrottleStore} from '@loopback/odata';

app
  .bind(ODATA_BINDINGS.THROTTLE_STORE)
  .toDynamicValue(() => new RedisTenantThrottleStore(new Redis(process.env.REDIS_URL)))
  .inScope(BindingScope.SINGLETON);
```

Recommended posture:

- use the in-memory default only for single-instance or development setups
- use a shared store when throttling must remain consistent across replicas

## Logging and observability

The OData component emits structured telemetry, but your app should own the logging strategy.

Bind your preferred logger through `ODATA_BINDINGS.LOGGER` and route events into your existing observability stack.

Use app-level observability to own:

- log sinks
- trace correlation
- alert routing
- retention policy
- dashboards

Use OData hooks/config to expose:

- apply fallback events
- throttling events
- request logging
- token validation events

## OpenAPI publishing boundaries

The OData component can mark generated routes for OpenAPI visibility, but your app still owns the API publication strategy.

Relevant settings:

- `documentInOpenApiDefault`
- `removeUndocumentedFromSpec`
- per-model `documentInOpenApi`

Recommended posture:

- publish only the routes you actually want external tooling to consume
- keep internal-only OData surfaces out of the public spec
- review `/openapi.json` after changing visibility defaults

## Trademark and attribution

Use third-party project names descriptively and avoid implying endorsement.

Recommended posture:

- refer to LoopBack, PostgreSQL, AWS, Azure, and Google Cloud as third-party
  platforms or projects, not as sponsors or endorsers of this package
- preserve upstream license and attribution files when redistributing generated
  documentation or bundled assets
- keep this package's own license and third-party notices with the published
  project materials

## Privacy and data-handling boundaries

`@loopback/odata` is a library package, not a hosted service.

That means privacy and regulated-data obligations belong primarily to the host
LB4 app and its operators.

Recommended posture:

- treat request bodies, query values, headers, and entity payloads as
  application data owned by the host app
- decide at the app level whether logs, telemetry, or error reporting may
  contain identifiers or regulated fields
- scrub or avoid sensitive payload logging before forwarding events into
  OpenTelemetry, Sentry, CloudWatch, Datadog, or similar platforms
- apply retention, redaction, and data-subject handling policies in the host
  app and infrastructure

The OData component provides protocol behavior and structured hooks, but it does
not establish a privacy policy on behalf of the application that uses it.

## Suggested production checklist

For a production LB4 deployment:

- set `ODATA_TOKEN_SECRET`
- set an external `basePath` if the service is mounted behind a proxy
- configure `trustedProxySubnets` or `trustProxyHeaders` intentionally
- enforce auth in the host LB4 app
- configure CORS and security headers in the app or proxy
- use PostgreSQL
- enable `writeTransactions`
- enable PostgreSQL `$apply` pushdown
- keep query and batch guardrails enabled
- use a custom streaming media handler for large-file scenarios
- use a shared throttle store if you run multiple instances
- bind structured logging into your existing logger

## Related docs

- [docs/advanced-configuration.md](/workspace/docs/advanced-configuration.md)
- [docs/database-postgresql.md](/workspace/docs/database-postgresql.md)
- [docs/performance-optimization.md](/workspace/docs/performance-optimization.md)
- [README.md](/workspace/README.md)

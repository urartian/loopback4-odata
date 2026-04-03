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

# Cloud Deployment Guidance for Host LB4 Apps

This guide explains how to deploy a LoopBack 4 application that uses `@loopback/odata` on common cloud platforms.

For v1, the important boundary is:

- the host LB4 app owns the cloud deployment shape
- the OData component owns protocol behavior, runtime config, and operational expectations

That means this guide focuses on what cloud deployments should account for when the app exposes OData routes, PostgreSQL-backed persistence, signed paging tokens, batching, media endpoints, and optional tenant throttling.

## General cloud posture

Treat the OData component as stateless application logic.

Recommended posture:

- keep the app itself stateless
- store persistent data in PostgreSQL
- inject secrets and environment config through the cloud platform
- use external/shared services for anything that must survive replicas

Examples of shared dependencies:

- PostgreSQL
- object storage for large media
- Redis for shared tenant throttling when using multiple instances

Examples of config/secrets that should come from the platform:

- `ODATA_TOKEN_SECRET`
- `PG_HOST`
- `PG_PORT`
- `PG_USER`
- `PG_PASSWORD`
- `PG_DATABASE`
- `PG_SSL`
- `REDIS_URL` when using a shared throttle store

## AWS guidance for host LB4 apps

Use AWS as the host deployment platform for the LB4 application, not as a special OData runtime.

Recommended shape:

- run the LB4 app on ECS/Fargate or another container runtime
- use RDS PostgreSQL for the supported v1 database path
- store `ODATA_TOKEN_SECRET` and database secrets in AWS Secrets Manager or Parameter Store
- use S3 plus a custom `ODataMediaHandler` for large-file storage

Important note for Lambda-style hosting:

- `@loopback/odata` is better suited to long-running LB4 server processes than to a serverless-first Lambda shape
- OData batching, metadata routes, large request handling, and connection reuse are simpler on container-based runtimes

If you use AWS with multiple replicas:

- do not rely on the default in-memory tenant throttle store
- bind a shared store such as Redis if tenant quotas must be consistent across instances

## Azure guidance for host LB4 apps

Recommended shape:

- run the LB4 app on Azure App Service or another container-capable service
- use Azure Database for PostgreSQL for the supported v1 database path
- keep `ODATA_TOKEN_SECRET` and DB secrets in Key Vault or app configuration
- use Blob Storage plus a custom `ODataMediaHandler` for large media

Operational note:

- make sure your externally visible `basePath` and proxy headers are configured correctly so `@odata.context` and generated links reflect the public service root

## Google Cloud guidance for host LB4 apps

Recommended shape:

- run the LB4 app on Cloud Run or another container-oriented runtime
- use Cloud SQL for PostgreSQL
- inject secrets through Secret Manager and environment configuration
- use Cloud Storage plus a custom `ODataMediaHandler` for large media

Operational note:

- stateless Cloud Run-style replicas fit well with the OData component as long as shared concerns remain externalized
- tenant throttling should use a shared store when quotas must remain consistent across replicas

## VPS / VM guidance for host LB4 apps

Self-managed VPS or VM deployments are also a valid fit for `@loopback/odata`
as long as the LB4 app keeps the same production boundaries as the cloud-hosted
shapes above.

Recommended shape:

- run the LB4 app as a long-lived process or container under `systemd`, Docker,
  or another process supervisor
- place PostgreSQL on a managed service or a separate database host rather than
  on the same VM when possible
- inject `ODATA_TOKEN_SECRET` and database settings through environment
  variables, secret files, or the process manager
- terminate TLS at a reverse proxy such as Nginx or Caddy
- use external object storage with a custom `ODataMediaHandler` for large media

Operational note:

- configure trusted proxy behavior and `basePath` so generated OData links
  reflect the public service URL
- keep the LB4 app stateless even on a single VM so scaling out later does not
  require reworking token, throttle, or media assumptions
- when you move from one VM to multiple instances, switch tenant throttling to
  a shared store instead of the default in-memory store

## Database connection pooling recommendations

Connection pooling belongs to the host LB4 app and datasource configuration, but it matters directly for OData workloads.

Recommended posture:

- size PostgreSQL pools conservatively
- avoid per-request datasource creation
- keep the datasource singleton-owned by the application
- test pool settings under realistic batch and concurrency workloads

Why this matters for OData:

- `$batch` can concentrate many logical operations into one request
- `$apply` pushdown and complex reads can hold DB connections longer than simple CRUD
- high concurrency runs can exhaust a too-small or too-large pool in different ways

Practical guidance:

- start with the PostgreSQL connector’s standard pool defaults unless you already know your workload
- tune based on:
  - app replica count
  - DB max connections
  - p95 request latency
  - concurrency benchmark results

Do not tune blindly. Use the benchmark harness and production telemetry together.

## Cloud checklist

Before shipping a cloud deployment, confirm:

- `ODATA_TOKEN_SECRET` is injected from a secret store
- PostgreSQL is the backing database
- the LB4 app uses one shared datasource per process
- large media uses external storage when needed
- tenant throttling uses a shared store when multiple replicas are involved
- health endpoints are owned by the host LB4 app
- `basePath` and trusted proxy settings match the public service URL

## Related docs

- [docs/deployment-boundaries.md](/workspace/docs/deployment-boundaries.md)
- [docs/database-postgresql.md](/workspace/docs/database-postgresql.md)
- [docs/observability-monitoring.md](/workspace/docs/observability-monitoring.md)
- [docs/performance-optimization.md](/workspace/docs/performance-optimization.md)

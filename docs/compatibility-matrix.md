# Compatibility Matrix

This document defines the supported runtime and framework baseline for v1.

## Supported runtime matrix

| Area | Supported for v1 | Source |
| --- | --- | --- |
| Node.js | `22.x` | [package.json](/workspace/package.json) `engines.node = >=22 <23` |
| LoopBack Boot | `^8.0.5` | [package.json](/workspace/package.json) `peerDependencies` |
| LoopBack Core | `^7.0.4` | [package.json](/workspace/package.json) `peerDependencies` |
| LoopBack Repository | `^8.0.4` | [package.json](/workspace/package.json) `peerDependencies` |
| LoopBack REST | `^15.0.5` | [package.json](/workspace/package.json) `peerDependencies` |
| TypeScript compiler | `5.9.x` baseline | [package.json](/workspace/package.json) `devDependencies.typescript = ^5.9.2` |
| SQL path | PostgreSQL | documented v1 support policy |

## Application assumptions

The host application is expected to provide:

- a LoopBack 4 `RestApplication`
- compatible LB4 peer packages
- datasource and repository bindings
- `ODATA_TOKEN_SECRET` in production

The package does not bundle its own copy of the core LoopBack packages as runtime dependencies. It expects the host app to provide compatible peer versions.

## Supported database path

For v1, the officially documented and supported SQL path is PostgreSQL.

That means:

- PostgreSQL is the supported production database path
- PostgreSQL `$apply` pushdown is the supported pushdown path
- PostgreSQL examples and operational docs are in scope for v1

Not part of the documented v1 surface:

- MySQL-specific guidance
- SQL Server-specific guidance
- other connector-specific support claims

Some connector-specific code paths may still exist in the codebase, but they are not part of the documented support contract for v1.

The PostgreSQL support path is also the one exercised by the dedicated Postgres benchmarks and pushdown-focused test suite in this repository.

## TypeScript baseline

For v1, the documented compiler baseline is TypeScript `5.9.x`.

That means:

- the package is developed and built against the `5.9.x` compiler line
- the generated types and TypeDoc output are expected to work against that baseline
- broader multi-version TypeScript compatibility is not part of the v1 support contract yet

## Documentation and example scope

The repository includes:

- API reference docs generated with TypeDoc under [docs/api/index.html](/workspace/docs/api/index.html)
- user guides under [docs](/workspace/docs)
- one runnable example app under [examples/basic-app/index.ts](/workspace/examples/basic-app/index.ts)

The example app is a reference app, not a promise that every internal code path or environment switch shown there is part of the supported v1 contract.

## Compatibility notes for adopters

Before adopting v1, confirm:

- your app runs on Node 22
- your LB4 packages are within the supported peer ranges
- your production datasource path is PostgreSQL
- your TypeScript compiler baseline is compatible with `5.9.x`
- you provide `ODATA_TOKEN_SECRET` in production
- your app owns CORS, auth, security headers, and deployment topology outside the OData component

## Related docs

- [README.md](/workspace/README.md)
- [docs/database-postgresql.md](/workspace/docs/database-postgresql.md)
- [docs/deployment-boundaries.md](/workspace/docs/deployment-boundaries.md)

# Pre-v1 Contract Notes

This document captures the intended contract going into v1.

It is not a migration guide for existing customers. The project does not yet have a real user-upgrade story, so this page is meant to record the important support and compatibility boundaries that future adopters should rely on.

## 1. Supported SQL path for v1

For v1, the officially documented and supported SQL path is PostgreSQL.

That means:

- PostgreSQL is the supported production database path
- PostgreSQL `$apply` pushdown is the supported native pushdown path
- PostgreSQL setup, performance, and deployment docs are part of the supported surface

Other connector-specific code paths may still exist in the codebase, but they are not part of the documented v1 contract.

## 2. API and reference docs now exist

The v1 documentation surface now includes:

- narrative guides under [docs](.)
- generated API reference under [docs/api/index.html](api/index.html)
- configuration and protocol details in [README.md](../README.md)

Future changes should treat these docs as part of the public contract, not just internal notes.

## 3. Signed token behavior is the default

Paging and delta links use signed tokens.

Important contract points:

- new deployments should use signed tokens only
- `allowLegacyUnsignedTokens` exists only as a temporary compatibility switch
- new tokens are emitted in the signed `v3:` format

Recommended posture:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  allowLegacyUnsignedTokens: false,
});
```

If an early adopter or internal environment needs to accept older unsigned tokens temporarily, they can enable the flag during a short transition window and then turn it back off.

## 4. Prefer nested pagination config over legacy top-level caps

For new configuration, prefer:

- `pagination.maxTop`
- `pagination.maxSkip`

The legacy top-level fields still exist for compatibility:

- `maxTop`
- `maxSkip`

But the intended v1 config shape is the nested pagination block.

Recommended pattern:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  pagination: {
    maxTop: 200,
    maxSkip: 5000,
    maxPageSize: 100,
    maxApplyPageSize: 50,
  },
});
```

## 5. OpenAPI visibility is now explicit

The intended v1 publication model uses:

- `documentInOpenApiDefault`
- `removeUndocumentedFromSpec`
- per-model `documentInOpenApi`

That means generated OData routes are no longer an all-or-nothing surprise. Future adopters should treat OpenAPI visibility as an explicit part of the contract.

## 6. Large media remains a bounded default path

The default property-backed media handler is intentionally bounded.

Important contract point:

- the default path is not the large-file ingestion strategy for v1
- for larger uploads, use a custom streaming `ODataMediaHandler`

The default `mediaMaxPayloadBytes` limit remains part of the safe out-of-the-box behavior.

## 7. Write transactions and tenant throttling are first-class config

Two config areas that are part of the intended v1 contract:

- `writeTransactions`
- `tenantQuotas` with `tenantResolver`

These are no longer incidental internals. They are part of the supported operational configuration surface and should be documented and tested as such.

## 8. Singleton-only mode is part of the supported model contract

`singletonOnly` is part of the intended v1 public surface.

That means:

- singleton-only resources are an explicit supported pattern
- entity-set exposure can be intentionally suppressed for singleton models
- future changes should preserve the documented singleton semantics

## Related docs

- [docs/compatibility-matrix.md](compatibility-matrix.md)
- [README.md](../README.md)
- [docs/database-postgresql.md](database-postgresql.md)

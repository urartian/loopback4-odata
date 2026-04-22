# @urartian/loopback4-odata

An extension for [LoopBack 4](https://loopback.io/doc/en/lb4/) that adds **OData protocol support**.
This package implements **OData v4.0** for LoopBack 4 applications.

- Auto-discovers OData controllers and generates CRUD routes.
- Exposes OData-style endpoints (`/odata/Products(1)`) and OpenAPI-compliant ones (`/odata/Products/{id}`).
- Provides `$metadata` endpoint.
- Simple developer experience with decorators.
- Advanced `$apply` support including chained transformations, navigation-path aggregates, and safe in-memory fallbacks when connector pushdown is unavailable.
- Streams `$batch` multipart payloads end-to-end, preserving binary sub-responses (PDFs, CSV exports, etc.) without re-encoding them (JSON batches base64-encode binary bodies and include their `Content-Type`).

For v1, the officially documented and supported SQL path is PostgreSQL. Other connector-specific paths that may still exist in the codebase are not part of the supported surface yet.

`v1.0.0` is the first supported public release of the package. CRUD endpoints, `$expand`, `$count`, `$batch`, Actions/Functions, server-driven paging (`$skiptoken`), delta links (`$deltatoken`), and PostgreSQL-first production guidance are part of the documented surface. Ongoing work is tracked in [docs/roadmap.md](https://github.com/urartian/loopback4-odata/blob/main/docs/roadmap.md).

Community and support guidance lives in [docs/community.md](https://github.com/urartian/loopback4-odata/blob/main/docs/community.md).

---

## Installation

```bash
npm install @urartian/loopback4-odata
# if your application does not yet depend on LoopBack core packages:
npm install @loopback/core@^7 @loopback/repository@^8 @loopback/rest@^15 @loopback/boot@^8
```

> Requires Node.js 22.x and the host application must supply compatible versions of `@loopback/boot`, `@loopback/core`, `@loopback/repository`, and `@loopback/rest` (the extension lists them as peer dependencies to avoid duplicate copies).

## Getting Started

1. Enable the component

In your application class:

```ts
import { ApplicationConfig } from '@loopback/core';
import { BootMixin } from '@loopback/boot';
import { RepositoryMixin } from '@loopback/repository';
import { RestApplication } from '@loopback/rest';
import { ODataComponent, ODATA_BINDINGS, ODataConfig } from '@urartian/loopback4-odata';

export class MyAppApplication extends BootMixin(RepositoryMixin(RestApplication)) {
  constructor(options: ApplicationConfig = {}) {
    super(options);

    this.component(ODataComponent); // enable OData support
    const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    this.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      tokenSecret: process.env.ODATA_TOKEN_SECRET ?? current.tokenSecret,
    });
    // Register datasources and repositories once they are defined (see Step 3).
  }
}
```

> **Production tip:** In production (`NODE_ENV=production` or `ODATA_ENV=production`) you **must** provide `ODATA_TOKEN_SECRET`; the component fails to boot when it’s missing. In non-production environments the component auto-generates a random per-boot secret when none is configured and logs an INFO message (`Generated per-boot OData token secret ...`). Set `ODATA_TOKEN_SECRET=$(openssl rand -hex 32)` locally if you need tokens to survive restarts. Rotating the secret (manually or via auto-generation) invalidates existing `$skiptoken` / `$deltatoken` links.

2. Define a model

```ts
import { Entity, property } from '@loopback/repository';
import { odataModel } from '@urartian/loopback4-odata';

@odataModel({
  lbModel: { settings: { strict: true } },
  etag: 'updatedAt',
  delta: {
    enabled: true,
    field: 'updatedAt',
  },
})
export class Product extends Entity {
  @property({ id: true })
  id!: number;

  @property()
  name!: string;

  @property()
  price!: number;

  @property({ type: 'date', defaultFn: 'now' })
  updatedAt!: Date;
}
```

Note: `@odataModel()` replaces LoopBack’s `@model()` for OData entity sets, but you still use standard LoopBack `@property`/relation decorators to define schema and relations. The `lbModel` block is passed through 1:1 to LoopBack’s `@model(definition)` decorator (the same object you’d otherwise pass to `@model({ ... })`). See LoopBack model definition settings: https://loopback.io/doc/en/lb4/Model.html#supported-entries-of-model-definition

Common `lbModel.settings` examples:

```ts
@odataModel({ lbModel: { settings: { strict: true } } })
@odataModel({ lbModel: { settings: { postgresql: { table: 'products' } } } })
@odataModel({ lbModel: { settings: { indexes: { idx_sku: { keys: { sku: 1 }, options: { unique: true } } } } } })
```

3. Create a repository

The component expects a `DefaultCrudRepository` binding for each model decorated with `@odataController`. Provide a datasource and expose the repository via `RepositoryMixin`.

```ts
import { inject } from '@loopback/core';
import { DefaultCrudRepository, juggler } from '@loopback/repository';

const ds = new juggler.DataSource({
  name: 'db',
  connector: 'memory',
});

export class ProductRepository extends DefaultCrudRepository<Product, typeof Product.prototype.id> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(Product, dataSource);
  }
}
```

Register both the datasource and the repository inside the application constructor from Step 1:

```ts
this.dataSource(ds);
this.repository(ProductRepository);
```

4. Add a controller

```ts
import { odataController } from '@urartian/loopback4-odata';

@odataController(Product)
export class ProductODataController {}
```

That’s it — the extension generates repository-backed CRUD endpoints automatically. For a fully wired runnable reference, see `examples/basic-app/index.ts` in this repository.

## Singletons

OData V4 **singletons** expose a single entity instance at a stable URL (for example `/odata/Me`)
while reusing the same model/repository and CSDL `EntityType` as the backing entity set.

### Entity sets vs singletons (important)

By default, declaring a `singleton` **does not disable** the entity set endpoints for that model.
When you decorate a model with both `entitySetName` and `singleton`, this extension exposes **two**
top-level resources:

- **EntitySet** at `/odata/<entitySetName>` (collection semantics)
  - `GET /odata/<entitySetName>` returns `{ "@odata.context": "...", "value": [ ... ] }`
  - `POST /odata/<entitySetName>` creates a new entity
  - `GET/PATCH/PUT/DELETE /odata/<entitySetName>(<key>)` address a single entity by key
- **Singleton** at `/odata/<singleton.name>` (single-entity semantics)
  - `GET /odata/<singleton.name>` returns a single entity (no `value` array)
  - `PATCH/PUT /odata/<singleton.name>` update/replace the singleton entity
  - `DELETE /odata/<singleton.name>` is only allowed when `singleton.nullable: true`

To avoid route and metadata conflicts, **singleton names must not match the entity set name**
(case-insensitive) unless you enable `singletonOnly` (see below).

Declare a singleton on the model via `@odataModel({ singleton: ... })`:

```ts
@odataModel({
  entitySetName: 'Users',
  singleton: {
    name: 'Me',
    resolveId: async ({ request }) => (request as any).user.id,
  },
})
export class User extends Entity {}
```

Static singleton (fixed key):

```ts
@odataModel({
  // Pick distinct names: the entity set is a collection, the singleton is a single entity.
  entitySetName: 'SettingEntries',
  singleton: { name: 'Settings', id: '1' },
})
export class AppSettings extends Entity {}
```

#### Interop note

Some OData servers choose to treat singletons as “singleton-only” resources
that reject `POST` and do not expose a corresponding entity set collection endpoint at the same
URL. By default, this extension exposes singletons **in addition to** the entity set endpoints, so
clients must call the singleton URL (`/odata/<singleton.name>`) to get singleton semantics. Use
`singletonOnly: true` for singleton-only behavior.

#### Singleton-only mode (`singletonOnly: true`)

To prevent accidental use of the entity set endpoints (for example, `POST /odata/Settings`
creating multiple rows), you can enable singleton-only mode:

```ts
@odataModel({
  entitySetName: 'Settings',
  singletonOnly: true,
  singleton: { name: 'Settings', id: '1' },
})
export class AppSettings extends Entity {}
```

When `singletonOnly: true`:

- The service document and `$metadata` omit the `EntitySet` entry for the model.
- Collection/entity set CRUD routes are not registered (no `GET/POST /odata/<EntitySetName>`).
- The singleton routes remain available under `/odata/<singleton.name>`.
- `singleton.name` may match `entitySetName` (for example `/odata/Settings`).
- Bound actions/functions and entity-set navigation routes are not generated in this mode yet.

Endpoints (examples):

- `GET /odata/Me`
- `PATCH /odata/Me` and `PUT /odata/Me`
- Navigation reads like `GET /odata/Me/Orders`
- `$ref` routes like `POST /odata/Me/Orders/$ref`, `PUT /odata/Me/Manager/$ref`,
  and `DELETE /odata/Me/Orders(<key>)/$ref` (relation-dependent)

The service document (`GET /odata`) and `$metadata` include singleton entries. `DELETE /odata/<Singleton>`
is only allowed when `singleton.nullable: true`.

### Errors and error codes

OData endpoints return errors using an OData error payload (for example `{"error":{"code":"BadRequest","message":"..."}}`).

- `error.code` is stable and intended for client logic (use it instead of parsing messages).
- `error.message` is human-readable and may change; do not parse it for behavior.
- If a downstream connector/database error bubbles up with its own string `err.code`, it is preserved as diagnostics under `error.innererror.dbCode` (not as `error.code`).

The authoritative list of stable codes lives in `src/odata-error-codes.ts` (exported as `ODataErrorCodes` from `@urartian/loopback4-odata`).

Stable codes are grouped as follows:

- Core HTTP-derived codes: `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `MethodNotAllowed`, `PreconditionFailed`, `PreconditionRequired`, `PayloadTooLarge`, `NotImplemented`, `InternalServerError`, `NotAcceptable`, `UnsupportedMediaType`, `UnprocessableEntity`, `Gone`, `TooManyRequests`, `ServiceUnavailable`.
  These are the default response codes emitted when no more specific OData code is attached to the error.
- Batch and transport codes: `InvalidUrl`, `InvalidMethod`, `ResponseTooLarge`, `TooManyRedirects`, `BatchExecutionError`, `BatchSubRequestTimeout`, `batch-operation-limit-exceeded`, `changeset-operation-limit-exceeded`, `batch-payload-size-limit-exceeded`, `batch-part-size-limit-exceeded`, `batch-depth-limit-exceeded`.
  These identify malformed batch requests, batch guardrail violations, redirect problems, timeouts, and oversized responses.
- Preferences, tenancy, and transaction codes: `PreferenceNotSupported`, `TenantResolutionFailed`, `TransactionCommitFailed`, `TransactionsNotSupported`, `MultiDataSourceChangesetNotSupported`, `AtomicityGroupNotSupported`.
  These cover unsupported client preferences, tenant resolution failures, and transactional guarantees that cannot be honored.
- Content-ID resolution code: `content-id-reference-invalid`.
  This is returned when a `$batch` request references an unknown or invalid `Content-ID`.
- Query, lambda, pushdown, and guardrail codes: `lambda-or-unsupported`, `nested-lambda-depth-exceeded`, `lambda-alias-prefix-required`, `pushdown-join-count-exceeded`, `through-relation-unsupported`, `navigation-filter-requires-pushdown`, `postfilter-requires-pushdown`, `postfilter-top-required`, `postfilter-scan-limit-exceeded`, `lambda-pushdown-not-eligible`, `lambda-scan-limit-exceeded`.
  These describe unsupported query shapes, lambda validation failures, and cases where bounded in-memory fallback or SQL pushdown constraints were exceeded.
- Typed literal validation codes: `invalid-guid-literal`, `invalid-date-literal`, `invalid-datetimeoffset-literal`, `invalid-int64-literal`, `invalid-decimal-literal`, `in-list-too-large`, `in-operator-requires-list`, `in-operator-requires-literal-list-items`, `in-operator-requires-non-empty-list`.
  These are used when OData literals cannot be parsed safely or when `in (...)` operands violate validation rules.

For client code, prefer importing `ODataErrorCodes` and comparing against the exported constants instead of hard-coding string literals.

### Authentication & Authorization

The component mirrors LoopBack’s authentication and authorization metadata from your controller onto every generated CRUD endpoint. Decorate your OData controller exactly as you would a regular REST controller and the extension takes care of the rest:

```ts
import { authenticate } from '@loopback/authentication';
import { authorize } from '@loopback/authorization';

@odataController(Product)
@authenticate('jwt')
@authorize({ scopes: ['product.read'] })
export class ProductODataController {
  // Stubbing a method is enough to apply fine-grained metadata.
  // Decorators (authorization, interceptors, etc.) only run when a stub exists.
  @authorize({ scopes: ['product.summary'] })
  async find() {}
}
```

Generated routes (list, findById, create, update, delete) will enforce the same strategies and scopes. `$batch` requests automatically reuse the caller’s headers and resolved user profile, so you don’t have to repeat credentials for each entry.

LoopBack’s built-in methods (`find`, `findById`, `create`, `updateById`, `replaceById`, `deleteById`, `count`) are remapped to the OData CRUD handlers automatically. `$value` routes reuse metadata from `getMediaValue`, `replaceMediaValue`, and `deleteMediaValue`, so add empty stubs with those names when you need to secure media streams:

```ts
@odataController(MediaAsset)
@authenticate('jwt')
export class MediaAssetController {
  @authorize({ scopes: ['media.read'] })
  async find() {}

  @authorize({ scopes: ['media.read'] })
  async findById() {}

  @authorize({ scopes: ['media.read'] })
  async getMediaValue() {}

  @authorize({ scopes: ['media.update'] })
  async replaceMediaValue() {}

  @authorize({ scopes: ['media.delete'] })
  async deleteMediaValue() {}
}
```

If you expose differently named controller methods, supply custom aliases when registering the entity set so the security metadata still flows through. Any of the canonical handlers below can be remapped: `find`, `findById`, `create`, `updateById`, `replaceById`, `deleteById`, `count`, `linkNavigationRef`, `unlinkNavigationRef`, `getMediaValue`, `replaceMediaValue`, and `deleteMediaValue`.

```ts
import { ODATA_BINDINGS } from '@urartian/loopback4-odata';

const registry = await app.get(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
registry.register({
  name: 'Products',
  modelCtor: Product,
  repositoryBindingKey: 'repositories.ProductRepository',
  securityMethodAliases: {
    find: 'list',
    findById: 'get',
    create: 'create',
    updateById: 'patch',
    replaceById: 'put',
    deleteById: 'remove',
    count: 'count',
    linkNavigationRef: 'attachRelation',
    unlinkNavigationRef: 'detachRelation',
    replaceMediaValue: 'uploadBinary',
    getMediaValue: 'downloadBinary',
    deleteMediaValue: 'removeBinary',
  },
});
```

Write metadata from the controller (`update*`, `replace*`, `patch*`, `delete*`) automatically propagates to the navigation `$ref` handlers so users with read-only scopes cannot relink entities. If you need different policies on `$ref`, you can still override them via `securityMethodAliases` or by decorating the stub methods directly:

```ts
@odataController(Order)
@authenticate('jwt')
export class OrderODataController {
  // Override default write policy by attaching custom metadata
  @authorize({ allowedRoles: ['order-manager'] })
  async linkNavigationRef() {}

  @authorize({ allowedRoles: ['order-manager'] })
  async unlinkNavigationRef() {}
}
```

Navigation reference routes run through the generated CRUD controller, so the same LoopBack authentication and authorization interceptors execute before links are created or removed. Stub methods with `@authenticate` / `@authorize` metadata (or aliases from the writable methods) are enough to secure the `$ref` endpoints without any additional plumbing.

## Example Requests

To try the repository's bundled demo app:

```bash
npm run dev
```

This boots the example app in `examples/basic-app`, with an in-memory datasource pre-seeded with sample products and orders so you can experiment with the query options immediately. If you are integrating the package into your own LoopBack 4 application, use that host app's normal start command instead.

> The example binds `tokenSecret` from `process.env.ODATA_TOKEN_SECRET` but the component already enforces the same behavior internally. In production you must set that environment variable; in dev/test a random secret is generated per boot (logged at INFO) unless you override it. You can also tweak guardrails at runtime via environment variables such as `BATCH_MAX_OPERATIONS`, `BATCH_MAX_PART_BYTES`, `ODATA_MAX_TOP`, `ODATA_MAX_SKIP`, `ODATA_MAX_PAGE_SIZE`, and `ODATA_MAX_APPLY_PAGE_SIZE`.

##### Metadata

```bash
GET /odata/$metadata
```

Returns generated EDMX/CSDL describing your registered entity sets.

##### Collection

```bash
GET /odata/Products
```

###### Response:

```json
{
  "@odata.context": "/odata/$metadata#Products",
  "value": [
    {
      "id": 1,
      "name": "Laptop",
      "price": 1299
    }
  ]
}
```

##### Single entity

Both forms work:

```http
GET /odata/Products/1
GET /odata/Products(1)
```

###### Response:

```json
{
  "@odata.context": "/odata/$metadata#Products/$entity",
  "@odata.etag": "W/\"01FZJH6G9E7AM4\"",
  "id": 1,
  "name": "Laptop",
  "price": 1299
}
```

##### Primitive values

Use the `$value` path segment to stream a single primitive property:

```http
GET /odata/Products(1)/name/$value
```

###### Response (`text/plain`):

```
Laptop
```

For binary fields the server responds with `application/octet-stream` and streams the raw payload.

##### Create

```bash
curl -X POST /odata/Products \
  -H 'Content-Type: application/json' \
  -d '{"name":"Laptop","price":1299}'
```

Returns the persisted entity at the top level with standard OData annotations.

##### Update & Delete

```http
PATCH  /odata/Products/1
DELETE /odata/Products/1
```

`PATCH` accepts partial payloads, and `DELETE` responds with `204 No Content` once the repository removes the entity.

> **Note**
>
> The CRUD controller does **not** generate a `PUT /odata/<EntitySet>/{id}` endpoint. All scalar/JSON updates must go through `PATCH` (or the `$batch` equivalent). `PUT` is reserved exclusively for `$value` media streams, so calling `PUT /odata/Products(1)/$value` only replaces the binary payload and its metadata — it will never touch regular model properties like `title`.

When you enable optimistic concurrency by configuring an ETag property (for example `@odataModel({etag: 'updatedAt'})`), the generated endpoints require clients to supply the latest ETag via the `If-Match` request header. Missing headers result in `428 Precondition Required`, while mismatched values return `412 Precondition Failed`. ETags are exposed both in response headers and as the `@odata.etag` field in response bodies so clients can round-trip them easily.

##### Query options

Common OData query options are translated into LoopBack filters out of the box:

```http
GET /odata/Products?$filter=price gt 500 and name ne 'Monitor'&$orderby=price desc&$top=5&$skip=10&$select=id,name,price
```

Becomes:

```json
{
  "where": {
    "and": [{ "price": { "gt": 500 } }, { "name": { "neq": "Monitor" } }]
  },
  "order": ["price DESC"],
  "limit": 5,
  "offset": 10,
  "fields": { "id": true, "name": true, "price": true }
}
```

You can combine `$filter` (eq, ne, gt, ge, lt, le with `and`/`or`, plus string predicates like `contains`, `startswith`, `endswith`), `$orderby`, `$top`, `$skip`, and `$select` to shape the data returned by your repository queries.

Examples of string predicates translated to LoopBack filters:

```http
GET /odata/Products?$filter=contains(name,'Lap')
```

```json
{
  "where": {
    "name": { "like": "%Lap%", "escape": "\\" }
  }
}
```

```http
GET /odata/Products?$filter=startswith(code,'PR-')
```

```json
{
  "where": {
    "code": { "like": "PR-%", "escape": "\\" }
  }
}
```

```http
GET /odata/Products?$filter=endswith(category,'ware')
```

```json
{
  "where": {
    "category": { "like": "%ware", "escape": "\\" }
  }
}
```

Use `$expand` to inline related models that are registered on your LoopBack entity relations:

```http
GET /odata/Orders?$expand=customer,items
```

The extension validates relation names against the model metadata and produces the corresponding `include` filter:

```json
{
  "include": [{ "relation": "customer" }, { "relation": "items" }]
}
```

`$expand` is also supported on single-entity requests (`/odata/Orders(1)?$expand=customer`). Unknown relation names result in a `400 Bad Request` response so clients get immediate feedback when requesting unsupported navigation properties.

> **Note:** OData identifiers are case-sensitive. Use the exact navigation property names exposed in `$metadata` (for example, `$expand=orders` not `$expand=Orders`).

Use `$levels` to follow a recursive navigation property for multiple hops while reusing the same scoped options at every depth:

```http
GET /odata/Employees?$expand=manager($levels=2;$select=id,name)
```

This returns each employee with their direct manager and that manager's manager in a single round trip.

The `$compute` option projects virtual fields evaluated after the repository fetch. Expressions support arithmetic (`add`, `sub`, `mul`, `div`, `mod`), simple string helpers (`tolower`, `toupper`, `concat`), literals, and property paths:

```http
GET /odata/OrderItems?$compute=quantity mul unitPrice as LineTotal&$select=id,LineTotal
```

The response includes the additional `LineTotal` column without altering/store schemas. Computed aliases can participate in `$select` and client-side sorting but are currently incompatible with `$apply` pushdowns or server-driven ordering.

Responses are emitted as JSON by default. Clients can force a JSON payload regardless of the `Accept` header via `?$format=json`. Other media types (XML, CSV, etc.) are not yet supported.

Advanced filter helpers supported:

- Logical NOT

```http
GET /odata/Products?$filter=not price gt 100
```

```json
{ "where": { "price": { "lte": 100 } } }
```

- Numeric functions: `round`, `floor`, `ceiling`

```http
GET /odata/Products?$filter=round(price) eq 10
```

```json
{ "where": { "and": [{ "price": { "gte": 9.5 } }, { "price": { "lt": 10.5 } }] } }
```

- Compound keys and alternate key predicates are rewritten transparently:

```http
GET /odata/Orders(OrderID=10248,CustomerID='ALFKI')
```

Normalizes to the REST-friendly route `/odata/Orders/OrderID%3D10248%2CCustomerID%3DALFKI` before reaching the controller, while preserving string literals (including embedded parentheses, commas, and escaped quotes).

- Date extraction: `year(<DateTimeOffset>) eq <year>`

```http
GET /odata/Orders?$filter=year(updatedAt) eq 2024
```

Translates to a UTC date range for that year.

- Basic `$search`

```http
GET /odata/Products?$search=Laptop
```

Performs a case‑insensitive substring search across all string properties of the model. Multiple terms are OR’ed. Quoted phrases are treated as a single token. Boolean operators are not yet interpreted.

- String position: `indexof`

```http
GET /odata/Products?$filter=indexof(name,'Lap') ge 0
```

Equivalent to `contains(name,'Lap')`. To test absence use `eq -1`, or wrap a supported comparison in `not`:

```http
GET /odata/Products?$filter=indexof(name,'Lap') eq -1
```

Strict limitations: only presence/absence forms are supported (`ge 0`, `gt -1`, `eq -1`) plus their negations. Exact position comparisons like `indexof(name,'Lap') eq 2` are rejected with 400 in strict mode.

- Substring at position: `substring`

```http
GET /odata/Products?$filter=substring(code,2) eq 'ABC'
```

Checks that `code` has `ABC` starting at index 2 (0‑based). With explicit length:

```http
GET /odata/Products?$filter=substring(code,4,3) ne 'XYZ'
```

Strict limitations: supports only `eq` / `ne` with a string literal on the right‑hand side. Other comparators or non‑string RHS are rejected (400).

- String length predicates: `length`

```http
GET /odata/Products?$filter=length(description) eq 0
GET /odata/Products?$filter=length(code) gt 3
GET /odata/Products?$filter=not length(code) lt 2
```

All comparison operators (`eq`, `ne`, `gt`, `ge`, `lt`, `le`) are supported with integer literals.

- Lambda filters alongside additional predicates

```http
GET /odata/Products?$filter=orderItems/any(i: i/unitPrice gt 800) and price gt 1000
```

The parser keeps lambdas for post-processing or SQL pushdown while still applying any root predicates (like `price gt 1000`) to the database query. Lambdas support `any/all` across multi-segment navigation paths and can participate in full `$filter` boolean expression trees (for example `(<lambda>) or (<root predicate>)`). See [Configuration](#configuration) for the full lambda grammar, guardrails, and pushdown options.

### Searchable Fields

Control which fields participate in `$search`:

- Decorate properties with `@odataSearchable()` in your model.
- Or configure per–entity set in `ODataConfig.searchFields`.
- Default : `$search` is opt-in and uses only annotated fields. If no searchable fields are configured, strict mode returns `400 Bad Request`.
- Guardrails: cap inputs with `maxSearchTerms` (requests above the cap return `400 Bad Request`) and trim the evaluated field list with `maxSearchFields` so only the first N configured properties participate.

Example:

```ts
@odataModel()
export class Product extends Entity {
  @property({ id: true }) id!: number;
  @odataSearchable() @property() name!: string;
  @odataSearchable() @property() sku!: string;
  @property() price!: number;
}

// Or centrally via config
this.bind(ODATA_BINDINGS.CONFIG).to({
  searchMode: 'config-only',
  searchFields: { Products: ['name', 'sku'] },
} as ODataConfig);
```

### Handling Large Integer Types (BigInt/Int64)

When working with large integer types like `bigint` in PostgreSQL or `int64` in OData, special care must be taken to avoid JavaScript's number precision limitations. JavaScript's `Number.MAX_SAFE_INTEGER` is `9007199254740991`, which is smaller than the maximum value for 64-bit integers (`9223372036854775807`).

To properly handle large integers without precision loss:

1. **Define the property as a string type with proper format specification:**

```ts
@property({
  type: 'string',  // Use string type to preserve precision
  jsonSchema: {
    type: 'string',
    format: 'int64',
    dataType: 'int64'
  },
  postgresql: {
    dataType: 'bigint'  // Still maps to bigint in the database
  }
})
sequence?: string;  // Use string type in the application layer
```

2. **Avoid using `type: 'number'` for properties that might exceed `Number.MAX_SAFE_INTEGER`:**

❌ **Incorrect:**

```ts
@property({
  type: 'number',  // This can cause precision loss for large values
  postgresql: {
    dataType: 'bigint'
  }
})
sequence?: number;
```

✅ **Correct:**

```ts
@property({
  type: 'string',  // Preserves precision
  jsonSchema: {
    type: 'string',
    format: 'int64'  // Tells OData to treat as int64
  },
  postgresql: {
    dataType: 'bigint'  // Maps to bigint in database
  }
})
sequence?: string;
```

This approach ensures that large integer values maintain their precision throughout the application layer while still being stored as the appropriate database type. The OData extension will properly handle `int64'9223372036854775807'` literals without precision loss when the property is defined as a string with the proper format specification.

### Key normalization

Incoming URLs are normalized by a path-rewriter middleware so `/odata/Products(42)` becomes `/odata/Products/42` before routing. Key expressions are parsed strictly, escaped (including quotes and GUID prefixes), and capped at 4 KB; malformed or oversized segments are left untouched, which means the request proceeds with the original path and the framework responds with the usual 404/400.

Enable inline counts by passing `$count=true` alongside other query options:

```http
GET /odata/Products?$filter=price gt 500&$count=true
```

Response:

```json
{
  "@odata.context": "/odata/$metadata#Products",
  "@odata.count": 12,
  "value": [{ "id": 1, "name": "Laptop", "price": 1299 }]
}
```

To fetch the count only, call the dedicated path:

```http
GET /odata/Products/$count
```

The endpoint responds with a plain number and honours `$filter` (and other supported query options) to scope the count.

Batch multiple operations with a single round-trip using the `$batch` endpoint:

```http
POST /odata/$batch
Content-Type: application/json

{
  "requests": [
    {"id": "1", "method": "GET", "url": "/odata/Products?$top=1"},
    {"id": "2", "method": "GET", "url": "/odata/Products/$count"},
    {
      "id": "3",
      "atomicityGroup": "changeset-1",
      "method": "POST",
      "url": "/odata/Products",
      "body": {"name": "Tablet", "price": 499}
    }
  ]
}
```

Responses preserve request order; operations that share `atomicityGroup` succeed or fail together:

```json
{
  "responses": [
    { "id": "1", "status": 200, "body": { "value": [{ "id": 1, "name": "Laptop" }] } },
    { "id": "2", "status": 200, "body": { "value": [] } },
    { "atomicityGroup": "changeset-1", "id": "3", "status": 201, "body": { "value": { "id": 4 } } }
  ]
}
```

### Actions & Functions

You can publish custom OData operations on top of the generated CRUD surface by decorating controller methods. The OData booter discovers them at startup, wires REST routes automatically, and emits `<Action>` / `<Function>` entries in `$metadata` so OData clients can discover them.

`@odataAction()` and `@odataFunction()` accept the same options:

- `name` overrides the exported operation name (defaults to the method name).
- `binding` selects the scope: `entity` (default), `collection`, or `unbound`.
- `params` describes parameters for `$metadata` (each entry has `name` and optional `type`).
- `returnType` sets the CSDL return type hint. It can be an EDM string (`'Edm.Guid'`, `'Collection(Edm.String)'`, etc.), a LoopBack model constructor/factory (`DecisionPermissionConfig` or `() => DecisionPermissionConfig`), or `collectionOf(...)` for `Collection(...)` return types. Functions default to `Edm.String` when omitted.
- `rawResponse` skips the default OData annotations (like `@odata.context`/`@odata.etag`) so you can return a bespoke payload.

`params[].type` and `returnType` accept either a literal EDM string (`'Edm.Guid'`, `'Collection(Edm.String)'`, etc.) or a LoopBack model constructor (pass the class or a factory such as `() => DecisionInput`). When you reference a model, the generator emits the referenced complex type in `$metadata`, so clients can discover the schema of your payload/return type without adding dummy properties to entities. Runtime requests are validated against the model definition, so unknown properties trigger `400 Bad Request` before your controller runs.

At runtime the framework resolves method arguments this way:

- Entity-bound operations receive the entity key as the first argument and then the JSON body (actions) or query object (functions).
- Collection-bound operations receive only the body/query object.
- Unbound operations are mounted at `/odata/<OperationName>` and never receive an entity id.

| Binding      | HTTP verb | Route example                         | Notes                                                        |
| ------------ | --------- | ------------------------------------- | ------------------------------------------------------------ |
| `entity`     | POST/GET  | `POST /odata/Products(1)/discount`    | Actions expect a JSON body; functions read the query string. |
| `collection` | POST/GET  | `GET /odata/Products/premiumProducts` | Operates on the entire set.                                  |
| `unbound`    | POST/GET  | `POST /odata/resetInventory`          | No entity segment; useful for cross-cutting jobs.            |

Decorated methods still run through the standard LoopBack interceptors and middleware pipeline. The generated CSDL includes bound parameters and return types so metadata-driven tooling (e.g. Power BI, SAP UI5) can discover the operations automatically.

#### Example: entity action & collection function

Define custom actions and functions with decorators:

```ts
@odataController(Product)
class ProductController {
  constructor(@repository(ProductRepository) private products: ProductRepository) {}

  @odataAction({ binding: 'entity' })
  async discount(id: number, body: { percent: number }) {
    const entity = await this.products.findById(id);
    const percent = Number(body?.percent ?? 0);
    await this.products.updateById(id, {
      price: Number(entity.price ?? 0) * (1 - percent / 100),
    });
    return this.products.findById(id);
  }

  @odataFunction({ binding: 'collection' })
  async premiumProducts(query: { minPrice?: string }) {
    const minPrice = Number(query?.minPrice ?? 1_000);
    return this.products.find({ where: { price: { gte: minPrice } } });
  }
}
```

- Actions map to `POST /odata/Products({id})/discount` (body contains parameters) and registered routes respect the usual LoopBack interceptors/middleware.
- Functions map to `GET /odata/Products/premiumProducts?minPrice=1000` and return a collection via GET. Canonical OData invocation is also accepted: `GET /odata/Products/premiumProducts(minPrice=1000)` (and the namespace-qualified form `GET /odata/Products/Default.premiumProducts(minPrice=1000)`).
- Set `rawResponse: true` in the decorator if you want to return a custom payload instead of the standard OData-formatted entity.
- Decorated operations are listed automatically in `$metadata` (CSDL) as bound/unbound actions and functions.

#### Complex return types

Use a model constructor/factory to generate ComplexType metadata for operation return values. For collections, wrap the type with `collectionOf(...)` (or use a literal `Collection(...)` CSDL string):

```ts
import { odataFunction, collectionOf } from '@urartian/loopback4-odata';
import { DecisionPermissionConfig } from '../models/decision-permission-config.model';

@odataFunction({
  name: 'readDecisionPermissionConfig',
  binding: 'unbound',
  returnType: () => DecisionPermissionConfig,
})
async readDecisionPermissionConfig() {
  return { id: '1', name: 'example' };
}

@odataFunction({
  name: 'listDecisionPermissionConfigs',
  binding: 'unbound',
  returnType: collectionOf(() => DecisionPermissionConfig),
})
async listDecisionPermissionConfigs() {
  return [{ id: '1', name: 'example' }];
}
```

### Controller Hooks & Overrides

Declare OData hooks right inside your LB4 controller using `@odata.before`, `@odata.after`, and `@odata.on`. These attach to the generated CRUD routes for your model and let you implement `before/after` logic or fully override an operation.

Import from the package root:

```ts
import { odata, CrudHookContext, CrudOnContext } from '@urartian/loopback4-odata';
```

Supported operations and scopes:

- Operations: `READ`, `CREATE`, `UPDATE`, `DELETE`, `LINK_NAVIGATION`, `UNLINK_NAVIGATION`
- Scopes for `READ`: `collection`, `entity`, `count`

Decorators accept a single operation, an array of operations, or `'*'` to run on every CRUD action. Arrays behave exactly like stacking individual decorators, so `@odata.before(['CREATE', 'UPDATE'])` is equivalent to declaring both `@odata.before('CREATE')` and `@odata.before('UPDATE')`. Passing `'*'` expands to all CRUD verbs (`READ`, `CREATE`, `UPDATE`, `DELETE`, `LINK_NAVIGATION`, `UNLINK_NAVIGATION`). When multiple operations are expanded, the hook scope is preserved only for the entries whose resolved operation is `READ`.

Example usage:

```ts
@odataController(Product)
export class ProductODataController {
  constructor(@repository(ProductRepository) private products: ProductRepository) {}

  // Validate and normalize payload before create
  @odata.before('CREATE')
  ensureName(ctx: CrudHookContext) {
    const body = ctx.payload as any;
    if (!body?.name) throw new HttpErrors.BadRequest('name is required');
    body.name = String(body.name).trim();
  }

  // Enforce default ordering on list
  @odata.before('READ', 'collection')
  defaultOrder(ctx: CrudHookContext) {
    ctx.filter = ctx.filter ?? {};
    if (!ctx.filter.order) ctx.filter.order = ['updatedAt DESC'];
  }

  // Redact a field when returning a single entity
  @odata.after('READ', 'entity')
  redact(ctx: CrudHookContext) {
    const entity = ctx.result as any;
    if (entity) delete entity.secret;
  }

  // Override UPDATE. Call next() to delegate to default CRUD logic,
  // or skip next() to fully replace the implementation.
  @odata.on('UPDATE')
  async customUpdate(ctx: CrudOnContext, next: () => Promise<any>) {
    if ((ctx.payload as any)?.blocked) {
      throw new HttpErrors.Forbidden('Blocked field');
    }
    // Augment default logic
    return next();
  }

  // Fully custom collection read using helpers
  @odata.on('READ', 'collection')
  async customList(ctx: CrudOnContext, next: () => Promise<any>) {
    if (!ctx.request.query['featured']) return next();
    const items = await this.products.find({ where: { featured: true } }, ctx.options);
    return ctx.helpers.collection(items);
  }

  // Reuse one hook across multiple write operations
  @odata.before(['CREATE', 'UPDATE'])
  stampWrites(ctx: CrudHookContext) {
    ctx.state.lastWriteOp = ctx.operation;
  }

  // Run after hook on every operation
  @odata.after('*')
  auditAll(ctx: CrudHookContext) {
    console.log('completed', ctx.operation);
  }
}
```

Notes:

- `before → on → after` is the execution order.
- `@odata.before` is the place for validation, authorization checks, or enriching/mutating incoming payload/filter data before the generated CRUD logic runs.
- `@odata.on` lets you replace or wrap the default CRUD handler, e.g., to call external REST APIs, implement custom persistence, or add business logic before delegating via `next()`.
- `@odata.after` is ideal for post-processing responses, emitting audit logs, or firing side effects/events after a successful CRUD call but before the response is sent.
- Scopes exist solely to split the single `READ` operation into its three variants (`collection`, `entity`, `$count`). Non-read operations have no notion of scope, so the argument is ignored once a decorator entry resolves to `CREATE`, `UPDATE`, `DELETE`, `LINK_NAVIGATION`, or `UNLINK_NAVIGATION`. For example, `@odata.before(['READ', 'UPDATE'], 'collection')` runs on collection reads and on every update.
- `@odata.on` can replace the generated logic by not calling `next()`. Use `ctx.helpers.entity`, `ctx.helpers.collection`, `ctx.helpers.count`, or `ctx.helpers.noContent` to produce OData-correct responses when you override.
- Hooks receive `CrudHookContext` with `request`, `response`, `repository`, `options` (including active transactions for `$batch`), `payload/filter/id`, and a mutable `state` bag for passing data between phases.
- Only one `@odata.on` is allowed per operation/scope per controller; duplicates fail at boot.
- Navigation reference routes trigger the dedicated operations `LINK_NAVIGATION` (for `POST/PUT .../$ref`) and `UNLINK_NAVIGATION` (for `DELETE .../$ref`). The hook context includes `relationName`, `navigationTargetId`, `navigationTargetKey`, plus `navigationRelationRepository` / `navigationTargetRepository` so you can enforce custom linking rules.

```ts
@odata.before('LINK_NAVIGATION')
blockDuplicateLinks(ctx: CrudHookContext) {
  if (ctx.relationName !== 'items') return;
  const header = ctx.request.get('x-block-link');
  if (header?.toLowerCase() === 'true') {
    throw new HttpErrors.Conflict('Link prevented by business rules.');
  }
}

@odata.on('UNLINK_NAVIGATION')
async auditUnlink(ctx: CrudOnContext, next: () => Promise<unknown>) {
  await next();
  console.log('Unlinked', ctx.navigationTargetId, 'from order', ctx.id);
}
```

#### Example: unbound action with a raw response

```ts
@odataAction({
  name: 'resetInventoryRaw',
  binding: 'unbound',
  params: [{ name: 'confirm', type: 'Edm.Boolean' }],
  rawResponse: true,
})
async resetInventoryRaw(body: { confirm?: boolean }) {
  if (!body?.confirm) {
    throw new HttpErrors.BadRequest('Pass {"confirm": true} to reset inventory');
  }
  await this.products.updateAll({ quantityOnHand: 0 });
  return { status: 'ok' };
}
```

This action is exposed as `POST /odata/resetInventoryRaw`, surfaces in `$metadata` as an unbound action, and because `rawResponse` is set, the controller controls the full payload. The sample application also includes a `resetInventory` action without `rawResponse` to illustrate the default OData envelope (payload returned under `value` with `@odata.context`).

#### Example: virtual/computed properties

LoopBack models can advertise computed fields by marking them as non-persistent. The extension will list the field in `$metadata`, but you are responsible for calculating it at runtime and ignoring any client-supplied values.

```ts
// order.model.ts
import { Entity, property } from '@loopback/repository';
import { odataModel } from '@urartian/loopback4-odata';

@odataModel({ entitySetName: 'Orders' })
export class Order extends Entity {
  @property({ id: true })
  id: string;

  @property({ type: 'number', required: true })
  amount: number;

  @property({ type: 'string', required: true })
  currency: string;

  @property({ type: 'number', persist: false, jsonSchema: { readOnly: true } })
  totalWithTax?: number;
}
```

```ts
// order.odata-controller.ts
import { AnyObject, repository } from '@loopback/repository';
import { odata, CrudHookContext } from '@urartian/loopback4-odata';
import { Order } from './order.model';
import { OrderRepository } from './order.repository';

const addTotal = (entity: AnyObject) => {
  const rate = entity.currency === 'EUR' ? 0.19 : 0.07;
  const amount = Number(entity.amount ?? 0);
  entity.totalWithTax = Number.isFinite(amount) ? +(amount * (1 + rate)).toFixed(2) : undefined;
  return entity;
};

@odataController(Order)
export class OrderODataController {
  constructor(@repository(OrderRepository) private readonly orders: OrderRepository) {}

  @odata.before('CREATE')
  @odata.before('UPDATE')
  stripVirtual(ctx: CrudHookContext) {
    if (ctx.payload) delete (ctx.payload as AnyObject).totalWithTax;
  }

  @odata.after('READ', 'entity')
  addVirtualToEntity(ctx: CrudHookContext) {
    const entity = ctx.result as AnyObject | undefined;
    if (entity) addTotal(entity);
  }

  @odata.after('READ', 'collection')
  addVirtualToCollection(ctx: CrudHookContext) {
    const payload = ctx.result as { value?: AnyObject[] };
    if (!payload?.value) return;
    payload.value = payload.value.map((item) => addTotal(item));
  }
}
```

Key points:

- Declare the field on the model with `persist: false` so it is not stored in the datasource but still appears in `$metadata`.
- Use `@odata.before` hooks to strip the field from incoming payloads.
- Populate the computed value in an `@odata.after` hook (or `@odata.on` override) before the response is sent.

### Using `$batch`

Send a JSON payload containing `requests`. When multiple entries share the same `atomicityGroup`, LoopBack executes them as a changeset and either commits or rolls everything back.

```http
POST /odata/$batch
Content-Type: application/json

{
  "requests": [
    {
      "id": "create",
      "method": "POST",
      "url": "/odata/Products",
      "body": {"name": "Tablet", "price": 599},
      "atomicityGroup": "g1"
    },
    {
      "id": "update",
      "method": "PATCH",
      "url": "/odata/Products(1)",
      "body": {"price": 1499},
      "atomicityGroup": "g1"
    }
  ]
}
```

If the datasource behind the repositories cannot create transactions (for example, the in-memory connector), the OData component returns `501 Not Implemented` with a `BatchExecutionError` explaining that the changeset could not be guaranteed. Use a transactional connector or omit `atomicityGroup` to execute requests independently.

The `$batch` parser enforces guardrails derived from `config.batch`: payload size (`maxPayloadBytes`, default 16 MB), total operations (`maxOperations`, default 100), operations per changeset (`maxChangesetOperations`, default 50), nesting depth (`maxDepth`, default 2 levels), and per-part payload size (`maxPartBodyBytes`, default 4 MB). Requests that exceed these limits short-circuit with `413 Payload Too Large` (for size breaches) or `400 Bad Request` (for operation limits), and the controller logs a structured warning so you can correlate rejections with client traffic. Tune the limits to match your back-end capacity—anything outside the allowed envelope is rejected before the atomic handlers run.

## Optimistic Concurrency (ETags)

Add an ETag column to your LoopBack model and opt in by passing it to `@odataModel`. The property is typically a timestamp or version counter that you update whenever the record changes.

```ts
@odataModel({ etag: 'updatedAt' })
export class Product extends Entity {
  @property({ id: true })
  id!: number;

  @property()
  name!: string;

  @property()
  price!: number;

  @property({ type: 'date', required: true, defaultFn: 'now' })
  updatedAt!: Date;
}
```

Keep the field fresh in your repository (for example, by stamping `updatedAt` in `create`/`update` hooks). The generated CRUD controller then:

- Emits `ETag: W/"…"` headers and `@odata.etag` payload metadata on `GET /odata/Products(…)`.
- Accepts optional `If-Match` headers on `PATCH`/`DELETE`. When present, the update succeeds only if the token still matches the stored value; stale tokens return `412 Precondition Failed`.
- Supports caching via `If-None-Match` on reads (`GET` responds `304 Not Modified` when the token matches).
- The ETag covers only the root entity unless you choose to update the parent token whenever child rows change.

You can pass an array of property names (`@odataModel({etag: ['id', 'updatedAt']})`) to build a composite token; the header value becomes a key/value list such as `W/"id=42&updatedAt=2025-04-01T10%3A00%3A00.000Z"`.

## Testing

Run `npm test` to compile the TypeScript specs and execute the unit suite. Acceptance specs leverage `@loopback/testlab` and will be skipped automatically in environments that disallow binding HTTP ports (for example, certain sandboxes). When running locally, the acceptance suite exercises the generated REST endpoints against a seeded in-memory datasource.

## Features

- [x] OData-style entity paths (Products(1), Orders(OrderID=10248,CustomerID='ALFKI')) supported via middleware with compound and quoted key support
- [x] Auto-discovery of OData controllers (Booter)
- [x] Registry of entity sets
- [x] CRUD controller factory backed by LoopBack repositories
- [x] Service document exposing registered entity sets
- [x] $metadata endpoint with generated CSDL (including navigation properties for relations)
- [x] Basic query options → LoopBack filters (`$filter`, `$orderby`, `$top`, `$skip`, `$select`)
- [x] Extended filter support: `not`, numeric functions (`round`, `floor`, `ceiling`), date extraction (`year`), string helpers (`trim`, `concat`), date parts (`month`, `day`, `hour`, `minute`, `second`) with strict-mode guards when unsupported, and `$search` across string fields
- [x] any/all (lambdas): support `<nav>/(any|all)(x: <expr>)` (including multi-segment paths), `not <lambda>` rewrite, nested lambdas (depth capped), and combining lambdas with other predicates using boolean trees (including top-level `or`)
- [x] Relational expansion via `$expand`
- [x] Inline and standalone `$count`
- [x] `$batch` endpoint (JSON and multipart/mixed)
- Transactions are attempted for changesets (`atomicityGroup`). The component now caches whether each entity set's datasource can open LoopBack transactions: transactional connectors such as PostgreSQL succeed, while the in-memory connector is marked as non-transactional the first time a client attempts an atomicity group. Once a datasource is confirmed non-transactional the controller refuses future atomicity groups touching that entity set without instantiating its repository. When a datasource lacks transactions the affected changeset is rejected up front with `501 Not Implemented` and a `BatchExecutionError`; omit `atomicityGroup` to accept best-effort processing or switch to a transactional connector for true atomicity. `$metadata` surfaces the service-wide capability via the EntityContainer annotation `Org.OData.Capabilities.V1.BatchSupported/ChangeSetsSupported` (set to `true` only when every registered entity set is backed by a transactional datasource) and per-entity-set hints via `LoopBack.V1.BatchCapabilities.ChangeSetsSupported`, so clients can decide whether to emit change sets globally or only for specific entity sets.
- [x] Honors `Prefer: return=minimal|representation` for write operations and emits `OData-Version`/`Preference-Applied` headers by default
- [x] OData-compliant error payloads (`odata.error`) with 501 `PreferenceNotSupported` for unsupported preferences like `respond-async`
- [x] Actions & Functions decorators with auto CSDL generation
- [x] Proper pluralization of entity sets (via inflection)
- [x] Transaction-backed `$batch` changesets (when datasource supports transactions)
- [x] Optimistic concurrency with OData ETags (`If-Match` / `If-None-Match` support on generated CRUD routes)
- [x] `$batch` execution runs through the LoopBack pipeline so interceptors/auth apply; changesets use per-datasource transactions and commit/rollback as a unit
- [x] Configurable base path (`basePath`), `$top` limit (`maxTop`), `$count` toggle (`enableCount`), and guardrails for `$skip`/`$expand` via config
- [x] Opt-in `$search` with boolean operators (AND/OR/NOT), quoted phrases, per-field configuration, and guardrails
- [x] Configurable CSDL namespace/container names and JSON CSDL output with enriched primitive facets
- [x] Complex types, enum types, and referential constraints reflected in generated CSDL (XML & JSON)
- [x] Capabilities annotations (filter functions/restrictions, count/navigation restrictions, permissions, streams, insert/update/delete/search restrictions) to describe service behaviors to OData clients
- [x] Derived LoopBack models surface `$BaseType` so inheritance is reflected in the generated CSDL
- [x] Deep insert support for `hasOne`/`hasMany` relations (opt-in per entity set, multi-level traversal)
- [x] Navigation `$ref` endpoints for `hasOne`/`hasMany` relations (link/unlink existing entities)
- [x] OpenAPI visibility controls via per-model `documentInOpenApi` flags and global policies (`documentInOpenApiDefault`, `removeUndocumentedFromSpec`)
- [x] Media streams via `$value` routes for `HasStream` entity sets (property-backed binary fields or custom repository adapters)
- [x] Structured telemetry with request logging, apply/rewrite diagnostics, hook traces, and correlation IDs (opt-in via config)

Queries can now combine boolean operators and phrases:

```http
GET /odata/Products?$search="coffee beans" AND grinder NOT decaf
```

The example above matches products that include the phrase "coffee beans", also mention "grinder", and omit anything containing "decaf".

String helpers such as `trim`/`concat` and date part functions (`month`, `day`, `hour`, `minute`, `second`) are processed automatically when `strict=false`. In strict mode they are accepted only when the server can guarantee correct execution (for example via Postgres pushdown); otherwise they return `400 Bad Request`.

## Configuration

Customize the OData component via `ODataConfig` bound at `odata.config` (the component registers a default). You can override it in your application before boot:

```ts
import { ODATA_BINDINGS } from '@urartian/loopback4-odata';
import { ODataConfig } from '@urartian/loopback4-odata';

// inside your app setup
this.bind(ODATA_BINDINGS.CONFIG).to({
  basePath: '/api/odata', // default: '/odata'; use '/' to expose OData at the app root
  csdlFormat: 'xml', // 'xml' | 'json' (default 'xml')
  namespace: 'Catalog', // default: 'Default'
  entityContainerName: 'CatalogService', // default: 'DefaultContainer'
  namespaceAlias: 'CatalogNS',
  tokenSecret: process.env.ODATA_TOKEN_SECRET!, // required for signed paging/delta tokens (auto-generated per boot outside production when omitted)
  capabilities: {
    filterFunctions: ['contains', 'startswith', 'endswith'],
    countable: true,
    aggregation: true,
  },
  pagination: {
    maxTop: 100, // server paging cap
    maxSkip: 1000, // max skip allowed
    maxPageSize: 50, // server-driven paging guardrail
    maxApplyPageSize: 100, // guardrail for $apply pipelines
  },
  pageSize: 50, // default server-driven paging size (default: 200)
  maxExpandDepth: 2, // max $expand nesting depth
  enableCount: true, // enable inline and standalone $count
  strict: true, // enable strict validations (default: true)
  enableDelta: true, // emit $deltatoken links for incremental syncs
  batch: {
    maxPayloadBytes: 16 * 1024 * 1024, // total request size limit
    maxOperations: 100, // total requests allowed per batch
    maxChangesetOperations: 50, // per-changeset limit
    maxPartBodyBytes: 4 * 1024 * 1024, // individual part payload limit
    maxResponseBodyBytes: 4 * 1024 * 1024, // per-sub-response buffering limit
    maxResponsePayloadBytes: 32 * 1024 * 1024, // aggregate buffered + serialized response limit
    allowedSubRequestHeaders: ['if-match', 'prefer'], // optional extra headers sub-requests may override
    subRequestTimeoutMs: 30_000, // abort sub-requests that exceed this duration
  },
  writeTransactions: {
    enabled: true, // wrap non-$batch writes in a datasource transaction when supported
    rejectMultiDataSource: true, // default: true (reject writes spanning multiple datasources)
  },
  onLog(entry) {
    myTelemetryClient.trackEvent({
      name: 'odata-log',
      properties: {
        level: entry.level,
        message: entry.message,
        ...entry.context,
      },
    });
  },
} as ODataConfig);
```

When `basePath` is set to `'/'`, the public OData service is rooted at `/` instead of `/odata`: the service document is served from `/`, metadata from `/$metadata`, and entity sets from paths such as `/Products`. Only registered OData routes are claimed there, so unrelated application routes like `/health` or `/openapi.json` continue to behave normally.

### Capabilities presets (FilterFunctions)

The service advertises supported `$filter` functions in `$metadata` via `Org.OData.Capabilities.V1.FilterFunctions`. To keep this aligned with the library’s implementation without maintaining long arrays, you can use a preset (no runtime connector auto-detection):

- `filterFunctionsPreset: 'default'`: legacy/minimal set (matches previous default behavior)
- `filterFunctionsPreset: 'postgres'`: Postgres-ready set aligned with implemented pushdowns (includes `trim`, `concat`, `month`, etc.)

```ts
import { ODATA_BINDINGS, ODataConfig, FILTER_FUNCTIONS_POSTGRES } from '@urartian/loopback4-odata';

const currentConfig = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...currentConfig,
  capabilities: {
    ...currentConfig.capabilities,
    filterFunctionsPreset: 'postgres',
  },
} satisfies ODataConfig);

// or explicitly:
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...currentConfig,
  capabilities: {
    ...currentConfig.capabilities,
    filterFunctions: FILTER_FUNCTIONS_POSTGRES,
  },
} satisfies ODataConfig);
```

> **Notes:** `FilterFunctions` only advertises `$filter` functions. Operators like `in (...)` are not represented there. Presets and lists are normalized (trimmed, lowercased, de-duplicated).

### `$filter` not implemented (yet)

This library focuses on a predictable subset of `$filter` that can be enforced in `strict=true` and pushed down efficiently on Postgres. If a client sends anything outside this subset, behavior is:

- `strict=true`: rejected with `400 Bad Request`
- `strict=false`: may still be rejected (or bounded post-filtered) depending on whether the expression can be evaluated safely

### Supported `$filter` summary

At a high level, the server supports:

- Boolean logic: nested `and` / `or` / `not` with parentheses
- Comparisons: `eq`/`ne`/`gt`/`ge`/`lt`/`le`, including `null`/`true`/`false`
- Typed literals + model-aware coercion: `guid'...'`, `date'...'`, `datetimeoffset'...'`, `int64'...'` (and `123L`), `decimal'...'`
- `in (...)`: parsed as `inq` with `capabilities.filter.maxInListItems` guardrail (null-safe)
- String filtering: `contains`/`startswith`/`endswith`, and direct `tolower(...)`/`toupper(...)` comparisons (plus Postgres pushdown for supported patterns)
- Date parts: `month/day/hour/minute/second` comparisons (Postgres pushdown)
- Navigation paths:
  - To-one chains (`belongsTo`/`hasOne`) ending in primitive fields are supported (Postgres pushdown when available; bounded fallback otherwise)
  - To-many navigation filters are supported only via lambdas (`any`/`all`)
- Lambdas (`any`/`all`): nested (depth capped), top-level `or` support, Postgres pushdown when enabled, and bounded fallback when pushdown declines

For the exact set of supported `$filter` functions, rely on `$metadata` (`Org.OData.Capabilities.V1.FilterFunctions`) or the `filterFunctionsPreset` presets (`default` / `postgres`).

### `$filter` examples

Basic comparisons:

```http
GET /odata/Products?$filter=price ge 100 and active eq true
```

Typed literals (model-aware coercion):

```http
GET /odata/Orders?$filter=customerId eq guid'01234567-89ab-cdef-0123-456789abcdef'
GET /odata/Orders?$filter=createdAt ge datetimeoffset'2026-01-03T10:20:30Z'
```

`in (...)` (null-safe; subject to `filter.maxInListItems`):

```http
GET /odata/Products?$filter=status in ('Open','Closed',null)
```

String filtering:

```http
GET /odata/Products?$filter=contains(name,'lap')
GET /odata/Products?$filter=tolower(name) eq 'laptop'
```

To-one navigation path filters (Postgres pushdown when available; otherwise bounded fallback):

```http
GET /odata/Orders?$filter=customer/name eq 'Alice'&$top=50
```

To-many navigation filters via lambdas:

```http
GET /odata/Orders?$filter=items/any(i: i/quantity gt 0)
GET /odata/Orders?$filter=items/all(i: i/cancelled eq false)
```

Notable `$filter` features that are currently **not** implemented:

- Type functions: `cast(...)`, `isof(...)`
- String functions: `replace(...)` (and most other string functions beyond what `$metadata` advertises)
- Arithmetic expressions/operators in `$filter` (`add`, `sub`, `mul`, `div`, `mod`)
- Spatial/geo functions (all `geo.*` and geography/geometry operators)
- Enum flag operator `has`
- Deep function composition (e.g. `replace(tolower(name), 'a', 'b') eq '...'`)
- To-many navigation path filters outside lambdas (e.g. `items/quantity gt 0`); only lambda forms like `items/any(i: i/quantity gt 0)` are supported

### Capabilities defaults (FilterRestrictions)

The service also emits `Org.OData.Capabilities.V1.FilterRestrictions` per entity set. By default, it marks any **to-many** navigation properties (`hasMany` / `hasManyThrough`) as non-filterable (since the server rejects to-many navigation filters outside lambdas).

You can add additional hints (or override booleans) via config:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...currentConfig,
  capabilities: {
    ...currentConfig.capabilities,
    filterRestrictions: {
      requiresFilter: false,
      nonFilterableProperties: ['internalFlag'],
    },
  },
} satisfies ODataConfig);
```

For mixed datasources (or per-entity differences), prefer per-entity-set overrides:

```ts
import { FILTER_FUNCTIONS_POSTGRES, type ODataEntitySetConfig } from '@urartian/loopback4-odata';

export const PurchasesSet: ODataEntitySetConfig = {
  name: 'Purchases',
  modelCtor: Purchase,
  capabilities: { filterFunctions: FILTER_FUNCTIONS_POSTGRES },
};
```

> **Important:** `capabilities` is a nested object. Flags such as `aggregation`, `applySupported`, or `filterFunctions` belong under `config.capabilities`. If you bind a brand-new config object without copying the defaults registered by `ODataComponent`, those flags disappear and features like `$apply` aggregations are reported as not implemented. Prefer `this.getSync(ODATA_BINDINGS.CONFIG)` and spread the existing value before applying overrides.

```ts
const currentConfig = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;

this.bind(ODATA_BINDINGS.CONFIG).to({
  ...currentConfig,
  maxTop: 100,
  enableDeepInsert: true,
  capabilities: {
    ...currentConfig.capabilities,
    aggregation: true,
    applySupported: true,
    filterFunctions: ['contains', 'startswith', 'endswith'],
  },
} satisfies ODataConfig);
```

Spreading the current config ensures sensitive settings such as `tokenSecret` remain intact unless you explicitly replace them.

Per-entity guardrails can be applied through the entity-set config you register with the registry binding. Entity-level limits override the global pagination block, allowing you to relax or tighten caps on a per-feed basis:

```ts
import { type ODataEntitySetConfig } from '@urartian/loopback4-odata';

const ProductsSet: ODataEntitySetConfig<Product> = {
  name: 'Products',
  modelCtor: Product,
  repositoryBindingKey: 'repositories.ProductRepository',
  pagination: {
    maxTop: 500,
    maxPageSize: 250,
    maxApplyPageSize: 100,
  },
};
```

> **Validation:** Guardrail values must be positive integers. Invalid settings (for example, `pagination.maxPageSize: 0` or `skipTokenTtl: -5`) cause startup to fail fast so configuration issues surface immediately.

- `basePath`: Externally visible service root. OData routes are served under this path (via middleware rewrite) while internal routes remain at `/odata`. Response metadata (`@odata.context`) and published OpenAPI OData paths use this value. When set to `'/'`, the public OData routes move to the app root (`/`, `/$metadata`, `/$batch`, `/Products`, ...) but unrelated non-OData routes are not rewritten.
- `trustProxyHeaders`: Controls whether `Forwarded` / `X-Forwarded-*` headers participate in host/protocol detection. Set to `true` to always trust them, or `false`/omitted to ignore them entirely (this now ignores Express' global `trust proxy` flag so the OData component cannot be opted-in accidentally). When disabled, the controller only considers the immediate request's `Host` and `protocol` values, preventing spoofed headers from bypassing origin scoping.
- `trustedProxySubnets`: CIDR/IP allow-list (`string[]`) describing which reverse proxies are allowed to supply `Forwarded` / `X-Forwarded-*` headers (for example `['10.0.0.0/8', '2001:db8::/32']`). Defaults to `[]`, meaning proxy headers are ignored unless `trustProxyHeaders === true`. When populated, the controller only honors proxy headers if the remote address matches a configured subnet, so direct-to-app attackers cannot spoof origins even when the app runs behind ingress.
- `pagination.maxTop`: Caps `$top` for collection reads. When `strict=true` requests above the cap return `400 Bad Request`; otherwise the server clamps the value. Legacy `config.maxTop` is still honored but the nested value takes precedence.
- `pagination.maxSkip`: Maximum allowed `$skip`. Requests above the cap are clamped when `strict=false` and rejected when `strict=true`. Legacy `config.maxSkip` remains available for backward compatibility.
- `pagination.maxPageSize`: Upper bound for server-driven paging on collection endpoints. The service never emits more than this many entities in a single page even when clients omit `$top`.
- `pagination.maxApplyPageSize`: Upper bound for server-driven paging when executing `$apply` pipelines. When unset, it falls back to `maxPageSize`.
- `pageSize`: Default number of records per page for server-driven paging. The service always returns at most this many entities and emits an `@odata.nextLink` with a signed `$skiptoken` so clients can resume the feed. Automatically clamped to the configured pagination guardrails.
- `appendKeysForClientPaging`: When `true` (default) the controller appends the entity key columns to client-supplied `$orderby` clauses whenever requests use manual `$skip`. This keeps offset-based paging stable for frameworks that ignore `@odata.nextLink` (for example, SAPUI5 growing tables). Set to `false` only if you need the backend to preserve the original order verbatim even at the cost of potential duplicates across pages.
- **Manual paging:** Supplying both `$skip` (even `0`) _and_ a positive `$top` switches the request into client-driven paging. In that mode the backend clamps `$top` to the configured page size, appends key columns for deterministic ordering, and suppresses `@odata.nextLink`. Clients must increment `$skip` themselves to fetch more rows. If `$skip` is sent without `$top`, the controller sticks with server-driven paging and still emits `@odata.nextLink`.
- `enableDelta`: When `true`, collection responses include `@odata.deltaLink` so clients can poll only the rows that changed since the last snapshot.
- `tokenSecret`: Required secret used to sign `$skiptoken` / `$deltatoken` payloads. When `NODE_ENV` or `ODATA_ENV` is `production`, `ODATA_TOKEN_SECRET` **must** be set or the app refuses to boot. In non-production environments the component auto-generates a per-boot random secret if none is provided and logs an INFO message; pagination/delta links expire on every restart until you set `ODATA_TOKEN_SECRET` yourself (for example `export ODATA_TOKEN_SECRET=$(openssl rand -hex 32)`).
- `skipTokenTtl`: Lifetime (in seconds) for issued `$skiptoken` links. Defaults to `900` (15 minutes). Expired tokens return `400 Invalid $skiptoken`.
- `deltaTokenTtl`: Optional lifetime (seconds) for `$deltatoken` links. When omitted, delta tokens remain valid until you rotate the secret or prune their backing store.
- `allowLegacyUnsignedTokens`: Set to `true` only while migrating from the unsigned (v1/v2) token format. New deployments should leave this `false` to reject tampered tokens outright.
- `batch`: Guardrails for `$batch` requests. Provide `maxPayloadBytes` (default `16 MB`), `maxOperations` (100 operations), `maxChangesetOperations` (50 per changeset), `maxPartBodyBytes` (4 MB), `maxResponseBodyBytes` (4 MB per sub-response), `maxResponsePayloadBytes` (32 MB aggregate), and `maxDepth` (2 levels) to cap payload size, total operations, changeset nesting, and the amount of memory each buffered/serialized response may consume.
- `$batch` sub-requests automatically reuse the caller's headers and security context. Only a safe allow-list (content negotiation, conditional headers, `Prefer`, etc.) may be overridden inside the payload; extend it via `batch.allowedSubRequestHeaders` if you need extra opt-in headers.
- `batch.subRequestTimeoutMs` aborts individual sub-requests that exceed the configured duration (default 30 seconds), ensuring long-running handlers are cancelled and their transactions rolled back instead of continuing in the background.
- Sub-responses that exceed `maxResponseBodyBytes` are aborted in-process and return `413 ResponseTooLarge` so a single oversized entry cannot exhaust server memory even when the handler streams a large binary payload.
- When the combined buffered responses and the serialized JSON/multipart payload would exceed `maxResponsePayloadBytes`, the controller rejects the entire batch with `413 Payload Too Large` before serialization begins, preventing attackers from flooding the process with many near-limit responses in a single request.
- `$batch` limits are enforced while parsing the stream: once the cumulative payload or a single part exceeds the configured budget the server aborts immediately with `413 Payload Too Large`.
- `$batch` atomicity detection is connector-aware: entity sets backed by datasources that expose `beginTransaction` (for example PostgreSQL) are marked as transactional after the first successful changeset, while datasources without transactions (such as the in-memory connector) are marked as non-transactional and future atomicity groups targeting them are rejected immediately with `501 Not Implemented`. The generated CSDL advertises the service-wide capability (per spec) on the EntityContainer via `Org.OData.Capabilities.V1.BatchSupported/ChangeSetsSupported`, which flips to `true` only when every registered entity set is backed by a transactional datasource, and emits per-entity-set annotations under `LoopBack.V1.BatchCapabilities.ChangeSetsSupported` so tools can decide which entity sets allow change sets.
- `writeTransactions`: When enabled, non-`$batch` write requests (create/update/delete, deep insert/update, `$ref` link/unlink, `$value` media metadata updates) run inside a datasource transaction when the connector supports `beginTransaction` (recommended for PostgreSQL). Writes spanning multiple datasources are rejected by default (`rejectMultiDataSource: true`). External media stores (e.g., S3) remain best-effort side effects; the database transaction only covers repository writes.
- `onDeltaTokenInvalid(event)`: Optional callback fired whenever a client supplies an expired, tampered, or mismatched `$deltatoken`. Useful for alerting/telemetry when secrets rotate.
- `tenantResolver(request)`: Function that extracts a tenant/customer identifier from an incoming request (for example `req.user?.tenantId` or `req.get('x-tenant-id')`). When combined with `tenantQuotas`, the server enforces per-tenant throttling. If the resolver throws, the request now fails fast with `400 TenantResolutionFailed` so malformed or malicious headers cannot fall back to the unrestricted default bucket.
- `tenantQuotas`: `{ maxRequestsPerMinute?: number; maxConcurrentRequests?: number; maxLeaseRefreshers?: number; overrides?: Record<string, { maxRequestsPerMinute?: number; maxConcurrentRequests?: number }> }`. Leave undefined to disable throttling or specify per-tenant overrides to grant premium customers higher limits. `maxLeaseRefreshers` caps how many concurrent lease refresh timers the server maintains globally (default 1000) so a burst of unique tenants cannot exhaust the process.
- `onLog(entry)`: Optional hook invoked for every log entry emitted by the OData component (`entry` includes `level`, `message`, `context`, and optional `error`). Use it to forward structured telemetry into your existing logging/monitoring pipeline. If you bind your own logger to `ODATA_BINDINGS.LOGGER` the hook still fires after the logger handles the entry.
- `documentInOpenApiDefault`: Controls whether generated OData routes appear in the published OpenAPI spec. The default `'auto'` policy documents entity sets whose model has LoopBack model metadata (typically via `@odataModel()` which applies `@model()` automatically). Set to `true` to publish every generated controller or `false` to hide everything unless a model opts in via `@odataModel({documentInOpenApi: true})`.
- `removeUndocumentedFromSpec`: When `true` (default), routes tagged with `x-visibility: 'undocumented'` are removed before `/openapi.json` is served. Set to `false` to keep them in the document; the spec enhancer retags them as `x-visibility: 'internal'` so tooling can filter them out.

#### Tenant throttling example

```ts
import { ODATA_BINDINGS } from '@urartian/loopback4-odata';

app.bind(ODATA_BINDINGS.CONFIG).to({
  ...baseConfig,
  tenantResolver: (req) => req.headers['x-tenant-id'] as string | undefined,
  tenantQuotas: {
    maxRequestsPerMinute: 120,
    maxConcurrentRequests: 5,
    overrides: {
      premium: {
        // 'premium' is just a plain object key, it represents whatever tenant identifier your tenantResolver returns.
        maxRequestsPerMinute: 600,
        maxConcurrentRequests: 20,
      },
    },
  },
});
```

With the snippet above every OData controller automatically throttles requests per tenant:

- If `tenantResolver` returns an empty/undefined value, the request fails with `400 TenantResolutionFailed` instead of falling back to a shared bucket.
- Premium tenants inherit the global limits unless an override is specified.
- Configure `tenantQuotas.maxLeaseRefreshers` (default `1000`) to guard against unbounded lease refresh timers. When the cap is reached, additional tenants are rejected until current requests finish.
- All operations (reads, writes, deletes, `$ref`) participate, and concurrency slots are released when the response finishes.
- Resolver exceptions are surfaced to callers as `400 BadRequest` (code `TenantResolutionFailed`) instead of falling back to `'default'`, preserving tenant-specific quotas even when attackers spoof headers.
- Keys inside `tenantQuotas.overrides` must match the string returned by your `tenantResolver`, so you can define arbitrary tiers such as `sandbox`, `enterprise`, or a specific tenant id like `tenant-42`.
- Whenever throttling occurs the component logs a structured warning with `context.event === 'tenant-throttle'`. Hook into `config.onLog` to stream these events into your observability stack:

```ts
onLog(entry) {
  if (entry.context?.event === 'tenant-throttle') {
    console.warn('tenant saturated limits', entry.context);
    // context contains tenantId, limitType, limit, hits, concurrent,
    // windowResetMs, method, url, entitySet, operation, scope, and requestId.
  }
}
```

The default throttling backend keeps counters in-memory inside each process. If you run multiple application instances and need a cluster-wide quota, bind a shared store such as the provided Redis adapter:

```ts
import Redis from 'ioredis';
import { BindingScope } from '@loopback/core';
import { ODATA_BINDINGS, RedisTenantThrottleStore } from '@urartian/loopback4-odata';

app
  .bind(ODATA_BINDINGS.THROTTLE_STORE)
  .toDynamicValue(() => new RedisTenantThrottleStore(new Redis(process.env.REDIS_URL)))
  .inScope(BindingScope.SINGLETON);
```

Any custom store only needs to implement the `TenantThrottleStore` interface (also exported) so you can plug in your preferred database or cache.

- `maxApplyResultSize`: Maximum number of rows the server will process in-memory when executing `$apply` fallbacks (default: `2000`). Requests that exceed the limit are rejected with `400 Bad Request`.
- `logApplyFallbacks`: When `true`, logs a warning whenever `$apply` falls back to in-memory execution (default: `false`).
- `onApplyFallback(event)`: Optional callback invoked whenever `$apply` falls back; receives `{event, entitySet, transformations, rows, limit}` so you can integrate with metrics/telemetry.
- `logApplyTelemetry`: When `true`, emits a concise debug line for every `$apply` stage showing whether it was pushed down or processed in-memory (default: `false`).
- `onApplyTelemetry(event)`: Structured hook invoked after each stage with `{entitySet, stageIndex, stageCount, mode, rows, durationMs, joinCount, reason}` so you can stream analytics into your own logging or monitoring pipeline.
- `maxApplyNavigationFanout`: Maximum number of navigation combinations the in-memory fallback will materialize per stage before returning `400 Bad Request` (default: `1000`).
- `enableApplyPushdown`: Opt-in switch that negotiates `$apply` pushdown with each datasource. When enabled, the supported v1 connector path is PostgreSQL, which executes `groupby()/aggregate()` pipelines in the database. Combine with `@odataModel({applyPushdown: true})` or an `ODataEntitySetConfig` registered through `ODATA_BINDINGS.ENTITY_SET_REGISTRY` for per-entity control.
- `maxExpandDepth`: Maximum allowed `$expand` nesting depth; requests that exceed it return `400 Bad Request`.
- `maxFilterPatternLength`: Caps underscore patterns generated when translating supported `$filter` functions like `length()` and `substring()` (including inside `$apply=filter(...)`) into LoopBack `like` clauses (default: `10000`). Requests that exceed it return `400 Bad Request`.
- `maxSubstringStart`: Maximum allowed `substring(field, start, ...)` start index when translating to patterns (default: `10000`). Requests that exceed it return `400 Bad Request`.
- `maxSubstringLength`: Maximum allowed `substring(field, start, length)` length argument (default: `10000`). Requests that exceed it return `400 Bad Request`.
- `maxFilterFieldNameLength`: Maximum allowed `$filter` field identifier length (default: `256`); dangerous keys like `__proto__`/`constructor`/`prototype` are always rejected.
- `maxDecimalExponentAbs`: Caps the absolute exponent magnitude accepted when normalizing decimal strings (default: `1000`) to prevent pathological allocations.
- `enableCount`:
  - When `false`, inline counts (`?$count=true`) return `400 Bad Request` with an OData error.
  - The standalone path (`GET <basePath>/<EntitySet>/$count`) returns `501 Not Implemented`.
- `csdlFormat`: Selects `$metadata` content type (`application/xml` vs `application/json`). JSON output now emits a standards-compliant CSDL JSON document.
- `namespace`: Overrides the CSDL schema namespace (`Default` by default). All generated types live under this namespace.
- `entityContainerName`: Controls the `<EntityContainer>` / JSON entity container name (`DefaultContainer` by default).
- `namespaceAlias`: Adds the optional `Alias` attribute to the CSDL schema so clients can refer to types using a short prefix.
- `capabilities`: Sets default service-level annotations such as supported filter functions, countability, permissions, stream support, and now OData capability records for inserts/updates/deletes/search via the `insertRestrictions`, `updateRestrictions`, `deleteRestrictions`, and `searchRestrictions` options. Values can be overridden per entity set via `ODataEntitySetConfig.capabilities`.
- `enableDeepInsert`: Opt-in global switch for accepting nested payloads (deep insert). When `true`, every entity set defaults to deep insert unless overridden per model. When `false` (default), only entity sets with `@odataModel({deepInsert: true})` participate.
- `enableDeepUpdate`: Opt-in global switch for deep updates (PATCH payloads containing related entities). Entity sets can override with `@odataModel({deepUpdate: true})` or an `ODataEntitySetConfig` registered through `ODATA_BINDINGS.ENTITY_SET_REGISTRY`.
- `maxDeepInsertDepth`: Maximum recursion depth for deep insert traversal (default: `10`). Requests exceeding the limit are rejected with `400 Bad Request` to prevent runaway graphs.
- `maxDeepUpdateDepth`: Maximum recursion depth for deep update traversal (defaults to `maxDeepInsertDepth` when not set).
- `enableNavigationRefEndpoints`: Set to `false` to skip registration of navigation `$ref` routes if you prefer to manage linking manually (default: `true`).
- `$apply` pipelines support chained `filter`, `groupby`, `aggregate`, `orderby`, `skip`, and `top` stages, including navigation-path aggregates. By default the runtime executes these pipelines in memory; this carries CPU and memory overhead and should be reserved for small result sets. Opt into pushdown to keep heavy analytics inside the database.
- Lambda filters (`any` / `all`) support navigation collections (including multi-segment paths) and can be combined with additional predicates using `and`. Multiple lambdas are supported when combined by top-level `and`, and `not <collection>/(any|all)(...)` is supported via rewrite.
- Nested lambdas are supported up to `lambda.pushdownMaxExistsDepth` (default: `2`). Requests exceeding the limit are rejected with `400 Bad Request` and reason `nested-lambda-depth-exceeded` (even when `lambda.pushdownStrict` is `false`).
- Alias prefix requirement: inside lambda predicates, every field reference must be prefixed with a lambda alias (e.g. `i/qty gt 0`). For nested lambdas, inner paths must start with an in-scope alias (e.g. `o/items/any(i: i/qty gt 0)`). Unprefixed fields are rejected with `400 Bad Request` and reason `lambda-alias-prefix-required`.
- Combining lambdas with `or` is supported at the top level (e.g. `items/any(i: i/qty gt 0) or price gt 1000`). `or` inside lambda predicates that also contain lambdas is still rejected with reason `lambda-or-unsupported`.
- `lambda.pushdownMaxJoinCount` (default: `8`) caps the number of SQL joins generated by Postgres lambda pushdown (including nested lambdas). When exceeded, pushdown is declined with reason `pushdown-join-count-exceeded` (and rejected when `lambda.pushdownStrict` is `true`).
- `lambda.maxLambdaScanRows`: Maximum number of root entities fetched for in-memory lambda evaluation (default: `maxApplyResultSize` if set, else `2000`). Requests exceeding the limit return `400 Bad Request`.
- `lambda.requireTopWhenLambda`: When `true`, requires the client to include `$top` unless server-driven paging is active; otherwise returns `400 Bad Request` (default: `false`).
- `lambda.warnOnLambdaFallback`: When `true`, logs/emits telemetry when lambda evaluation falls back to in-memory processing (default: `true`).
- `lambda.pushdown`: Enables database pushdown for supported lambda filters (`'disabled' | 'postgres'`, default: `'disabled'`). When enabled and eligible, `any` translates to `EXISTS (...)` and `all` translates to `NOT EXISTS (... WHERE (predicate) IS NOT TRUE)` to preserve OData null semantics.
- `lambda.pushdownStrict`: When `true`, rejects lambda queries that are not eligible for pushdown with `400 Bad Request` (default: `false`). When `false`, ineligible queries fall back to in-memory evaluation with guardrails.
- Postgres lambda pushdown supports `hasManyThrough` (many-to-many) relations when the through model and FK metadata can be resolved; incomplete metadata declines with reason `through-relation-unsupported`.
- Supported inside pushed-down lambda predicates: `contains/startswith/endswith` (with optional `tolower`/`toupper` wrappers), `length(field) <op> N`, and direct `tolower(field) eq|ne <string|null>` / `toupper(field) eq|ne <string|null>` comparisons. Note: `LOWER(col)` / `UPPER(col)` can bypass normal btree indexes; consider functional indexes (e.g. `CREATE INDEX ... ON ... (lower(col))`) or `citext` where appropriate.
- `lambda.pushdownMaxExistsDepth`: Maximum allowed lambda nesting depth (default: `2`). Requests exceeding the limit return `400 Bad Request`.
- `lambda.pushdownMaxJoinCount`: Maximum number of joins allowed in Postgres lambda pushdown SQL (default: `8`). If exceeded, pushdown is declined (or rejected in strict mode).
- `strict` (default: true): Enables stricter validations and policies:
  - Requires `If-Match` on `PATCH`/`DELETE` when ETags are enabled (428 if missing).
  - If `maxTop` is set, `$top` above the cap returns `400 Bad Request` instead of being clamped.
  - Rejects unknown system query options (e.g., `$levels`, `$apply`) with `400 Bad Request`.
  - Validates `$select`, `$orderby`, `$filter` fields against model properties. Navigation segments still traverse declared relations and now structured (complex) properties are resolved segment-by-segment, so expressions such as `Customer/PrimaryAddress/City` stay valid while unknown members return `400 Bad Request`. Structured paths currently pass validation even though most connectors evaluate them in memory; SQL pushdown for nested properties will arrive in a future release.
  - Enforces content negotiation: `Accept` must allow `application/json` for CRUD; `$metadata` must allow `application/xml` (or JSON if configured); non‑JSON `Content-Type` on writes returns `415`.
  - Limits & safety: `maxExpandDepth`, `maxFilterPatternLength`, `maxSubstringStart`, `maxSubstringLength`, and `maxFilterFieldNameLength` are hard ceilings (400 when exceeded); `maxSkip` still caps offsets and escalates from clamp to 400 when strict mode is enabled.
  - Search:
    - `searchMode`: `'annotated' | 'config-only' | 'all' | 'disabled'` (default: `annotated`)
    - `searchFields`: `{[entitySet: string]: string[]}` overrides decorator scope
    - `maxSearchFields` / `maxSearchTerms`: caps to prevent overly broad queries (exceeding `maxSearchTerms` now returns `400 Bad Request`)

Example: With `{basePath: '/api/odata', maxTop: 100, enableCount: false}`

- Routes mount at `/api/odata/...`.
- `GET /api/odata/Products?$top=1000` returns at most 100 records.
- `GET /api/odata/Products?$count=true` → `400 Bad Request` (unsupported option).
- `GET /api/odata/Products/$count` → `501 Not Implemented`.

Example: With `{basePath: '/'}`:

- The service document is served from `/`.
- Metadata is served from `/$metadata`.
- Entity sets and singletons are served from root-level paths such as `/Products` and `/Me`.
- Non-OData routes such as `/health` and `/openapi.json` remain owned by the host LB4 app.

Example: Lambda guardrails

```ts
app.bind(ODATA_BINDINGS.CONFIG).to({
  tokenSecret: 'change-me',
  lambda: {
    maxLambdaScanRows: 2000,
    requireTopWhenLambda: true,
    warnOnLambdaFallback: true,
    pushdown: 'postgres',
    pushdownStrict: false,
    pushdownMaxExistsDepth: 2,
    pushdownMaxJoinCount: 8,
  },
});
```

Example: `$filter` guardrails

```ts
app.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  filter: {
    maxInListItems: 200,
    pushdownMaxJoinCount: 6,
    maxPostFilterScanRows: 5000,
    requireTopWhenPostFilter: true,
  },
});
```

- `maxInListItems` limits the number of literal values accepted by the OData `in (...)` operator.
- `pushdownMaxJoinCount` caps join-heavy navigation filter pushdown before the runtime declines back to fallback logic.
- `maxPostFilterScanRows` bounds in-memory post-filter evaluation so unsupported filters cannot trigger unbounded scans.
- `requireTopWhenPostFilter` forces clients to provide `$top` when a request needs post-filter evaluation, helping keep fallback work predictable.

Entity-set specific overrides are available via the registry binding (`ODATA_BINDINGS.ENTITY_SET_REGISTRY`) using `ODataEntitySetConfig`:

- `capabilities`: refine or override filter functions, countability, navigation restrictions, permissions, or stream support for a single entity set.
- `hasStream`: mark the backing entity type as streaming (`Org.OData.Core.V1.HasStream`).
- `mediaField`, `mediaContentTypeField`, `mediaEtagField`, `mediaLengthField`, `mediaHandlerBindingKey`: see [Streaming Media Entities](#streaming-media-entities).

Both the global `capabilities` defaults and per-set overrides support the new `insertRestrictions`, `updateRestrictions`, `deleteRestrictions`, and `searchRestrictions` keys. Example: `insertRestrictions: {insertable: false, nonInsertableNavigationProperties: ['orders']}` emits `Org.OData.Capabilities.V1.InsertRestrictions`, while `searchRestrictions: {unsupportedExpressions: ['not']}` maps shorthand values (`and`, `or`, `not`, etc.) to the corresponding `Org.OData.Capabilities.V1.SearchExpressions/*` enum members.

### OpenAPI documentation visibility

Generated OData routes now annotate each operation with `x-odata-generated` and a `x-visibility` hint so you can decide which controllers appear in `/openapi.json`.

- With the default `documentInOpenApiDefault: 'auto'`, generated routes are documented when the model has LoopBack `@model()` metadata (which `@odataModel()` applies automatically when needed).
- Opt in explicitly with `@odataModel({documentInOpenApi: true})`, or suppress documentation with `@odataModel({documentInOpenApi: false})` even when `@model()` is present.
- Override the global policy by binding `documentInOpenApiDefault` to `true` (publish every generated controller) or `false` (hide everything until a model opts in).

Hidden routes keep their metadata for internal tooling: when `removeUndocumentedFromSpec` is `true` they are stripped from `/openapi.json`; when `false` they stay in the document but are retagged with `x-visibility: 'internal'`.

```ts
@odataModel({ documentInOpenApi: true })
class CustomerDraft extends Entity {
  /* ... */
}

@odataModel({ documentInOpenApi: false })
class AuditLog extends Entity {
  /* ... */
}

const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  documentInOpenApiDefault: 'auto',
  removeUndocumentedFromSpec: true,
});
```

Inspect the processed spec via `await app.restServer.getApiSpec()` or by requesting `/openapi.json` to confirm which routes are published.

### Streaming Media Entities

LoopBack OData services can expose [$value media streams](https://www.odata.org/documentation/odata-version-3-0/media-entities/) by decorating a model with `@odataModel({ hasStream: true })`. A few optional metadata properties help the runtime locate content and track metadata:

- `mediaField`: Property name that stores the binary payload (Buffer/Uint8Array/Readable). When provided, the booter auto-registers a `PropertyBackedMediaHandler` that persists streams inside the entity itself. This default path is meant for bounded payload sizes, not very large file ingestion.
- `mediaContentTypeField`: String property containing the MIME type returned by `$value` (e.g., `image/png`).
- `mediaEtagField`: Property holding the stream-specific ETag; enables conditional headers (`If-None-Match`, `If-Match`) for media operations.
- `mediaLengthField`: Numeric property storing the byte length; when set the controller emits `Content-Length` without fully buffering the stream.
- `mediaHandlerBindingKey`: Override the IoC binding key used to resolve the media handler (defaults to `ODATA_BINDINGS.MEDIA_HANDLERS.key.<EntitySet>`). Useful when multiple entity sets share a handler implementation.
- `mediaMaxPayloadBytes`: Maximum number of bytes the default property-backed handler buffers in memory before rejecting the upload (defaults to 10 MiB).

When `mediaEtagField` is configured the generated `$metadata` advertises `@Org.OData.Core.V1.MediaETag`, allowing clients to discover which property carries the stream ETag and rely on conditional caching headers automatically.

When handling uploads the controller prefers metadata reported by the `ODataMediaHandler` over the incoming HTTP headers. Handlers can return `contentType`, `length`, and `etag` from their `write()` result to override the stored values. This enables sniffing binary payloads server-side, emitting custom weak ETags, or correcting bogus `Content-Type`/`Content-Length` headers before persisting the entity’s metadata and `@odata.mediaContentType`.

When `mediaField` is configured the default property-backed handler buffers the upload into memory and then writes the resulting `Buffer` into that property while enforcing `mediaMaxPayloadBytes` to guard against unbounded buffering. For the supported v1 PostgreSQL path, make sure the backing column is `bytea`. Use connector metadata like this:

```ts
@property({
  type: 'buffer',
  postgresql: { dataType: 'bytea' }, // <-- important: BLOB/bytea column
})
data?: Buffer;
```

When `hasStream` is enabled the booter inspects the repository binding and registers an `ODataMediaHandler` automatically:

- If the repository prototype implements `getMedia(id, options)` / `setMedia(id, stream, metadata, options)` (and optionally `deleteMedia`), the booter wires a `RepositoryMediaHandlerAdapter` that forwards reads/writes into those hooks.
- Otherwise, if `mediaField` is configured, a request-scoped `PropertyBackedMediaHandler` is bound which reads/writes the binary column directly.
- You can always bind your own handler to the configured `mediaHandlerBindingKey` to integrate object storage, CDNs, etc. Custom handlers must implement the `ODataMediaHandler` interface exported from `@urartian/loopback4-odata`.

For large-file scenarios, prefer a custom streaming handler over the default property-backed path. The default handler intentionally prioritizes safe bounded buffering with a conservative `10 MiB` limit. If your production requirements include uploads well above that range, route the stream into external storage or another sink inside a custom `ODataMediaHandler` instead of raising the in-memory limit indefinitely.

Example: property-backed storage that tracks MIME type/length/ETag on the entity:

```ts
@odataModel({
  hasStream: true,
  mediaField: 'data',
  mediaContentTypeField: 'contentType',
  mediaEtagField: 'mediaVersion',
  mediaLengthField: 'size',
})
class MediaAsset extends Entity {
  @property({ id: true }) id?: number;
  @property({ type: 'string' }) contentType?: string;
  @property({ type: 'number' }) size?: number;
  @property({ type: 'string' }) mediaVersion?: string;
  @property({
    type: 'buffer',
    // Describe the binary column as a base64 string in OpenAPI/JSON Schema so validation passes.
    jsonSchema: { type: 'string', format: 'byte' },
    postgresql: { dataType: 'bytea' },
  })
  data?: Buffer;
}
```

Custom storage backends can replace the default handler by binding to the generated key:

```ts
import {
  ODATA_BINDINGS,
  ODataMediaHandler,
  ODataMediaReadContext,
  ODataMediaWriteContext,
} from '@urartian/loopback4-odata';

class S3MediaHandler implements ODataMediaHandler {
  constructor(@inject('services.S3') private readonly client: S3Client) {}

  async read(ctx: ODataMediaReadContext) {
    const stream = await this.client.getObject({ Key: ctx.id as string });
    return { stream, contentType: ctx.entity?.contentType };
  }

  async write(ctx: ODataMediaWriteContext) {
    await this.client.putObject({
      Key: ctx.id as string,
      Body: ctx.stream,
      ContentType: ctx.contentType,
    });
    return { contentType: ctx.contentType };
  }
}

app.bind(`${ODATA_BINDINGS.MEDIA_HANDLERS.key}.MediaAssets`).toClass(S3MediaHandler);
```

Handlers run inside the request scope, so repository injections, current-tenant providers, and other per-request bindings remain available while processing `$value` endpoints.

> **Reminder**
>
> `$value` routes only interact with the media stream (and optional metadata fields configured via `mediaContentTypeField`, `mediaLengthField`, `mediaEtagField`). Updating scalar properties such as `title`, `description`, or custom columns still requires a JSON `PATCH /odata/<EntitySet>('{id}')` call. The controller intentionally separates these concerns so file uploads cannot silently overwrite regular entity data.

### JSON Stream Properties (PostgreSQL `json`/`jsonb`)

If you store JSON in a PostgreSQL `json`/`jsonb` column (or otherwise model it as an object), you can expose it to OData clients as a **stream property** (`Edm.Stream`) with `Core.MediaType = application/json`.

Model example:

```ts
@odataModel()
export class DecisionRule extends Entity {
  @property({ id: true })
  id!: string;

  @property({
    type: 'object',
    required: true,
    postgresql: { dataType: 'jsonb' },
  })
  decisionSchema!: object;
}
```

Behavior:

- `$metadata` includes `decisionSchema` as `Edm.Stream` and annotates it with `Org.OData.Core.V1.MediaType="application/json"`.
- Entity reads do **not** inline the JSON value; instead they expose per-property media annotations like `decisionSchema@odata.mediaReadLink` and `decisionSchema@odata.mediaContentType`.
- Read the JSON payload via:
  - `GET /odata/DecisionRules(<id>)/decisionSchema` (returns `application/json`)
  - `GET /odata/DecisionRules(<id>)/decisionSchema/$value` (returns `application/json`)
- Write the JSON via normal entity create/patch payloads (e.g., `POST /odata/DecisionRules` or `PATCH /odata/DecisionRules(<id>)`). Dedicated `PUT /.../<property>` stream writes are not currently implemented.

If you can’t (or don’t want to) rely on connector metadata like `postgresql.dataType`, you can also force the mapping via JSON Schema hints:

```ts
@property({
  type: 'object',
  jsonSchema: {
    'x-odata-type': 'Edm.Stream',
    'x-odata-media-type': 'application/json',
  },
})
decisionSchema!: object;
```

### Server-driven Paging & `$skiptoken`

Collection reads now default to server-driven paging. The component takes the smaller of the requested `$top` and the configured `pageSize` (default `200`), returns that many entities, and emits an `@odata.nextLink` that includes a signed `$skiptoken`. Tokens carry the ordering values plus an HMAC signature bound to the current request shape, so tampering or replaying the token outside its context is rejected with `400 Invalid $skiptoken`. Configure `tokenSecret` before boot; without it the component refuses to issue tokens.

```http
GET /odata/Products
```

```json
{
  "@odata.context": "/odata/$metadata#Products",
  "value": [
    { "id": 1, "name": "Laptop", "price": 1299 },
    { "id": 2, "name": "Phone", "price": 799 }
  ],
  "@odata.nextLink": "/odata/Products?$skiptoken=v3:eyJ2Ijoi...\""
}
```

The controller enforces deterministic ordering automatically by appending the entity key to any client-supplied `$orderby`. When a request arrives with `$skiptoken`, the backend verifies the signature, checks the TTL (`skipTokenTtl`, 15 minutes by default), and then composes a lexicographic filter so the database (or in-memory fallback) resumes exactly where the previous page stopped. Traditional `$skip` offsets are rejected when server-driven paging is active—stick with `$skiptoken`. The same mechanism now applies to `$apply` pipelines, so aggregated feeds page the same way as raw collections.

If you need a different page size, override `pageSize` at startup or per test using the configuration examples above.

### Delta Links

When `enableDelta` is `true`, the first page of a collection includes an `@odata.deltaLink`. Clients can store that URL and call it later to retrieve only the entities that changed since the last sync. The implementation relies on each entity set having a stable change stamp (the first configured ETag property, or the field supplied via `@odataModel({delta: {field: ...}})` / `ODataEntitySetConfig.deltaField`). Delta links are signed with the same `tokenSecret`; tampering or using an expired token (see `deltaTokenTtl`) returns `400 Invalid $deltatoken`.

```http
GET /odata/Products
```

```json
{
  "@odata.context": "/odata/$metadata#Products",
  "value": [{ "id": 1, "name": "Laptop", "updatedAt": "2025-10-17T14:53:52.705Z" }],
  "@odata.deltaLink": "/odata/Products?$deltatoken=v3:eyJ2Ijoi...\""
}
```

Following the delta link returns only the new or updated rows (and can be combined with regular paging via `@odata.nextLink`). The same flow works for `$apply` pipelines: the engine reruns the pipeline over the rows that changed since the last token and returns the affected aggregates.

> **Token rotation & TTL**  
> Delta links are signed with `tokenSecret`. When a link expires (`deltaTokenTtl`) or you rotate the secret, the server returns `410 Gone` and emits an `onDeltaTokenInvalid` event (with `code` such as `expired`, `invalid`, or `entity-mismatch`). Clients should treat `410` as a cue to fetch a fresh snapshot.

Deleted entities show up as tombstones:

```json
{
  "id": 1,
  "@removed": { "reason": "deleted" }
}
```

For `$apply` pipelines, delta responses include the aggregated buckets that changed as well as `@removed` entries for buckets that disappeared since the previous sync. Tombstones carry the last known aggregate snapshot, so clients continue to see the bucket keys **and** the previously computed measures:

```json
{
  "name": "Laptop",
  "TotalPrice": 1299,
  "@removed": { "reason": "deleted" }
}
```

> **Upgrading from unsigned tokens?** Set `allowLegacyUnsignedTokens: true` temporarily so existing `$skiptoken` / `$deltatoken` links issued by earlier versions continue to work. New tokens are always emitted in the signed `v3:` format; once clients have refreshed their cursors you should disable the flag again.

### Advanced `$apply` Examples

Start the example app (it seeds sample data on boot):

```bash
npm run dev
```

Run a multi-stage pipeline with filtering, grouping, and ordering:

```bash
curl "http://127.0.0.1:3001/odata/Orders?\$apply=filter(total%20gt%202500)/groupby((total),aggregate(id%20with%20count%20as%20OrderCount))/orderby(OrderCount%20desc)/top(1)"
```

Aggregate over navigation paths:

```bash
curl "http://127.0.0.1:3001/odata/OrderItems?\$apply=groupby((order/id),aggregate(order/total%20with%20sum%20as%20TotalRevenue))/orderby(TotalRevenue%20desc)/top(1)"
```

Apply post-aggregation filters (similar to SQL `HAVING`):

```bash
curl "http://127.0.0.1:3001/odata/Orders?\$apply=groupby((customerId),aggregate(total%20with%20sum%20as%20TotalRevenue))/filter(TotalRevenue%20gt%205000)/orderby(TotalRevenue%20desc)"
```

Guard in-memory fallbacks by capping the allowed result size:

```bash
MAX_APPLY_RESULT_SIZE=1 npm run dev
curl "http://127.0.0.1:3001/odata/OrderItems?\$apply=groupby((order/id),aggregate(order/total%20with%20sum%20as%20TotalRevenue))"
```

The second command now returns `400 Bad Request`, demonstrating the throttle.

Multi-stage pipeline with navigation joins and chained groupings (runs entirely inside the database when pushdown is enabled):

```bash
curl "http://127.0.0.1:3001/odata/OrderItems?\$apply=groupby((order/customer/country),aggregate(order/total%20with%20sum%20as%20TotalSpend))/filter(TotalSpend%20gt%202000)/groupby((order/customer/country),aggregate(TotalSpend%20with%20max%20as%20PeakSpend))/orderby(PeakSpend%20desc)"
```

### `$apply` Pushdown (PostgreSQL)

- Pushdown is **opt-in**. Out of the box, `$apply` executes in memory. This is functionally correct but resource intensive; enable pushdown for production workloads. Once enabled, the SQL executors keep entire pipelines (multiple `groupby`/`aggregate` stages plus `filter`, `orderby`, `skip`, `top`) inside the database, emitting native `HAVING`, `ORDER BY`, `LIMIT`, and `OFFSET`.
- Set `enableApplyPushdown: true` on `ODataConfig` to negotiate pushdown across datasources, or opt in per model with `@odataModel({applyPushdown: true})` / per entity set via an `ODataEntitySetConfig` registered through `ODATA_BINDINGS.ENTITY_SET_REGISTRY`.
- PostgreSQL is the supported native pushdown path for v1. The extension inspects each repository datasource and, when it detects a compatible PostgreSQL connector, routes aggregation pipelines through a SQL executor built on `dataSource.execute(...)`.
- Navigation aggregates are compiled into `LEFT JOIN` chains, so queries like `groupby((order/customer/country), aggregate(order/total with sum as TotalSpend))` continue to run server-side even when later stages reference aliases or regroup the intermediate result set. The PostgreSQL executor uses quoted identifiers and `$n` parameters.
- Stage-level pagination and filters stay in SQL. Post-aggregate `filter(...)` segments translate to `HAVING` clauses, and `skip`/`top` stages map to `OFFSET`/`LIMIT` inside each stage rather than being re-applied in memory.
- Telemetry hooks (`logApplyTelemetry: true` or a custom `onApplyFallback`) now capture per-stage execution mode, duration, row counts, and join counts so you can audit when a pipeline leaves the database.
- Table and column names are inferred automatically from the connector metadata (including the default lowercase conversion), so the usual LoopBack naming conventions work without additional annotations. Override the metadata only when you map models to non-standard table names.
- Unsupported scenarios automatically fall back to the in-memory executor. When `logApplyFallbacks` is enabled (or `onApplyFallback` is provided), additional events (`executor-declined`, `executor-error`, `missing-stage-filters`, `missing-stage-pagination`) surface whenever the pushdown path declines a request. Use these signals to monitor unexpected CPU/memory usage.
- Capability metadata reflects reality: entity sets only emit `Org.OData.Capabilities.V1.ApplySupported` when pushdown is active, so BI clients can rely on the annotation.
- Custom connectors can participate by registering their own executor with `ODataApplyExecutorRegistry`. Executors decide at runtime whether they can satisfy a pipeline and can signal unsupported combinations by returning `undefined`, preserving the existing fallback behavior.

To try pushdown with the example app (requires PostgreSQL running locally):

```bash
USE_POSTGRES=true PG_HOST=127.0.0.1 PG_USER=postgres PG_PASSWORD=pass PG_DATABASE=odata_dev \
ENABLE_APPLY_PUSHDOWN=true LOG_APPLY_TELEMETRY=true npm run dev
```

In your application bootstrap you can enable telemetry-driven pushdown like this:

```ts
const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  enableApplyPushdown: true,
  logApplyTelemetry: true,
  onApplyFallback: (event) => {
    console.warn('[OData] apply fallback', event);
  },
});
```

### Deep Insert

Deep insert is enabled automatically for entity sets that expose composition-style relations (hasOne/hasMany navigations whose foreign key is required on the target model). The booter analyses relation metadata from the model definitions at startup and turns on deep insert/update whenever it detects such compositions. Composed children can be created alongside their parent without additional configuration.

You can still control the behaviour explicitly:

- Opt out per model when you want to keep inserts shallow:

  ```ts
  @odataModel({ deepInsert: false })
  export class Order extends Entity {
    @hasMany(() => OrderItem)
    items?: OrderItem[];
  }
  ```

- Force-enable deep insert for aggregates that do not meet the automatic detection criteria:

  ```ts
  @odataModel({ deepInsert: true })
  export class DraftOrder extends Entity {
    @hasMany(() => OrderItem)
    items?: OrderItem[];
  }
  ```

- Set a global default before `app.boot()` if you prefer everything to opt in by default:

  ```ts
  this.bind(ODATA_BINDINGS.CONFIG).to({
    enableDeepInsert: true,
  } as ODataConfig);
  ```

If the booter notices composition-style relations but deep insert/update remain disabled (for example because you set `deepUpdate: false` explicitly), it logs a warning so you can review the decision.

When enabled, `POST /odata/Orders` can include nested navigation data (compositions):

```http
POST /odata/Orders
Content-Type: application/json

{
  "id": 9801,
  "total": 1234,
  "items": [
    {"productId": 1, "quantity": 2, "unitPrice": 499},
    {"productId": 2, "quantity": 1, "unitPrice": 299}
  ]
}
```

The controller persists the order, its line items, and each item note inside a single transaction and annotates `$metadata` with `Org.OData.Capabilities.V1.DeepInsertSupport` for the entity set. Nested relations beyond the first level are followed recursively (subject to `maxDeepInsertDepth`). Associations via `through` are not accepted inline.

Validation notes:

- Collection navigation properties must be arrays. If a single object is sent for a `hasMany` relation, the request is rejected by the route validator with `422 Unprocessable Entity`.
- The reason appears under `error.details`, not the top-level message. Look for an entry similar to:

  ```json
  {
    "path": "/items",
    "code": "type",
    "message": "must be array"
  }
  ```

### Deep Update

Deep updates follow the same composition-aware defaults. If a model has required hasMany/hasOne relations, the booter enables deep update automatically so PATCH requests can create/update child entities alongside the parent. You can override the default exactly like deep insert:

- Opt out per model with `@odataModel({deepUpdate: false})`
- Force-enable with `@odataModel({deepUpdate: true})`
- Or set `enableDeepUpdate: true` at the config level before boot

Example request (update + add):

```http
PATCH /odata/Orders(9802)
Content-Type: application/json
If-Match: W/"..."

{
  "total": 1500,
  "items": [
    {
      "id": 20001,
      "quantity": 3,
      "notes": [
        {"id": 30001, "text": "updated note"},
        {"text": "new note"}
      ]
    },
    {"productId": 5, "quantity": 1, "unitPrice": 799}
  ]
}
```

Validation and behavior:

- PATCH schema is strict. Only model fields and supported relation keys (hasOne/hasMany, excluding through) are accepted at the top level and recursively; unknown properties are rejected.
- Child without key → inserted. Child with key → patched. Deletions are explicit operations (see below); use `DELETE /EntitySet(key)` or `$ref` unlink endpoints.
- Nested relations are traversed depth-first, obeying `maxDeepUpdateDepth`, and the entire graph is mutated inside the same transaction.
- BelongsTo and many-to-many (`through`) relations are not accepted inline; manage them via foreign keys or explicit join entities (see “Many-to-many (`hasManyThrough`) writes” below).

Validation notes:

- As with deep insert, collection navigation properties in PATCH must be arrays. A single object for a `hasMany` relation results in `422 Unprocessable Entity` with an Ajv detail entry like:

  ```json
  {
    "path": "/items",
    "code": "type",
    "message": "must be array"
  }
  ```

### Composition Deletes

This project supports two enforcement modes for “composition-style” lifecycle ownership (parent → children).

Configuration:

- `composition.enforcement`: `'database'` (default) or `'application'`
- In `enforcement: 'database'`, the framework does not run any composition delete logic; behavior is determined entirely by your DB foreign keys (`ON DELETE CASCADE` vs `RESTRICT/NO ACTION`). Other `composition.*` options are ignored.
- The rest of `composition.*` options apply only when `enforcement: 'application'`.

> **Composition TL;DR**
>
> - Composition is **explicitly configured** (not inferred from required FKs): a relation is “composition” when it appears under `composition.*.relations` (global config, `@odataModel` decorator, or `ODataEntitySetConfig.composition`) after config resolution.
> - It affects **delete semantics** (database-enforced via `ON DELETE ...` FKs, or application-enforced via configured delete policies).
> - It also affects **write semantics** (regardless of enforcement mode): `$ref` link/unlink is rejected, and changing the child’s parent FK is rejected (direct `PATCH` and parent `PATCH` deep updates).
>
> **Golden path example: `Orders -> items (OrderItems)`**
>
> 1. Mark the navigation as composition:
>
> ```ts
> // ODataConfig
> composition: {
>   enforcement: 'database', // or 'application'
>   entitySets: {
>     Orders: { relations: { items: { delete: 'cascade' } } },
>   },
> }
> ```
>
> Or keep the rules next to the model via `@odataModel`:
>
> ```ts
> import { Entity, model, property, hasMany, belongsTo } from '@loopback/repository';
> import { odataModel } from '@urartian/loopback4-odata';
>
> @odataModel({
>   // marks Orders.items as a composition relation (explicit config)
>   composition: { relations: { items: { delete: 'cascade' } } },
> })
> export class Order extends Entity {
>   @property({ id: true }) id!: number;
>   @hasMany(() => OrderItem, { keyTo: 'orderId' }) items?: OrderItem[];
> }
>
> @odataModel()
> export class OrderItem extends Entity {
>   @property({ id: true }) id!: number;
>   @belongsTo(() => Order) orderId!: number;
> }
> ```
>
> Delete enforcement (database vs application) is still chosen globally via `ODataConfig.composition.enforcement`.
>
> 2. Add the DB FK for delete behavior (Postgres example):
>
> ```sql
> ALTER TABLE order_items
>   ADD CONSTRAINT fk_order_items_order
>   FOREIGN KEY (order_id) REFERENCES orders(id)
>   ON DELETE CASCADE;
> ```
>
> 3. Allowed vs rejected writes:
>
> ```http
> # allowed: create child owned by parent
> POST /odata/OrderItems
> {"orderId":1,"productId":5,"quantity":1}
>
> # allowed: update child fields (but not orderId)
> PATCH /odata/OrderItems(10)
> {"quantity":2}
>
> # rejected (409): link/unlink bypasses ownership
> POST /odata/Orders(1)/items/$ref
> {"@odata.id":"/odata/OrderItems(10)"}
>
> DELETE /odata/Orders(1)/items(10)/$ref
>
> # rejected (409): re-parenting, including via deep update payloads
> PATCH /odata/OrderItems(10)
> {"orderId":2}
>
> PATCH /odata/Orders(1)
> {"items":[{"id":10,"orderId":2}]}
> ```

#### Recommended default: database-enforced

By default, deletes are **database-enforced**: `DELETE /odata/<EntitySet>(<id>)` issues a single delete for the requested entity and relies on your database schema (FK constraints) to either cascade or reject. This is the recommended production mode for Postgres.

Example (global config, explicit default):

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  composition: {
    enforcement: 'database', // default; OK to omit
  },
} as ODataConfig);
```

How to configure cascade/restrict in LB4:

- LoopBack model/relation decorators (`@hasMany`, `@belongsTo`) describe API shape and repositories, but they do **not** reliably create Postgres foreign keys with `ON DELETE ...` by configuration alone.
- To get DB-enforced cascade/restrict you must apply DDL via migrations (Knex/Flyway/etc.) or execute SQL yourself (e.g. `ds.execute(...)` after `app.migrateSchema()` in `examples/basic-app/migrations/migrate.ts`).

Example (Postgres DDL for `Orders -> OrderItems -> OrderItemNotes` cascade):

```sql
ALTER TABLE order_items
  ADD CONSTRAINT fk_order_items_order
  FOREIGN KEY (order_id) REFERENCES orders(id)
  ON DELETE CASCADE;

ALTER TABLE order_item_notes
  ADD CONSTRAINT fk_order_item_notes_item
  FOREIGN KEY (order_item_id) REFERENCES order_items(id)
  ON DELETE CASCADE;
```

If you prefer “restrict” behavior, use `ON DELETE RESTRICT`/`NO ACTION` (the default in many setups).

When to use database-enforced:

- You use Postgres (or another RDBMS with real FK constraints) and you control migrations.
- You want the strongest correctness guarantees with the simplest runtime behavior.
- You want “hard delete” semantics (soft delete is a separate, explicit design choice).
- When deletes are blocked by FK constraints (database “restrict”), the service returns `409 Conflict`.

#### Optional: application-enforced deletes

Application-enforced deletes are an opt-in “escape hatch”. When enabled, the framework applies composition policies itself (restrict/cascade) and can perform depth-first cascades with guardrails/telemetry.

If you can’t rely on DB-enforced referential actions (or you want explicit depth-first deletes with guardrails/telemetry), enable application-enforced composition deletes:

- Set `composition.enforcement: 'application'`
- Configure per-navigation delete policies:
  - `restrict` (default): reject parent deletes when composed children exist (`409 Conflict`)
  - `cascade`: delete composed children depth-first (and nested composed children) before deleting the parent

Configuration is layered and merged per entity set with the following precedence (highest wins): registry (`ODataEntitySetConfig.composition`) → decorator (`@odataModel({composition})`) → global per-set (`ODataConfig.composition.entitySets`) → global default (`ODataConfig.composition.defaultDeletePolicy`).

Example (global config):

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  composition: {
    enforcement: 'application',
    defaultDeletePolicy: 'restrict',
    requireTransactionSupport: true,
    maxDepth: 8,
    maxEntities: 5000,
    entitySets: {
      Orders: { relations: { items: { delete: 'cascade' } } },
      OrderItems: { relations: { notes: { delete: 'cascade' } } },
    },
  },
} as ODataConfig);
```

Notes:

- Cascade deletes reuse `$batch` changeset transactions when present; otherwise they start a new datasource transaction when supported (Postgres-first).
- Set `composition.requireTransactionSupport: false` to allow best-effort cascade deletes on non-transactional datasources.
- If an entity set defines `@odata.on('DELETE')`, composition delete semantics are not applied automatically; the handler fully owns delete behavior.

Soft delete is an explicit design choice: implement it via an override handler:

```ts
import { odata, CrudOnContext } from '@urartian/loopback4-odata';

export class OrdersController {
  constructor(/* inject your repository here */) {}

  @odata.on('DELETE')
  async softDelete(ctx: CrudOnContext) {
    // Example: mark as deleted instead of hard-delete
    await (ctx.repository as any).updateById(ctx.id, { deletedAt: new Date() }, ctx.options);
    ctx.helpers.noContent();
  }
}
```

### Navigation `$ref`

Link existing entities without PATCHing full payloads. For a `hasMany` relation:

```http
POST /odata/Orders(1)/items/$ref
Content-Type: application/json

{"@odata.id": "/odata/OrderItems(42)"}
```

The handler reassigns `OrderItems(42)` to order `1` and returns `204 No Content`. To remove the association:

```http
DELETE /odata/Orders(1)/items/42/$ref
```

To delete a related row (instead of using in-payload markers), either:

```http
DELETE /odata/OrderItems(20002)
```

or (for non-composition associations) unlink it from the parent collection:

```http
DELETE /odata/Orders(9802)/items(20002)/$ref
```

For `hasOne`, use `PUT /EntitySet(key)/Relation/$ref` to link and `DELETE /EntitySet(key)/Relation/$ref` to clear the link. Relations defined with `hasManyThrough` are skipped.

Composition relations:

- A relation is treated as composition when configured under `composition.*.relations` (global config, `@odataModel` decorator, or `ODataEntitySetConfig.composition`), i.e. when it appears in the resolved composition config.
- `$ref` link/unlink is rejected with `409 Conflict`; create the child under the parent (or set the parent FK on `POST /ChildSet`) and delete children via `DELETE /ChildSet(key)`.
- Re-parenting by `PATCH`ing the child’s parent FK is rejected with `409 Conflict`.

For atomic multi-step graph changes (e.g., unlink + patch + insert), wrap the operations in a `$batch` atomic changeset.

Error handling:

- `DELETE /EntitySet(key)` returns `404 Not Found` when the entity does not exist.
- `DELETE /EntitySet(key)/Relation(key)/$ref` returns `404 Not Found` when the link does not exist (target missing, already unlinked, or linked to a different parent).

### Many-to-many (`hasManyThrough`) writes

LoopBack’s many-to-many relations are typically modeled as `hasManyThrough` via an explicit join entity (for example `OrderItems` linking `Orders` and `Products`). This project intentionally does **not** generate navigation `$ref` routes for `hasManyThrough` relations, because linking/unlinking is equivalent to creating/deleting join rows (often with payload like `quantity`, `unitPrice`, etc.). The join entity is the write surface.

Assume `Orders` and `Products` are linked through `OrderItems`:

- Read an order and its products via the join rows:

  ```http
  GET /odata/Orders(9802)?$expand=items($expand=product)
  ```

- Add a product to an order (create the association):

  ```http
  POST /odata/OrderItems
  Content-Type: application/json

  {"orderId":9802,"productId":5,"quantity":1,"unitPrice":799}
  ```

- Update the association payload:

  ```http
  PATCH /odata/OrderItems(20002)
  Content-Type: application/json

  {"quantity":2}
  ```

- Remove a product from an order (delete the join row):

  ```http
  DELETE /odata/OrderItems(20002)
  ```

- If you don’t know the join row key yet, query for it first:

  ```http
  GET /odata/OrderItems?$filter=orderId eq 9802 and productId eq 5&$select=id
  ```

#### Atomic `$batch` changeset example (unlink + patch + insert)

```http
POST /odata/$batch
Content-Type: multipart/mixed; boundary=batch_123

--batch_123
Content-Type: multipart/mixed; boundary=changeset_abc

--changeset_abc
Content-Type: application/http
Content-Transfer-Encoding: binary

DELETE /odata/Orders(9802)/items(20002)/$ref HTTP/1.1

--changeset_abc
Content-Type: application/http
Content-Transfer-Encoding: binary

PATCH /odata/Orders(9802) HTTP/1.1
Content-Type: application/json
If-Match: W/"..."

{
  "total": 1700,
  "items": [
    {
      "id": 20001,
      "quantity": 3,
      "notes": [
        {"id": 30001, "text": "updated note"}
      ]
    }
  ]
}

--changeset_abc
Content-Type: application/http
Content-Transfer-Encoding: binary

POST /odata/OrderItems HTTP/1.1
Content-Type: application/json

{
  "orderId": 9802,
  "productId": 5,
  "quantity": 1,
  "unitPrice": 799
}

--changeset_abc--
--batch_123--
```

All three requests execute atomically. If any fails, the entire changeset is rolled back and the batch returns per-request error details.

## Observability & Telemetry

The component can emit structured telemetry so operators can trace pushdown decisions, hook execution, throttling, and token validation with the same logger their LoopBack app already uses. Configure telemetry and correlation once in your application bootstrap:

```ts
const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
this.bind(ODATA_BINDINGS.CONFIG).to({
  ...current,
  telemetry: {
    enabled: true,
    level: 'debug',
    categories: ['apply', 'rewrite', 'hooks'],
    sampleRate: 0.25,
    emitStatisticsHeader: true,
    statisticsHeaderName: 'OData-Statistics',
    includeApplyPlanOnFallback: true,
  },
  correlation: {
    headerName: 'x-correlation-id',
    responseHeaderName: 'x-correlation-id',
    generateWhenMissing: true,
  },
});
```

- `telemetry.enabled` gates all instrumentation, while `categories` acts as a filter for noisy areas (`apply`, `rewrite`, `hooks`, `batch`, `throttle`, `tokens`, `requests`). `includeApplyPlanOnFallback` embeds the `$apply` plan when a pushdown falls back to in-memory execution, making it easier to diagnose regressions.
- `sampleRate` allows high-volume services to trace only a slice of requests (0 disables, 1 traces every request).
- When `telemetry.requestLogging.enabled = true`—or when `telemetry.requestLogging.allowClientOverride = true` and clients send `Prefer: telemetry=request-log`—the component emits request logs (`telemetryEvent=request.log`) with method, URL, status, masked headers, and optionally bodies (bounded by `maxPayloadBytes`). Response bodies are included only when `includeResponseBody` is true.
- When `emitStatisticsHeader` is true, clients can opt in per request with `Prefer: telemetry=statistics`. Successful requests answer with `Preference-Applied: telemetry=statistics` and an `OData-Statistics` header such as `{"dbTime":21,"processingTime":12,"roundTrips":1,"rows":42}`.
- The correlation block captures request IDs from headers (default `x-correlation-id`), optionally echoes them back on responses, and makes them available to repositories and telemetry emitters so your existing log aggregation or tracing tools can stitch events together.

Use `ODATA_BINDINGS.LOGGER` to plug in your preferred logger (e.g., Pino, Winston) and enrich telemetry events with tenant IDs or custom tags before forwarding them to your observability stack.

### LB4 Transport Security Responsibilities

This component secures OData-specific behavior such as query guardrails, signed paging/delta tokens, payload limits, and normalized error envelopes. In a LoopBack 4 application, transport-wide HTTP policy still belongs to the host `RestApplication` (or your ingress / reverse proxy), not the OData component itself.

For production LB4 deployments, configure these at the application layer:

- CORS policy with the origins, methods, and headers your app actually allows.
- Security headers such as `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, and `Strict-Transport-Security`.
- TLS termination and proxy/header trust policy.

The OData component intentionally does not set these headers globally because doing so inside a reusable LB4 component would silently override host-application security policy.

### Configuration reference

| Option                                         | Description                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry.enabled`                            | Master switch. When `false`, telemetry is off unless you configure `telemetry.requestLogging.enabled = true` or a client opts in via `Prefer: telemetry=request-log`. |
| `telemetry.level`                              | Minimum level used for OData-generated events (`trace`, `debug`, `info`, `warn`, `error`). Defaults to `info`.                                                        |
| `telemetry.categories`                         | Optional list to limit telemetry to specific areas: `apply`, `rewrite`, `hooks`, `batch`, `throttle`, `tokens`, `requests`. Empty/omitted = all.                      |
| `telemetry.sampleRate`                         | Float between `0` and `1`. When less than `1`, only that percentage of requests emit telemetry (useful for high-traffic services).                                    |
| `telemetry.emitStatisticsHeader`               | Enables the server to honor `Prefer: telemetry=statistics` and respond with per-request metrics.                                                                      |
| `telemetry.statisticsHeaderName`               | Response header name for statistics (`OData-Statistics` by default).                                                                                                  |
| `telemetry.statisticsPrecision`                | Decimal precision for timing values in the stats header.                                                                                                              |
| `telemetry.includeApplyPlanOnFallback`         | When true, `$apply` fallback events include the serialized execution plan in telemetry logs.                                                                          |
| `telemetry.requestLogging.enabled`             | When true, every OData request is logged (`telemetryEvent=request.log`) with method/URL/status and masked headers/bodies.                                             |
| `telemetry.requestLogging.allowClientOverride` | When true (default `false`), clients can request per-call logging via `Prefer: telemetry=request-log`.                                                                |
| `telemetry.requestLogging.includeHeaders`      | Include request headers in the log (masked via `maskHeaders`). Defaults to `true`.                                                                                    |
| `telemetry.requestLogging.includeResponseBody` | Include response payloads (respecting `maxPayloadBytes`). Defaults to `false`.                                                                                        |
| `telemetry.requestLogging.maxPayloadBytes`     | Maximum number of bytes captured from request/response bodies before truncation (default 32768).                                                                      |
| `telemetry.requestLogging.maskHeaders`         | Array of header names to redact (e.g., `['authorization', 'cookie']`).                                                                                                |
| `telemetry.requestLogging.maskBodyPaths`       | Array of top-level JSON field names to redact from request bodies (e.g., `['password']`).                                                                             |
| `correlation.headerName`                       | Request header inspected for correlation IDs (`x-correlation-id` default).                                                                                            |
| `correlation.responseHeaderName`               | Header echoed back on responses; set when clients need confirmation of the correlation ID that was used.                                                              |
| `correlation.generateWhenMissing`              | Generates a UUID when the client omits the correlation header (default `true`).                                                                                       |
| `correlation.enabled`                          | Enables correlation ID capture/generation and propagation (default `true`).                                                                                           |
| `correlation.propagateToRepositories`          | When `true` (default), LoopBack repository/connector options include correlation context for downstream logging/tracing.                                              |
| `correlation.repositoryOptionsKey`             | Options property name used to store correlation context (default `correlation`).                                                                                      |

#### Reading correlation in repositories

When propagation is enabled, OData passes correlation context via the LoopBack `options` object to repository and connector calls:

```ts
async find(filter?: Filter<T>, options?: Options) {
  const correlation = (options as any)?.correlation;
  this.logger.info({ correlationId: correlation?.correlationId }, 'repo.find');
  return super.find(filter, options);
}
```

- The request `correlationId` is authoritative. If callers pass an existing `options.correlation.correlationId`, it is overwritten; the previous value is preserved as `options.correlation.upstreamCorrelationId` when present.
- Use `correlation.repositoryOptionsKey` to change the property name from `correlation` to another key.

#### Composition

- `composition.enforcement`: `'database'` (default, recommended) or `'application'` (opt-in depth-first cascade/restrict in code).
- `composition.defaultDeletePolicy`: `'restrict'` by default; used as the fallback policy for navigations in `composition.entitySets` (application mode only).
- `composition.entitySets`: per entity set relation policies, e.g. `{ Orders: { relations: { items: { delete: 'cascade' } } } }` (application mode only).
- `composition.requireTransactionSupport`: default `true`; when `true`, cascade deletes require datasource transactions for atomicity (application mode only).
- `composition.maxDepth` / `composition.maxEntities`: guardrails for application-enforced cascade planning/execution (application mode only).

### Event schema

Every telemetry record is emitted through the bound logger (`ODATA_BINDINGS.LOGGER`) and contains:

- `telemetryEvent`: machine-friendly slug (e.g., `apply-fallback`, `hook.before`, `tenant-throttle-check`, `batch.request`, `token.validation`).
- `telemetryCategory`: one of the categories listed above.
- `correlationId`: value taken from the configured header or auto-generated UUID.
- `sampled`: boolean indicating whether the current request was sampled for telemetry.
- Context-specific fields. Examples:
  - `apply-fallback`: `entitySet`, `reason`, `rows`, optional `plan` snapshot when enabled.
  - `hook.before` / `hook.after` / `hook.on`: `entitySet`, `operation`, `scope`, `hookName`, `durationMs`, `status`.
  - `tenant-throttle-check`: `tenantId`, `operation`, `result` (`allowed|rejected`), `reason` when rejected.
  - `batch.request`: `operationCount`, `changesetCount`, `maxPayloadBytes`, `durationMs`, `status`.
  - `token.validation`: `tokenType` (`skip|delta`), `status`, `reason` when validation fails.

Telemetry respects LoopBack’s logging pipeline—you can forward the enriched records to OpenTelemetry, Splunk, CloudWatch, etc.

## Roadmap

- [ ] Draft workflow for deep updates
- [ ] Additional `$apply` pushdown adapters (MSSQL, Mongo aggregation)
- [ ] Deep update / draft handling for composition hierarchies
- [ ] Lambda long-tail: lift current caps and cover remaining boolean/operator/function edge cases (beyond the current supported subset)
- [ ] Virtual/calculated field exposure with CSDL annotations

## Contributing

Contributions are welcome! Please open an issue or PR on GitHub.

Before sending a pull request:

- `npm run lint` to verify ESLint rules.
- `npm run lint:fix` or `npm run format` to apply the project formatting presets.
- `npm test` to run the unit and acceptance suites.

## License

MIT © Urartian LLC

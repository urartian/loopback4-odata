# @loopback/odata

An extension for [LoopBack 4](https://loopback.io/doc/en/lb4/) that adds **OData protocol support**.

- Auto-discovers OData controllers and generates CRUD routes.
- Exposes OData-style endpoints (`/Products(1)`) and OpenAPI-compliant ones (`/Products/{id}`).
- Provides `$metadata` endpoint.
- Simple developer experience with decorators.
- Advanced `$apply` support including chained transformations, navigation-path aggregates, and safe in-memory fallbacks when connector pushdown is unavailable.
- Streams `$batch` multipart payloads end-to-end, preserving binary sub-responses (PDFs, CSV exports, etc.) without re-encoding them (JSON batches base64-encode binary bodies and include their `Content-Type`).

Currently in **phase 4** — CRUD endpoints are stable and advanced features like `$expand`, `$count`, `$batch`, and Actions/Functions are available. Focus is now on rounding out the filter grammar, improving configurability, enriching the CSDL, and hardening path rewriting.

---

## Installation

```bash
npm install @loopback/odata
# if your application does not yet depend on LoopBack core packages:
npm install @loopback/core@^7 @loopback/repository@^8 @loopback/rest@^15 @loopback/boot@^8
```

> Requires Node.js 18.x or 20.x and the host application must supply compatible versions of `@loopback/boot`, `@loopback/core`, `@loopback/repository`, and `@loopback/rest` (the extension lists them as peer dependencies to avoid duplicate copies).

## Getting Started

1. Enable the component

In your application class:

```ts
import { ApplicationConfig } from '@loopback/core';
import { BootMixin } from '@loopback/boot';
import { RepositoryMixin } from '@loopback/repository';
import { RestApplication } from '@loopback/rest';
import { ODataComponent, ODATA_BINDINGS, ODataConfig } from '@loopback/odata';

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
import { Entity, model, property } from '@loopback/repository';
import { odataModel, odataController } from '@loopback/odata';

@odataModel({
  etag: 'updatedAt',
  delta: {
    enabled: true,
    field: 'updatedAt',
  },
})
@model()
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
@odataController(Product)
export class ProductODataController {}
```

That’s it — the extension generates repository-backed CRUD endpoints automatically.

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
import { ODATA_BINDINGS } from '@loopback/odata';

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

## Endpoints (Phase 3)

Start your app and test:

```bash
npm start
```

For a quick demo, run `npm run dev`; this boots the example app in `examples/basic-app`, with an in-memory datasource pre-seeded with sample products and orders so you can experiment with the query options immediately.

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

The parser keeps the lambda for post-processing while applying the remaining clauses (`price gt 1000`) to the database query. Lambdas currently support a single predicate per `$filter`, combined using `and`, and any/all across multi-segment navigation paths (for example, `orders/items/any(...)`).

### Searchable Fields

Control which fields participate in `$search`:

- Decorate properties with `@odataSearchable()` in your model.
- Or configure per–entity set in `ODataConfig.searchFields`.
- Default : `$search` is opt-in and uses only annotated fields. If no searchable fields are configured, strict mode returns `400 Bad Request`.
- Guardrails: cap inputs with `maxSearchTerms` (requests above the cap return `400 Bad Request`) and trim the evaluated field list with `maxSearchFields` so only the first N configured properties participate.

Example:

```ts
@odataModel()
@model()
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
- `returnType` sets the CSDL return type hint. Functions default to `Edm.String` when omitted.
- `rawResponse` skips the default OData annotations (like `@odata.context`/`@odata.etag`) so you can return a bespoke payload.

`params[].type` accepts either a literal EDM string (`'Edm.Guid'`, `'Collection(Edm.String)'`, etc.) or a LoopBack `@model()` constructor (pass the class or a factory such as `() => DecisionInput`). When you hand it a model the generator emits the referenced complex type in `$metadata`, so clients can discover the schema of your action payload without adding dummy properties to entities. Runtime requests are validated against the model definition, so unknown properties trigger `400 Bad Request` before your controller runs.

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
- Functions map to `GET /odata/Products/premiumProducts?minPrice=1000` and return a collection via GET.
- Set `rawResponse: true` in the decorator if you want to return a custom payload instead of the standard OData-formatted entity.
- Decorated operations are listed automatically in `$metadata` (CSDL) as bound/unbound actions and functions.

### Controller Hooks & Overrides

Declare OData hooks right inside your LB4 controller using `@odata.before`, `@odata.after`, and `@odata.on`. These attach to the generated CRUD routes for your model and let you implement `before/after` logic or fully override an operation.

Import from the package root:

```ts
import { odata, CrudHookContext, CrudOnContext } from '@loopback/odata';
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
import { Entity, model, property } from '@loopback/repository';
import { odataModel } from '@loopback/odata';

@odataModel({ entitySetName: 'Orders' })
@model()
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
import { odata, CrudHookContext } from '@loopback/odata';
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
@model()
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
- [x] any/all (lambdas): translate `<nav>/(any|all)(x: <expr>)` through relation repositories, support multi-segment paths, and allow additional predicates via `and` (nesting/multiple lambdas still pending)
- [x] Relational expansion via `$expand`
- [x] Inline and standalone `$count`
- [x] `$batch` endpoint (JSON and multipart/mixed)
- Transactions are attempted for changesets (`atomicityGroup`). The component now caches whether each entity set's datasource can open LoopBack transactions: connectors such as PostgreSQL/MySQL succeed, while the in-memory connector is marked as non-transactional the first time a client attempts an atomicity group. Once a datasource is confirmed non-transactional the controller refuses future atomicity groups touching that entity set without instantiating its repository. When a datasource lacks transactions the affected changeset is rejected up front with `501 Not Implemented` and a `BatchExecutionError`; omit `atomicityGroup` to accept best-effort processing or switch to a transactional connector for true atomicity. `$metadata` surfaces the service-wide capability via the EntityContainer annotation `Org.OData.Capabilities.V1.BatchSupported/ChangeSetsSupported` (set to `true` only when every registered entity set is backed by a transactional datasource) and per-entity-set hints via `LoopBack.V1.BatchCapabilities.ChangeSetsSupported`, so clients can decide whether to emit change sets globally or only for specific entity sets.
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
- [x] Capabilities annotations (filter functions, count/navigation restrictions, permissions, streams, insert/update/delete/search restrictions) to describe service behaviors to OData clients
- [x] Derived LoopBack models surface `$BaseType` so inheritance is reflected in the generated CSDL
- [x] Deep insert support for `hasOne`/`hasMany` relations (opt-in per entity set, multi-level traversal)
- [x] Navigation `$ref` endpoints for `hasOne`/`hasMany` relations (link/unlink existing entities)
- [x] OpenAPI visibility controls via per-model `documentInOpenApi` flags and global policies (`documentInOpenApiDefault`, `removeUndocumentedFromSpec`)

Queries can now combine boolean operators and phrases:

```http
GET /odata/Products?$search="coffee beans" AND grinder NOT decaf
```

The example above matches products that include the phrase "coffee beans", also mention "grinder", and omit anything containing "decaf".

String helpers such as `trim`/`concat` and date part functions (`month`, `day`, `hour`, `minute`, `second`) are processed automatically when `strict=false`. In strict mode these functions return `400 Bad Request` unless the backing connector provides native support.

## Configuration

Customize the OData component via `ODataConfig` bound at `odata.config` (the component registers a default). You can override it in your application before boot:

```ts
import { ODATA_BINDINGS } from '@loopback/odata';
import { ODataConfig } from '@loopback/odata';

// inside your app setup
this.bind(ODATA_BINDINGS.CONFIG).to({
  basePath: '/api/odata', // default: '/odata'
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

Per-entity guardrails can be applied through the registry definition. Entity-level limits override the global pagination block, allowing you to relax or tighten caps on a per-feed basis:

```ts
const ProductsSet: EntitySetDef<Product> = {
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

- `basePath`: Externally visible service root. All OData routes are served under this path (via middleware rewrite) while internal routes remain at `/odata`. Response metadata (`@odata.context`) uses this value.
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
- `$batch` atomicity detection is connector-aware: entity sets backed by datasources that expose `beginTransaction` (for example PostgreSQL or MySQL) are marked as transactional after the first successful changeset, while datasources without transactions (such as the in-memory connector) are marked as non-transactional and future atomicity groups targeting them are rejected immediately with `501 Not Implemented`. The generated CSDL advertises the service-wide capability (per spec) on the EntityContainer via `Org.OData.Capabilities.V1.BatchSupported/ChangeSetsSupported`, which flips to `true` only when every registered entity set is backed by a transactional datasource, and emits per-entity-set annotations under `LoopBack.V1.BatchCapabilities.ChangeSetsSupported` so tools can decide which entity sets allow change sets.
- `onDeltaTokenInvalid(event)`: Optional callback fired whenever a client supplies an expired, tampered, or mismatched `$deltatoken`. Useful for alerting/telemetry when secrets rotate.
- `tenantResolver(request)`: Function that extracts a tenant/customer identifier from an incoming request (for example `req.user?.tenantId` or `req.get('x-tenant-id')`). When combined with `tenantQuotas`, the server enforces per-tenant throttling. If the resolver throws, the request now fails fast with `400 TenantResolutionFailed` so malformed or malicious headers cannot fall back to the unrestricted default bucket.
- `tenantQuotas`: `{ maxRequestsPerMinute?: number; maxConcurrentRequests?: number; maxLeaseRefreshers?: number; overrides?: Record<string, { maxRequestsPerMinute?: number; maxConcurrentRequests?: number }> }`. Leave undefined to disable throttling or specify per-tenant overrides to grant premium customers higher limits. `maxLeaseRefreshers` caps how many concurrent lease refresh timers the server maintains globally (default 1000) so a burst of unique tenants cannot exhaust the process.
- `onLog(entry)`: Optional hook invoked for every log entry emitted by the OData component (`entry` includes `level`, `message`, `context`, and optional `error`). Use it to forward structured telemetry into your existing logging/monitoring pipeline. If you bind your own logger to `ODATA_BINDINGS.LOGGER` the hook still fires after the logger handles the entry.
- `documentInOpenApiDefault`: Controls whether generated OData routes appear in the published OpenAPI spec. The default `'auto'` policy documents entity sets that are also decorated with LoopBack's `@model()` and hides OData-only models. Set to `true` to publish every generated controller or `false` to hide everything unless a model opts in via `@odataModel({documentInOpenApi: true})`.
- `removeUndocumentedFromSpec`: When `true` (default), routes tagged with `x-visibility: 'undocumented'` are removed before `/openapi.json` is served. Set to `false` to keep them in the document; the spec enhancer retags them as `x-visibility: 'internal'` so tooling can filter them out.

#### Tenant throttling example

```ts
import { ODATA_BINDINGS } from '@loopback/odata';

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

- If a header is missing, traffic goes through the default bucket (`'default'`).
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
import { ODATA_BINDINGS, RedisTenantThrottleStore } from '@loopback/odata';

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
- `enableApplyPushdown`: Opt-in switch that negotiates `$apply` pushdown with each datasource. When enabled, supported connectors (currently PostgreSQL and MySQL/MariaDB) execute `groupby()/aggregate()` pipelines in the database. Combine with `@odataModel({applyPushdown: true})` or `EntitySetRegistry.register({applyPushdown: true})` for per-entity control.
- `maxExpandDepth`: Maximum allowed `$expand` nesting depth; requests that exceed it return `400 Bad Request`.
- `enableCount`:
  - When `false`, inline counts (`?$count=true`) return `400 Bad Request` with an OData error.
  - The standalone path (`GET <basePath>/<EntitySet>/$count`) returns `501 Not Implemented`.
- `csdlFormat`: Selects `$metadata` content type (`application/xml` vs `application/json`). JSON output now emits a standards-compliant CSDL JSON document.
- `namespace`: Overrides the CSDL schema namespace (`Default` by default). All generated types live under this namespace.
- `entityContainerName`: Controls the `<EntityContainer>` / JSON entity container name (`DefaultContainer` by default).
- `namespaceAlias`: Adds the optional `Alias` attribute to the CSDL schema so clients can refer to types using a short prefix.
- `capabilities`: Sets default service-level annotations such as supported filter functions, countability, permissions, stream support, and now OData capability records for inserts/updates/deletes/search via the `insertRestrictions`, `updateRestrictions`, `deleteRestrictions`, and `searchRestrictions` options. Values can be overridden per entity set via `EntitySetDef.capabilities`.
- `enableDeepInsert`: Opt-in global switch for accepting nested payloads (deep insert). When `true`, every entity set defaults to deep insert unless overridden per model. When `false` (default), only entity sets with `@odataModel({deepInsert: true})` participate.
- `enableDeepUpdate`: Opt-in global switch for deep updates (PATCH payloads containing related entities). Entity sets can override with `@odataModel({deepUpdate: true})` or `EntitySetRegistry.register({deepUpdate: true})`.
- `maxDeepInsertDepth`: Maximum recursion depth for deep insert traversal (default: `10`). Requests exceeding the limit are rejected with `400 Bad Request` to prevent runaway graphs.
- `maxDeepUpdateDepth`: Maximum recursion depth for deep update traversal (defaults to `maxDeepInsertDepth` when not set).
- `enableNavigationRefEndpoints`: Set to `false` to skip registration of navigation `$ref` routes if you prefer to manage linking manually (default: `true`).
- `$apply` pipelines support chained `filter`, `groupby`, `aggregate`, `orderby`, `skip`, and `top` stages, including navigation-path aggregates. By default the runtime executes these pipelines in memory; this carries CPU and memory overhead and should be reserved for small result sets. Opt into pushdown to keep heavy analytics inside the database.
- Lambda filters (`any` / `all`) support navigation collections (including multi-segment paths) and can be combined with additional predicates using `and`. Nesting lambdas, mixing multiple lambdas, or combining them with `or` remains unsupported.
- `strict` (default: true): Enables stricter validations and policies:
  - Requires `If-Match` on `PATCH`/`DELETE` when ETags are enabled (428 if missing).
  - If `maxTop` is set, `$top` above the cap returns `400 Bad Request` instead of being clamped.
  - Rejects unknown system query options (e.g., `$levels`, `$apply`) with `400 Bad Request`.
  - Validates `$select`, `$orderby`, `$filter` fields against model properties. Navigation segments still traverse declared relations and now structured (complex) properties are resolved segment-by-segment, so expressions such as `Customer/PrimaryAddress/City` stay valid while unknown members return `400 Bad Request`. Structured paths currently pass validation even though most connectors evaluate them in memory; SQL pushdown for nested properties will arrive in a future release.
  - Enforces content negotiation: `Accept` must allow `application/json` for CRUD; `$metadata` must allow `application/xml` (or JSON if configured); non‑JSON `Content-Type` on writes returns `415`.
  - Limits & safety: `maxExpandDepth` always enforces a hard ceiling (400 when exceeded); `maxSkip` still caps offsets and escalates from clamp to 400 when strict mode is enabled.
  - Search:
    - `searchMode`: `'annotated' | 'config-only' | 'all' | 'disabled'` (default: `annotated`)
    - `searchFields`: `{[entitySet: string]: string[]}` overrides decorator scope
    - `maxSearchFields` / `maxSearchTerms`: caps to prevent overly broad queries (exceeding `maxSearchTerms` now returns `400 Bad Request`)

Example: With `{basePath: '/api/odata', maxTop: 100, enableCount: false}`

- Routes mount at `/api/odata/...`.
- `GET /api/odata/Products?$top=1000` returns at most 100 records.
- `GET /api/odata/Products?$count=true` → `400 Bad Request` (unsupported option).
- `GET /api/odata/Products/$count` → `501 Not Implemented`.

Entity-set specific overrides are available via `EntitySetRegistry.register`:

- `capabilities`: refine or override filter functions, countability, navigation restrictions, permissions, or stream support for a single entity set.
- `hasStream`: mark the backing entity type as streaming (`Org.OData.Core.V1.HasStream`).
- `mediaField`, `mediaContentTypeField`, `mediaEtagField`, `mediaLengthField`, `mediaHandlerBindingKey`: see [Streaming Media Entities](#streaming-media-entities).

Both the global `capabilities` defaults and per-set overrides support the new `insertRestrictions`, `updateRestrictions`, `deleteRestrictions`, and `searchRestrictions` keys. Example: `insertRestrictions: {insertable: false, nonInsertableNavigationProperties: ['orders']}` emits `Org.OData.Capabilities.V1.InsertRestrictions`, while `searchRestrictions: {unsupportedExpressions: ['not']}` maps shorthand values (`and`, `or`, `not`, etc.) to the corresponding `Org.OData.Capabilities.V1.SearchExpressions/*` enum members.

### OpenAPI documentation visibility

Generated OData routes now annotate each operation with `x-odata-generated` and a `x-visibility` hint so you can decide which controllers appear in `/openapi.json`.

- With the default `documentInOpenApiDefault: 'auto'`, models that also use LoopBack's `@model()` decorator remain visible while controllers decorated only with `@odataModel()` are hidden.
- Opt in explicitly with `@odataModel({documentInOpenApi: true})`, or suppress documentation with `@odataModel({documentInOpenApi: false})` even when `@model()` is present.
- Override the global policy by binding `documentInOpenApiDefault` to `true` (publish every generated controller) or `false` (hide everything until a model opts in).

Hidden routes keep their metadata for internal tooling: when `removeUndocumentedFromSpec` is `true` they are stripped from `/openapi.json`; when `false` they stay in the document but are retagged with `x-visibility: 'internal'`.

```ts
@odataModel({ documentInOpenApi: true })
class CustomerDraft extends Entity {
  /* ... */
}

@odataModel({ documentInOpenApi: false })
@model()
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

- `mediaField`: Property name that stores the binary payload (Buffer/Uint8Array/Readable). When provided, the booter auto-registers a `PropertyBackedMediaHandler` that persists streams inside the entity itself.
- `mediaContentTypeField`: String property containing the MIME type returned by `$value` (e.g., `image/png`).
- `mediaEtagField`: Property holding the stream-specific ETag; enables conditional headers (`If-None-Match`, `If-Match`) for media operations.
- `mediaLengthField`: Numeric property storing the byte length; when set the controller emits `Content-Length` without fully buffering the stream.
- `mediaHandlerBindingKey`: Override the IoC binding key used to resolve the media handler (defaults to `ODATA_BINDINGS.MEDIA_HANDLERS.key.<EntitySet>`). Useful when multiple entity sets share a handler implementation.
- `mediaMaxPayloadBytes`: Maximum number of bytes the default property-backed handler buffers in memory before rejecting the upload (defaults to 10 MiB).

When `mediaEtagField` is configured the generated `$metadata` advertises `@Org.OData.Core.V1.MediaETag`, allowing clients to discover which property carries the stream ETag and rely on conditional caching headers automatically.

When handling uploads the controller prefers metadata reported by the `ODataMediaHandler` over the incoming HTTP headers. Handlers can return `contentType`, `length`, and `etag` from their `write()` result to override the stored values. This enables sniffing binary payloads server-side, emitting custom weak ETags, or correcting bogus `Content-Type`/`Content-Length` headers before persisting the entity’s metadata and `@odata.mediaContentType`.

When `mediaField` is configured the handler writes the uploaded stream directly into that property while enforcing `mediaMaxPayloadBytes` to guard against unbounded buffering. Make sure the backing column is a binary type in your datasource (e.g., PostgreSQL `bytea`, MySQL `LONGBLOB`, MSSQL `VARBINARY`). Use the connector-specific metadata to request the correct type:

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
- You can always bind your own handler to `def.mediaHandlerBindingKey` to integrate object storage, CDNs, etc. Custom handlers must implement the `ODataMediaHandler` interface exported from `src/services/odata-media-handler.ts`.

Example: property-backed storage that tracks MIME type/length/ETag on the entity:

```ts
@odataModel({
  hasStream: true,
  mediaField: 'data',
  mediaContentTypeField: 'contentType',
  mediaEtagField: 'mediaVersion',
  mediaLengthField: 'size',
})
@model()
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
} from '@loopback/odata';

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

When `enableDelta` is `true`, the first page of a collection includes an `@odata.deltaLink`. Clients can store that URL and call it later to retrieve only the entities that changed since the last sync. The implementation relies on each entity set having a stable change stamp (the first configured ETag property, or the field supplied via `@odataModel({delta: {field: ...}})` / `EntitySetDef.deltaField`). Delta links are signed with the same `tokenSecret`; tampering or using an expired token (see `deltaTokenTtl`) returns `400 Invalid $deltatoken`.

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

### `$apply` Pushdown (PostgreSQL & MySQL)

- Pushdown is **opt-in**. Out of the box, `$apply` executes in memory. This is functionally correct but resource intensive; enable pushdown for production workloads. Once enabled, the SQL executors keep entire pipelines (multiple `groupby`/`aggregate` stages plus `filter`, `orderby`, `skip`, `top`) inside the database, emitting native `HAVING`, `ORDER BY`, `LIMIT`, and `OFFSET`.
- Set `enableApplyPushdown: true` on `ODataConfig` to negotiate pushdown across datasources, or opt in per model with `@odataModel({applyPushdown: true})` / per entity set via `EntitySetRegistry.register({applyPushdown: true})`.
- PostgreSQL **and** MySQL/MariaDB are supported natively today. The extension inspects each repository datasource and, when it detects a compatible connector, routes aggregation pipelines through a SQL executor built on `dataSource.execute(...)`.
- Navigation aggregates are compiled into `LEFT JOIN` chains, so queries like `groupby((order/customer/country), aggregate(order/total with sum as TotalSpend))` continue to run server-side even when later stages reference aliases or regroup the intermediate result set. On MySQL the executor uses backticked identifiers and `?` placeholders, while PostgreSQL uses quoted identifiers and `$n` parameters.
- Stage-level pagination and filters stay in SQL. Post-aggregate `filter(...)` segments translate to `HAVING` clauses, and `skip`/`top` stages map to `OFFSET`/`LIMIT` inside each stage rather than being re-applied in memory.
- Telemetry hooks (`logApplyTelemetry: true` or a custom `onApplyFallback`) now capture per-stage execution mode, duration, row counts, and join counts so you can audit when a pipeline leaves the database.
- Table and column names are inferred automatically from the connector metadata (including the default lowercase conversion), so the usual LoopBack naming conventions work without additional annotations. Override the metadata only when you map models to non-standard table names.
- Unsupported scenarios automatically fall back to the in-memory executor. When `logApplyFallbacks` is enabled (or `onApplyFallback` is provided), additional events (`executor-declined`, `executor-error`, `missing-stage-filters`, `missing-stage-pagination`) surface whenever the pushdown path declines a request. Use these signals to monitor unexpected CPU/memory usage across both dialects.
- Capability metadata reflects reality: entity sets only emit `Org.OData.Capabilities.V1.ApplySupported` when pushdown is active, so BI clients can rely on the annotation.
- Custom connectors can participate by registering their own executor with `ODataApplyExecutorRegistry`. Executors decide at runtime whether they can satisfy a pipeline and can signal unsupported combinations by returning `undefined`, preserving the existing fallback behavior.

To try pushdown with the example app (requires PostgreSQL or MySQL running locally):

```bash
USE_MYSQL=true MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD=pass MYSQL_DATABASE=odata_dev \
ENABLE_APPLY_PUSHDOWN=true LOG_APPLY_TELEMETRY=true npm run dev
```

Or, for PostgreSQL:

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
  @model()
  export class Order extends Entity {
    @hasMany(() => OrderItem)
    items?: OrderItem[];
  }
  ```

- Force-enable deep insert for aggregates that do not meet the automatic detection criteria:

  ```ts
  @odataModel({ deepInsert: true })
  @model()
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
- BelongsTo and many-to-many (`through`) relations are not accepted inline; link/unlink via navigation `$ref` endpoints or foreign keys.

Validation notes:

- As with deep insert, collection navigation properties in PATCH must be arrays. A single object for a `hasMany` relation results in `422 Unprocessable Entity` with an Ajv detail entry like:

  ```json
  {
    "path": "/items",
    "code": "type",
    "message": "must be array"
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

or unlink it from the parent collection:

```http
DELETE /odata/Orders(9802)/items(20002)/$ref
```

For `hasOne`, use `PUT /EntitySet(key)/Relation/$ref` to link and `DELETE /EntitySet(key)/Relation/$ref` to clear the link. Relations defined with `hasManyThrough` are skipped.

For atomic multi-step graph changes (e.g., unlink + patch + insert), wrap the operations in a `$batch` atomic changeset.

Error handling:

- `DELETE /EntitySet(key)` returns `404 Not Found` when the entity does not exist.
- `DELETE /EntitySet(key)/Relation(key)/$ref` returns `404 Not Found` when the link does not exist (target missing, already unlinked, or linked to a different parent).

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
| `correlation.propagateToRepositories`          | Reserved for future use; when enabled, repository options will contain the correlation ID for downstream logging.                                                     |

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
- [ ] Opt-in cascade delete for composition-style relations (hook/transaction-aware)
- [ ] Rich lambda grammar with nested `any` / `all` and mixed logical operators
- [ ] Virtual/calculated field exposure with CSDL annotations
- [ ] Media stream and attachment handling via `$value` routes and `HasStream` entity sets
- [ ] Structured telemetry / debug mode for production monitoring (pushdown vs fallback, rewrite diagnostics, hook execution traces)

## Contributing

Contributions are welcome! Please open an issue or PR on GitHub.

Before sending a pull request:

- `npm run lint` to verify ESLint rules.
- `npm run lint:fix` or `npm run format` to apply the project formatting presets.
- `npm test` to run the unit and acceptance suites.

## License

MIT © Urartian LLC

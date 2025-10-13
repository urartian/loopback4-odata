# @loopback/odata

An extension for [LoopBack 4](https://loopback.io/doc/en/lb4/) that adds **OData protocol support**.  

- Auto-discovers OData controllers and generates CRUD routes.  
- Exposes OData-style endpoints (`/Products(1)`) and OpenAPI-compliant ones (`/Products/{id}`).  
- Provides `$metadata` endpoint.  
- Simple developer experience with decorators.  

Currently in **phase 4** — CRUD endpoints are stable and advanced features like `$expand`, `$count`, `$batch`, and Actions/Functions are available. Focus is now on rounding out the filter grammar, improving configurability, enriching the CSDL, and hardening path rewriting.  

---

## Installation

```bash
npm install @loopback/odata
```

## Getting Started

1. Enable the component

In your application class:

```ts
import {ApplicationConfig} from '@loopback/core';
import {BootMixin} from '@loopback/boot';
import {RepositoryMixin} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {ODataComponent} from '@loopback/odata';

export class MyAppApplication extends BootMixin(RepositoryMixin(RestApplication)) {
  constructor(options: ApplicationConfig = {}) {
    super(options);

    this.component(ODataComponent); // enable OData support
    // Register datasources and repositories once they are defined (see Step 3).
  }
}
```

2. Define a model

```ts
import {Entity, model, property} from '@loopback/repository';
import {odataModel, odataController} from '@loopback/odata';

@odataModel()
@model()
export class Product extends Entity {
  @property({id: true})
  id!: number;

  @property()
  name!: string;

  @property()
  price!: number;
}
```

3. Create a repository

The component expects a `DefaultCrudRepository` binding for each model decorated with `@odataController`. Provide a datasource and expose the repository via `RepositoryMixin`.

```ts
import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';

const ds = new juggler.DataSource({
  name: 'db',
  connector: 'memory',
});

export class ProductRepository extends DefaultCrudRepository<
  Product,
  typeof Product.prototype.id
> {
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
import {authenticate} from '@loopback/authentication';
import {authorize} from '@loopback/authorization';

@odataController(Product)
@authenticate('jwt')
@authorize({scopes: ['product.read']})
export class ProductODataController {
  // Stubbing a method is enough to apply fine-grained metadata.
  @authorize({scopes: ['product.summary']})
  async find() {}
}
```

Generated routes (list, findById, create, update, delete) will enforce the same strategies and scopes. `$batch` requests automatically reuse the caller’s headers and resolved user profile, so you don’t have to repeat credentials for each entry.

LoopBack’s built-in methods (`find`, `deleteById`, `updateById`, `replaceById`) are remapped to the OData CRUD handlers automatically. If you expose differently named controller methods, supply custom aliases when registering the entity set so the security metadata still flows through:

```ts
import {ODATA_BINDINGS} from '@loopback/odata';

const registry = await app.get(ODATA_BINDINGS.ENTITY_SET_REGISTRY);
registry.register({
  name: 'Products',
  modelCtor: Product,
  repositoryBindingKey: 'repositories.ProductRepository',
  securityMethodAliases: {
    deleteById: 'remove',
  },
});
```

## Endpoints (Phase 3)

Start your app and test:

```bash
npm start
```

For a quick demo, run `npm run dev`; this boots the example app in `examples/basic-app`, with an in-memory datasource pre-seeded with sample products and orders so you can experiment with the query options immediately.

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
    "and": [
      {"price": {"gt": 500}},
      {"name": {"neq": "Monitor"}}
    ]
  },
  "order": ["price DESC"],
  "limit": 5,
  "offset": 10,
  "fields": {"id": true, "name": true, "price": true}
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
    "name": {"like": "%Lap%", "escape": "\\"}
  }
}
```

```http
GET /odata/Products?$filter=startswith(code,'PR-')
```

```json
{
  "where": {
    "code": {"like": "PR-%", "escape": "\\"}
  }
}
```

```http
GET /odata/Products?$filter=endswith(category,'ware')
```

```json
{
  "where": {
    "category": {"like": "%ware", "escape": "\\"}
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
  "include": [
    {"relation": "customer"},
    {"relation": "items"}
  ]
}
```

`$expand` is also supported on single-entity requests (`/odata/Orders(1)?$expand=customer`). Unknown relation names result in a `400 Bad Request` response so clients get immediate feedback when requesting unsupported navigation properties.

> **Note:** OData identifiers are case-sensitive. Use the exact navigation property names exposed in `$metadata` (for example, `$expand=orders` not `$expand=Orders`).

Advanced filter helpers supported:

- Logical NOT

```http
GET /odata/Products?$filter=not price gt 100
```

```json
{"where": {"price": {"lte": 100}}}
```

- Numeric functions: `round`, `floor`, `ceiling`

```http
GET /odata/Products?$filter=round(price) eq 10
```

```json
{"where": {"and": [{"price": {"gte": 9.5}}, {"price": {"lt": 10.5}}]}}
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

Example:

```ts
@odataModel()
@model()
export class Product extends Entity {
  @property({id: true}) id!: number;
  @odataSearchable() @property() name!: string;
  @odataSearchable() @property() sku!: string;
  @property() price!: number;
}

// Or centrally via config
this.bind(ODATA_BINDINGS.CONFIG).to({
  searchMode: 'config-only',
  searchFields: {Products: ['name', 'sku']},
} as ODataConfig);
```

Enable inline counts by passing `$count=true` alongside other query options:

```http
GET /odata/Products?$filter=price gt 500&$count=true
```

Response:

```json
{
  "@odata.context": "/odata/$metadata#Products",
  "@odata.count": 12,
  "value": [
    {"id": 1, "name": "Laptop", "price": 1299}
  ]
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
    {"id": "1", "status": 200, "body": {"value": [{"id": 1, "name": "Laptop"}]}},
    {"id": "2", "status": 200, "body": {"value": []}},
    {"atomicityGroup": "changeset-1", "id": "3", "status": 201, "body": {"value": {"id": 4}}}
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

  @odataAction({binding: 'entity'})
  async discount(id: number, body: {percent: number}) {
    const entity = await this.products.findById(id);
    const percent = Number(body?.percent ?? 0);
    await this.products.updateById(id, {
      price: Number(entity.price ?? 0) * (1 - percent / 100),
    });
    return this.products.findById(id);
  }

  @odataFunction({binding: 'collection'})
  async premiumProducts(query: {minPrice?: string}) {
    const minPrice = Number(query?.minPrice ?? 1_000);
    return this.products.find({where: {price: {gte: minPrice}}});
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
import {odata, CrudHookContext, CrudOnContext} from '@loopback/odata';
```

Supported operations and scopes:
- Operations: `READ`, `CREATE`, `UPDATE`, `DELETE`
- Scopes for `READ`: `collection`, `entity`, `count`

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
    const items = await this.products.find({where: {featured: true}}, ctx.options);
    return ctx.helpers.collection(items);
  }
}
```

Notes:
- `before → on → after` is the execution order.
- `@odata.on` can replace the generated logic by not calling `next()`. Use `ctx.helpers.entity`, `ctx.helpers.collection`, `ctx.helpers.count`, or `ctx.helpers.noContent` to produce OData-correct responses when you override.
- Hooks receive `CrudHookContext` with `request`, `response`, `repository`, `options` (including active transactions for `$batch`), `payload/filter/id`, and a mutable `state` bag for passing data between phases.
- Only one `@odata.on` is allowed per operation/scope per controller; duplicates fail at boot.

#### Example: unbound action with a raw response

```ts
@odataAction({name: 'resetInventory', binding: 'unbound', params: [{name: 'confirm', type: 'Edm.Boolean'}], rawResponse: true})
async resetInventory(body: {confirm?: boolean}) {
  if (!body?.confirm) {
    throw new HttpErrors.BadRequest('Pass {"confirm": true} to reset inventory');
  }
  await this.products.updateAll({quantityOnHand: 0});
  return {status: 'ok'};
}
```

This action is exposed as `POST /odata/resetInventory`, surfaces in `$metadata` as an unbound action, and because `rawResponse` is set, the controller controls the full payload.

#### Example: virtual/computed properties

LoopBack models can advertise computed fields by marking them as non-persistent. The extension will list the field in `$metadata`, but you are responsible for calculating it at runtime and ignoring any client-supplied values.

```ts
// order.model.ts
import {Entity, model, property} from '@loopback/repository';
import {odataModel} from '@loopback/odata';

@odataModel({entitySetName: 'Orders'})
@model()
export class Order extends Entity {
  @property({id: true})
  id: string;

  @property({type: 'number', required: true})
  amount: number;

  @property({type: 'string', required: true})
  currency: string;

  @property({type: 'number', persist: false, jsonSchema: {readOnly: true}})
  totalWithTax?: number;
}
```

```ts
// order.odata-controller.ts
import {AnyObject, repository} from '@loopback/repository';
import {odata, CrudHookContext} from '@loopback/odata';
import {Order} from './order.model';
import {OrderRepository} from './order.repository';

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
    const payload = ctx.result as {value?: AnyObject[]};
    if (!payload?.value) return;
    payload.value = payload.value.map(item => addTotal(item));
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

## Optimistic Concurrency (ETags)

Add an ETag column to your LoopBack model and opt in by passing it to `@odataModel`. The property is typically a timestamp or version counter that you update whenever the record changes.

```ts
@odataModel({etag: 'updatedAt'})
@model()
export class Product extends Entity {
  @property({id: true})
  id!: number;

  @property()
  name!: string;

  @property()
  price!: number;

  @property({type: 'date', required: true, defaultFn: 'now'})
  updatedAt!: Date;
}
```

Keep the field fresh in your repository (for example, by stamping `updatedAt` in `create`/`update` hooks). The generated CRUD controller then:

- Emits `ETag: W/"…"` headers and `@odata.etag` payload metadata on `GET /odata/Products(…)`.
- Accepts optional `If-Match` headers on `PATCH`/`DELETE`. When present, the update succeeds only if the token still matches the stored value; stale tokens return `412 Precondition Failed`.
- Supports caching via `If-None-Match` on reads (`GET` responds `304 Not Modified` when the token matches).
- Treats related expansions the same way as SAP CAP: the ETag covers only the root entity unless you choose to update the parent token whenever child rows change.

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
- Transactions are attempted for changesets (`atomicityGroup`). If a datasource cannot begin a transaction (e.g. LoopBack's in-memory connector), the changeset is rejected with `501 Not Implemented` and a `BatchExecutionError`. Use a transactional connector or omit `atomicityGroup` to accept best-effort processing.
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
- [x] Deep insert support for `hasOne`/`hasMany` relations (opt-in per entity set)

Queries can now combine boolean operators and phrases:

```http
GET /odata/Products?$search="coffee beans" AND grinder NOT decaf
```

The example above matches products that include the phrase "coffee beans", also mention "grinder", and omit anything containing "decaf".

String helpers such as `trim`/`concat` and date part functions (`month`, `day`, `hour`, `minute`, `second`) are processed automatically when `strict=false`. In strict mode these functions return `400 Bad Request` unless the backing connector provides native support.

## Configuration

Customize the OData component via `ODataConfig` bound at `odata.config` (the component registers a default). You can override it in your application before boot:

```ts
import {ODATA_BINDINGS} from '@loopback/odata';
import {ODataConfig} from '@loopback/odata';

// inside your app setup
this.bind(ODATA_BINDINGS.CONFIG).to({
  basePath: '/api/odata',  // default: '/odata'
  csdlFormat: 'xml',       // 'xml' | 'json' (default 'xml')
  namespace: 'Catalog',    // default: 'Default'
  entityContainerName: 'CatalogService', // default: 'DefaultContainer'
  namespaceAlias: 'CatalogNS',
  capabilities: {
    filterFunctions: ['contains', 'startswith', 'endswith'],
    countable: true,
    aggregation: true,
  },
  maxTop: 100,             // server paging cap
  maxSkip: 1000,           // max skip allowed
  maxExpandDepth: 2,       // max $expand nesting depth
  enableCount: true,       // enable inline and standalone $count
  strict: true,            // enable strict validations (default: true)
} as ODataConfig);
```

- `basePath`: Externally visible service root. All OData routes are served under this path (via middleware rewrite) while internal routes remain at `/odata`. Response metadata (`@odata.context`) uses this value.
- `maxTop`: Caps `$top` for collection reads. The server may return fewer results than requested per OData v4. In strict mode, requests with `$top` above the cap return 400; otherwise the value is clamped to the maximum.
- `maxSkip`: Maximum allowed `$skip`. When strict mode is disabled, requests above the cap are clamped; with strict mode enabled they return `400 Bad Request`.
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
- `$apply` support currently covers a single `groupby((... ), aggregate(...))` segment with aggregate methods `sum`, `average`, `min`, `max`, `count`, and `countdistinct` on scalar entity properties. Pipelines with additional stages (`filter`, `orderby`, etc.) and aggregations on navigation properties are not yet available.
- Lambda filters (`any` / `all`) support navigation collections (including multi-segment paths) and can be combined with additional predicates using `and`. Nesting lambdas, mixing multiple lambdas, or combining them with `or` remains unsupported.
- `strict` (default: true): Enables stricter validations and policies:
  - Requires `If-Match` on `PATCH`/`DELETE` when ETags are enabled (428 if missing).
  - If `maxTop` is set, `$top` above the cap returns `400 Bad Request` instead of being clamped.
  - Rejects unknown system query options (e.g., `$levels`, `$apply`) with `400 Bad Request`.
  - Validates `$select`, `$orderby`, `$filter` fields against model properties; unknown fields return `400 Bad Request`.
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

Both the global `capabilities` defaults and per-set overrides support the new `insertRestrictions`, `updateRestrictions`, `deleteRestrictions`, and `searchRestrictions` keys. Example: `insertRestrictions: {insertable: false, nonInsertableNavigationProperties: ['orders']}` emits `Org.OData.Capabilities.V1.InsertRestrictions`, while `searchRestrictions: {unsupportedExpressions: ['not']}` maps shorthand values (`and`, `or`, `not`, etc.) to the corresponding `Org.OData.Capabilities.V1.SearchExpressions/*` enum members.

### Deep Insert

Enable deep insert globally:

```ts
this.bind(ODATA_BINDINGS.CONFIG).to({
  enableDeepInsert: true,
} as ODataConfig);
```

Or opt-in per model:

```ts
@odataModel({deepInsert: true})
@model()
export class Order extends Entity {
  // … define properties …
  @hasMany(() => OrderItem)
  items?: OrderItem[];
}
```

When enabled, `POST /odata/Orders` can include nested navigation data:

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

The controller persists the order and its items inside a single transaction and annotates `$metadata` with `Org.OData.Capabilities.V1.DeepInsertSupport` for the entity set.

## Roadmap

- [ ] Draft/deep insert workflow

## Contributing

Contributions are welcome! Please open an issue or PR on GitHub.

## License

MIT © Urartian LLC

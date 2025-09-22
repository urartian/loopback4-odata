# @loopback/odata

An extension for [LoopBack 4](https://loopback.io/doc/en/lb4/) that adds **OData protocol support**.  

- Auto-discovers OData controllers and generates CRUD routes.  
- Exposes OData-style endpoints (`/Products(1)`) and OpenAPI-compliant ones (`/Products/{id}`).  
- Provides `$metadata` endpoint.  
- Simple developer experience with decorators.  

Currently in **phase 4** — CRUD endpoints are stable and the first advanced feature (`$expand`) is available. Inline related models through LoopBack include filters while we continue building the remaining enterprise capabilities (`$count`, `$batch`, actions/functions, pluralization).  

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

## Endpoints (Phase 3)

Start your app and test:

```bash
npm start
```

For a quick demo, run `npm run dev`; the in-memory datasource comes pre-seeded with sample products and orders so you can experiment with the query options immediately.

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
  "value": {
    "id": 1,
    "name": "Laptop",
    "price": 1299
  }
}
```

##### Create

```bash
curl -X POST /odata/Products \
  -H 'Content-Type: application/json' \
  -d '{"name":"Laptop","price":1299}'
```

Returns the persisted entity in the body under `value`.

##### Update & Delete

```http
PATCH  /odata/Products/1
DELETE /odata/Products/1
```

`PATCH` accepts partial payloads, and `DELETE` responds with `204 No Content` once the repository removes the entity.

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

You can combine `$filter` (eq, ne, gt, ge, lt, le with `and`/`or`), `$orderby`, `$top`, `$skip`, and `$select` to shape the data returned by your repository queries.

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

## Features

- [x] OData-style entity paths (Products(1)) supported via middleware
- [x] Auto-discovery of OData controllers (Booter)
- [x] Registry of entity sets
- [x] CRUD controller factory backed by LoopBack repositories
- [x] $metadata endpoint with generated CSDL (including navigation properties for relations)
- [x] Basic query options → LoopBack filters (`$filter`, `$orderby`, `$top`, `$skip`, `$select`)
- [x] Relational expansion via `$expand`

## Roadmap

- [ ] Proper pluralization (using inflection)
- [ ] Inline & standalone `$count`
- [ ] `$batch` endpoint for multi-operation requests
- [ ] OData actions & functions decorators

## Contributing

Contributions are welcome! Please open an issue or PR on GitHub.

## License

MIT © Urartian LLC

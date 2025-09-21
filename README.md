# @loopback/odata

An extension for [LoopBack 4](https://loopback.io/doc/en/lb4/) that adds **OData protocol support**.  

- Auto-discovers OData controllers and generates CRUD routes.  
- Exposes OData-style endpoints (`/Products(1)`) and OpenAPI-compliant ones (`/Products/{id}`).  
- Provides `$metadata` endpoint.  
- Simple developer experience with decorators.  

Currently in **phase 2.1** — CRUD endpoints are backed by LoopBack repositories, metadata remains placeholder while the surface stabilises.  

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

## Endpoints (Phase 2.1)

Start your app and test:

```bash
npm start
```

##### Metadata

```bash
GET /odata/$metadata
```
Returns placeholder CSDL XML.

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

## Features

- [x] OData-style entity paths (Products(1)) supported via middleware
- [x] Auto-discovery of OData controllers (Booter)
- [x] Registry of entity sets
- [x] CRUD controller factory backed by LoopBack repositories
- [x] $metadata endpoint (placeholder)

## Roadmap

- [ ] Rich query support: $filter, $orderby, $top, $skip, …
- [ ] Real CSDL metadata generator
- [ ] Proper pluralization (using inflection)
- [ ] Advanced OData features: navigation properties, $expand, batch requests

## Contributing

Contributions are welcome! Please open an issue or PR on GitHub.

## License

MIT © Urartian LLC

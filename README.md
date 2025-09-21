# @loopback/odata

An extension for [LoopBack 4](https://loopback.io/doc/en/lb4/) that adds **OData protocol support**.  

- Auto-discovers OData controllers and generates CRUD routes.  
- Exposes OData-style endpoints (`/Products(1)`) and OpenAPI-compliant ones (`/Products/{id}`).  
- Provides `$metadata` endpoint.  
- Simple developer experience with decorators.  

Currently in **early phase (1.2)** — CRUD stubs only, metadata is placeholder, but the foundation is ready.  

---

## Installation

```bash
npm install @loopback/odata
```

## Getting Started

1. Enable the component

In your application class:

```ts
import {ODataComponent} from '@loopback/odata';

export class MyAppApplication extends BootMixin(RestApplication) {
  constructor(options: ApplicationConfig = {}) {
    super(options);

    this.component(ODataComponent); // ✅ enable OData support
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

3. Add a controller

```ts
@odataController(Product)
export class ProductODataController {}
```

That’s it — the extension generates CRUD endpoints automatically.

## Endpoints (Phase 1.2)

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
  "value": ["This would return all Products"]
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
  "value": "This would return Products with id=1"
}
```

##### Create, Update, Delete

```http
POST   /odata/Products
PATCH  /odata/Products/1
DELETE /odata/Products/1
```

Currently return stub messages.

## Features

- [x] OData-style entity paths (Products(1)) supported via middleware
- [x] Auto-discovery of OData controllers (Booter)
- [x] Registry of entity sets
- [x] CRUD controller factory (stub)
- [x] $metadata endpoint (placeholder)

## Roadmap

- [ ] Repository integration (CRUD backed by LB4 repositories)
- [ ] $filter, $orderby, $top, $skip, … query support
- [ ] Real CSDL metadata generator
- [ ] Proper pluralization (using inflection)
- [ ] Advanced OData features: navigation properties, $expand, batch requests

## Contributing

Contributions are welcome! Please open an issue or PR on GitHub.

## License

MIT © Urartian LLC




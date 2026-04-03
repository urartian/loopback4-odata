# Getting Started

This guide walks through the fastest path to a working OData endpoint in a LoopBack 4 app using `@loopback/odata`.

You will:

- install the package and required LoopBack peers
- enable `ODataComponent`
- define one OData model
- add a datasource and repository
- register an OData controller
- start the app and verify the generated endpoints

The main path in this guide uses the in-memory connector so you can be running in a few minutes. For production deployments, the supported SQL path for v1 is PostgreSQL.

## Prerequisites

- Node.js 18.x or 20.x
- A LoopBack 4 application
- Compatible versions of:
  - `@loopback/boot`
  - `@loopback/core`
  - `@loopback/repository`
  - `@loopback/rest`

## 1. Install the package

```bash
npm install @loopback/odata
npm install @loopback/core@^7 @loopback/repository@^8 @loopback/rest@^15 @loopback/boot@^8
```

## 2. Enable the component

Register the component inside your application class and bind a token secret.

```ts
import {ApplicationConfig} from '@loopback/core';
import {BootMixin} from '@loopback/boot';
import {RepositoryMixin} from '@loopback/repository';
import {RestApplication} from '@loopback/rest';
import {ODATA_BINDINGS, ODataComponent, ODataConfig} from '@loopback/odata';

export class MyAppApplication extends BootMixin(RepositoryMixin(RestApplication)) {
  constructor(options: ApplicationConfig = {}) {
    super(options);

    this.component(ODataComponent);

    const current = this.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    this.bind(ODATA_BINDINGS.CONFIG).to({
      ...current,
      tokenSecret: process.env.ODATA_TOKEN_SECRET ?? current.tokenSecret,
    });
  }
}
```

In production, you must set `ODATA_TOKEN_SECRET`. In development, the component generates a temporary secret automatically if none is configured.

## 3. Define a model

Decorate the model with `@odataModel()`. You still use LoopBack property and relation decorators as usual.

```ts
import {Entity, property} from '@loopback/repository';
import {odataModel} from '@loopback/odata';

@odataModel({
  lbModel: {settings: {strict: true}},
  etag: 'updatedAt',
})
export class Product extends Entity {
  @property({id: true, generated: true})
  id!: number;

  @property({required: true})
  name!: string;

  @property({required: true})
  price!: number;

  @property({type: 'date', required: true, defaultFn: 'now'})
  updatedAt!: Date;
}
```

## 4. Add a datasource and repository

For the quickest start, use the in-memory connector first.

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

Register the datasource and repository in the application constructor:

```ts
this.dataSource(ds);
this.repository(ProductRepository);
```

## 5. Add an OData controller

Register a controller for the model. The component generates the repository-backed OData routes automatically.

```ts
import {odataController} from '@loopback/odata';

@odataController(Product)
export class ProductODataController {}
```

## 6. Start the app

Run your LoopBack application the same way you normally do.

Example:

```bash
npm start
```

If you want a working reference app from this repository, see [examples/basic-app/index.ts](/workspace/examples/basic-app/index.ts).

## 7. Verify the generated endpoints

Once the app is running, check:

- `GET /odata`
- `GET /odata/$metadata`
- `GET /odata/Products`

Example:

```bash
curl http://127.0.0.1:3000/odata
curl http://127.0.0.1:3000/odata/\$metadata
curl http://127.0.0.1:3000/odata/Products
```

If everything is wired correctly, you should see:

- a service document from `/odata`
- generated CSDL metadata from `/odata/$metadata`
- a collection response from `/odata/Products`

## 8. Optional: switch to PostgreSQL

For v1, PostgreSQL is the supported SQL path.

At a minimum you will need:

- a PostgreSQL datasource configuration
- model metadata for any connector-specific column types you use
- `ENABLE_APPLY_PUSHDOWN=true` if you want database-backed `$apply` execution

The repository example app in this repo already includes a PostgreSQL path in [examples/basic-app/index.ts](/workspace/examples/basic-app/index.ts).

## Next steps

After the basic setup is working, continue with:

- advanced configuration in [README.md](/workspace/README.md)
- performance guidance in [benchmarks/README.md](/workspace/benchmarks/README.md)
- generated API reference in [docs/api/index.html](/workspace/docs/api/index.html)

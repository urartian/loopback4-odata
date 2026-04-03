# Client Integration Example

This guide shows how to consume the service as a generic HTTP/OData client.

It does not assume a specific frontend, mobile stack, or BI tool. The goal is to show the protocol flow you can adapt in any client:

- discover the service
- read metadata
- fetch entities
- follow `@odata.nextLink`
- request counts
- run a simple `$apply`
- update with ETags
- optionally read a `$value` stream

The examples use plain HTTP so they transfer cleanly to browsers, Node.js, mobile apps, scripts, and backend integrations.

## 1. Discover the service

Start with the service document:

```bash
curl http://127.0.0.1:3000/odata
```

Typical response shape:

```json
{
  "@odata.context": "http://127.0.0.1:3000/odata/$metadata",
  "value": [
    {"name": "Products", "kind": "EntitySet", "url": "Products"}
  ]
}
```

Use this to find the top-level resources your client can browse.

## 2. Read `$metadata`

Next, fetch metadata:

```bash
curl http://127.0.0.1:3000/odata/\$metadata
```

Clients use this document to discover:

- entity types and properties
- navigation properties
- actions and functions
- capability annotations
- stream support

If you are building a dynamic client, `$metadata` is the source of truth.

## 3. Read a collection

Fetch a small page of data:

```bash
curl "http://127.0.0.1:3000/odata/Products?\$top=20"
```

Typical response shape:

```json
{
  "@odata.context": "/odata/$metadata#Products",
  "value": [
    {"id": 1, "name": "Laptop", "price": 1299}
  ]
}
```

## 4. Follow `@odata.nextLink`

Collection feeds use server-driven paging by default.

Example:

```json
{
  "@odata.context": "/odata/$metadata#Products",
  "value": [
    {"id": 1, "name": "Laptop", "price": 1299},
    {"id": 2, "name": "Phone", "price": 799}
  ],
  "@odata.nextLink": "/odata/Products?$skiptoken=v3:eyJ2Ijoi..."
}
```

When your client sees `@odata.nextLink`, follow it as-is:

```bash
curl "http://127.0.0.1:3000/odata/Products?\$skiptoken=v3:eyJ2Ijoi..."
```

Recommended client behavior:

- prefer `@odata.nextLink` over inventing your own `$skip`
- treat the token as opaque
- do not parse or modify the signed `$skiptoken`

## 5. Request counts

Inline count:

```bash
curl "http://127.0.0.1:3000/odata/Products?\$top=20&\$count=true"
```

Standalone count:

```bash
curl http://127.0.0.1:3000/odata/Products/\$count
```

Use this when your client needs record totals for pagination UI or dashboards.

## 6. Run an analytical `$apply`

For aggregation workloads:

```bash
curl "http://127.0.0.1:3000/odata/OrderItems?\$apply=groupby((order/customer/country),aggregate(order/total%20with%20sum%20as%20TotalSpend))"
```

For production analytics, the service should enable PostgreSQL `$apply` pushdown so the work stays in the database.

## 7. Read an entity and capture its ETag

If the model uses optimistic concurrency, the server returns an ETag header and `@odata.etag`.

Example:

```bash
curl -i http://127.0.0.1:3000/odata/Products\(1\)
```

Look for:

- `ETag: W/"..."`
- `@odata.etag` in the JSON body

Store that value in the client if you plan to update or delete the entity safely.

## 8. Update with `If-Match`

Use `PATCH` for scalar or JSON property updates:

```bash
curl -X PATCH \
  http://127.0.0.1:3000/odata/Products\(1\) \
  -H 'Content-Type: application/json' \
  -H 'If-Match: W/"id=1&updatedAt=2026-04-03T08%3A00%3A00.000Z"' \
  -d '{"price": 1399}'
```

Important behavior:

- missing `If-Match` may return `428 Precondition Required` when ETags are enforced
- stale `If-Match` returns `412 Precondition Failed`
- `PATCH` is the correct route for regular entity updates

If your client prefers minimal write responses:

```bash
curl -X PATCH \
  http://127.0.0.1:3000/odata/Products\(1\) \
  -H 'Content-Type: application/json' \
  -H 'If-Match: W/"..."' \
  -H 'Prefer: return=minimal' \
  -d '{"price": 1399}'
```

## 9. Optionally read a media stream

For streaming entities or stream properties, clients can read `$value`:

```bash
curl http://127.0.0.1:3000/odata/MediaAssets\(1\)/\$value
```

If stream ETags are configured, clients may also use:

- `If-None-Match` for cache revalidation
- `If-Match` for protected writes

Keep media handling separate from scalar updates:

- use `PATCH` for entity properties
- use `$value` routes for stream content

## 10. Optional: consume from JavaScript

Here is a minimal `fetch` example:

```ts
const serviceRoot = 'http://127.0.0.1:3000/odata';

async function listProducts() {
  const res = await fetch(`${serviceRoot}/Products?$top=20`);
  const body = await res.json();

  console.log(body.value);

  if (body['@odata.nextLink']) {
    const next = await fetch(`http://127.0.0.1:3000${body['@odata.nextLink']}`);
    const nextPage = await next.json();
    console.log(nextPage.value);
  }
}

async function updateProduct(id: number, etag: string) {
  const res = await fetch(`${serviceRoot}/Products(${id})`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'if-match': etag,
      prefer: 'return=minimal',
    },
    body: JSON.stringify({price: 1399}),
  });

  if (!res.ok) {
    throw new Error(`update failed: ${res.status}`);
  }
}
```

## Recommended client rules

For robust integrations:

- use `/odata` and `/odata/$metadata` for discovery
- treat `@odata.nextLink` as opaque
- honor ETags for updates and deletes
- use `$count` only when the UI or workflow really needs it
- use `$apply` for aggregation rather than fetching raw rows and aggregating client-side
- keep large media uploads out of the default property-backed path

## Related docs

- [docs/getting-started.md](/workspace/docs/getting-started.md)
- [docs/bi-interoperability.md](/workspace/docs/bi-interoperability.md)
- [docs/database-postgresql.md](/workspace/docs/database-postgresql.md)
- [README.md](/workspace/README.md)

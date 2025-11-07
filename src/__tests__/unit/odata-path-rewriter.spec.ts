/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { odataPathRewriter, MAX_KEY_EXPRESSION_LENGTH } from '../../middleware/odata-path-rewriter';

function createContext(url: string) {
  return {
    request: { url },
    response: {},
  } as any;
}

describe('odataPathRewriter middleware', () => {
  it('normalizes GUID literals with single quotes', async () => {
    const ctx = createContext('/odata/Books(%278421b8a0-9f83-11f0-ba47-775cb334843e%27)');
    let called = false;
    await odataPathRewriter(ctx, () => {
      called = true;
      return Promise.resolve();
    });
    assert.equal(called, true);
    assert.equal(ctx.request.url, '/odata/Books/8421b8a0-9f83-11f0-ba47-775cb334843e');
  });

  it('removes guid literal prefix and quotes', async () => {
    const ctx = createContext('/odata/Books(guid%278421b8a0-9f83-11f0-ba47-775cb334843e%27)/genre');
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Books/8421b8a0-9f83-11f0-ba47-775cb334843e/genre');
  });

  it('leaves numeric keys untouched', async () => {
    const ctx = createContext('/odata/Products(42)');
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Products/42');
  });

  it('unescapes doubled single quotes inside string keys', async () => {
    const ctx = createContext('/odata/Orders(%27O%27%27Brien%27)');
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Orders/O%27Brien');
  });

  it('supports named key predicates', async () => {
    const ctx = createContext('/odata/Products(ID=%27123%27)');
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Products/ID%3D123');
  });

  it('rewrites composite keys with string values', async () => {
    const ctx = createContext("/odata/Orders(OrderID=10248,CustomerID='ALFKI')/items");
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Orders/OrderID%3D10248%2CCustomerID%3DALFKI/items');
  });

  it('supports positional composite keys', async () => {
    const ctx = createContext("/odata/Composite(10248,'ALFKI')");
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Composite/10248%2CALFKI');
  });

  it('handles positional values that contain closing parentheses', async () => {
    const ctx = createContext("/odata/Legacy(10248,'Line)1')");
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Legacy/10248%2CLine)1');
  });

  it('handles nested parentheses inside quoted keys', async () => {
    const ctx = createContext("/odata/Foos(Key='A(()B)')");
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Foos/Key%3DA(()B)');
  });

  it('rewrites literals containing encoded slashes and equals', async () => {
    const ctx = createContext("/odata/Products(Name='A%2FB%3D42')");
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Products/Name%3DA%2FB%3D42');
  });

  it('leaves malformed segments without closing parenthesis untouched', async () => {
    const ctx = createContext('/odata/Products(42');
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/Products(42');
  });

  it('skips rewriting when key expression exceeds length limits', async () => {
    const longLiteral = 'a'.repeat(MAX_KEY_EXPRESSION_LENGTH + 10);
    const ctx = createContext(`/odata/Large('${longLiteral}')`);
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, `/odata/Large('${longLiteral}')`);
  });

  it('preserves segments without key predicates', async () => {
    const ctx = createContext('/odata/$metadata');
    await odataPathRewriter(ctx, () => Promise.resolve());
    assert.equal(ctx.request.url, '/odata/$metadata');
  });
});

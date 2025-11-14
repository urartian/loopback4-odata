/// <reference path="../../types/testing.globals.d.ts" />

import { strict as assert } from 'assert';
import { rewriteODataUrl, MAX_KEY_EXPRESSION_LENGTH } from '../../middleware/odata-path-rewriter';

describe('odataPathRewriter', () => {
  it('normalizes GUID literals with single quotes', async () => {
    const rewritten = rewriteODataUrl('/odata/Books(%278421b8a0-9f83-11f0-ba47-775cb334843e%27)');
    assert.equal(rewritten, '/odata/Books/8421b8a0-9f83-11f0-ba47-775cb334843e');
  });

  it('removes guid literal prefix and quotes', async () => {
    const rewritten = rewriteODataUrl(
      '/odata/Books(guid%278421b8a0-9f83-11f0-ba47-775cb334843e%27)/genre',
    );
    assert.equal(rewritten, '/odata/Books/8421b8a0-9f83-11f0-ba47-775cb334843e/genre');
  });

  it('leaves numeric keys untouched', async () => {
    const rewritten = rewriteODataUrl('/odata/Products(42)');
    assert.equal(rewritten, '/odata/Products/42');
  });

  it('unescapes doubled single quotes inside string keys', async () => {
    const rewritten = rewriteODataUrl('/odata/Orders(%27O%27%27Brien%27)');
    assert.equal(rewritten, '/odata/Orders/O%27Brien');
  });

  it('supports named key predicates', async () => {
    const rewritten = rewriteODataUrl('/odata/Products(ID=%27123%27)');
    assert.equal(rewritten, '/odata/Products/ID%3D123');
  });

  it('rewrites composite keys with string values', async () => {
    const rewritten = rewriteODataUrl("/odata/Orders(OrderID=10248,CustomerID='ALFKI')/items");
    assert.equal(rewritten, '/odata/Orders/OrderID%3D10248%2CCustomerID%3DALFKI/items');
  });

  it('supports positional composite keys', async () => {
    const rewritten = rewriteODataUrl("/odata/Composite(10248,'ALFKI')");
    assert.equal(rewritten, '/odata/Composite/10248%2CALFKI');
  });

  it('handles positional values that contain closing parentheses', async () => {
    const rewritten = rewriteODataUrl("/odata/Legacy(10248,'Line)1')");
    assert.equal(rewritten, '/odata/Legacy/10248%2CLine)1');
  });

  it('handles nested parentheses inside quoted keys', async () => {
    const rewritten = rewriteODataUrl("/odata/Foos(Key='A(()B)')");
    assert.equal(rewritten, '/odata/Foos/Key%3DA(()B)');
  });

  it('rewrites literals containing encoded slashes and equals', async () => {
    const rewritten = rewriteODataUrl("/odata/Products(Name='A%2FB%3D42')");
    assert.equal(rewritten, '/odata/Products/Name%3DA%2FB%3D42');
  });

  it('leaves malformed segments without closing parenthesis untouched', async () => {
    const rewritten = rewriteODataUrl('/odata/Products(42');
    assert.equal(rewritten, '/odata/Products(42');
  });

  it('skips rewriting when key expression exceeds length limits', async () => {
    const longLiteral = 'a'.repeat(MAX_KEY_EXPRESSION_LENGTH + 10);
    const rewritten = rewriteODataUrl(`/odata/Large('${longLiteral}')`);
    assert.equal(rewritten, `/odata/Large('${longLiteral}')`);
  });

  it('preserves segments without key predicates', async () => {
    const rewritten = rewriteODataUrl('/odata/$metadata');
    assert.equal(rewritten, '/odata/$metadata');
  });

  it('converts canonical function calls into query parameters', () => {
    const rewritten = rewriteODataUrl('/odata/Products(1)/Default.CalculateTax(rate=0.05)', {
      namespace: 'Default',
    });
    assert.equal(rewritten, '/odata/Products/1/CalculateTax?rate=0.05');
  });

  it('preserves canonical function calls without parameters', () => {
    const rewritten = rewriteODataUrl('/odata/Products(1)/Default.Ping()', {
      namespace: 'Default',
    });
    assert.equal(rewritten, '/odata/Products/1/Ping');
  });

  it('merges canonical function parameters with existing queries', () => {
    const rewritten = rewriteODataUrl(
      '/odata/Products(1)/Default.CalculateTax(rate=0.05)?$format=json',
      { namespace: 'Default' },
    );
    assert.equal(rewritten, '/odata/Products/1/CalculateTax?$format=json&rate=0.05');
  });

  it('preserves explicit namespaces when rewriting canonical functions', () => {
    const rewritten = rewriteODataUrl('/odata/Products(1)/Contoso.Sales.CalculateTax(rate=0.05)', {
      namespace: 'Default',
    });
    assert.equal(rewritten, '/odata/Products/1/Contoso.Sales.CalculateTax?rate=0.05');
  });

  it('strips canonical string literal quotes when building query parameters', () => {
    const rewritten = rewriteODataUrl("/odata/Products(1)/Default.Lookup(code='ABC''123')", {
      namespace: 'Default',
    });
    assert.equal(rewritten, '/odata/Products/1/Lookup?code=ABC%27123');
  });
});

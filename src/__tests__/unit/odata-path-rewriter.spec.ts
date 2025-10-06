/// <reference path="../../types/testing.globals.d.ts" />

import {strict as assert} from 'assert';
import {odataPathRewriter} from '../../middleware/odata-path-rewriter';

function createContext(url: string) {
  return {
    request: {url},
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
});


import 'reflect-metadata';
import { Application } from '@loopback/core';
import { expect } from '@loopback/testlab';
import { ODataComponent } from '../../component';
import { ODATA_BINDINGS } from '../../keys';
import { DEFAULT_TOKEN_SECRET } from '../../constants';
import { ODataConfig } from '../../types';

describe('ODataComponent token secret configuration', () => {
  const originalEnv = process.env.ODATA_TOKEN_SECRET;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ODATA_TOKEN_SECRET;
    } else {
      process.env.ODATA_TOKEN_SECRET = originalEnv;
    }
  });

  it('uses ODATA_TOKEN_SECRET from the environment when provided', () => {
    process.env.ODATA_TOKEN_SECRET = 'env-secret';
    const app = new Application();
    app.component(ODataComponent);
    const config = app.getSync<ODataConfig>(ODATA_BINDINGS.CONFIG);
    expect(config.tokenSecret).to.equal('env-secret');
  });

  it('falls back to the placeholder token secret when no env override exists', () => {
    delete process.env.ODATA_TOKEN_SECRET;
    const app = new Application();
    app.component(ODataComponent);
    const config = app.getSync<ODataConfig>(ODATA_BINDINGS.CONFIG);
    expect(config.tokenSecret).to.equal(DEFAULT_TOKEN_SECRET);
  });
});

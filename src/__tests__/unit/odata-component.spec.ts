import 'reflect-metadata';
import { Application } from '@loopback/core';
import { expect, sinon } from '@loopback/testlab';
import { ODataComponent } from '../../component';
import { ODATA_BINDINGS } from '../../keys';
import { ODataConfig } from '../../types';

describe('ODataComponent token secret configuration', () => {
  const originalTokenSecret = process.env.ODATA_TOKEN_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOdataEnv = process.env.ODATA_ENV;
  let consoleInfoStub: sinon.SinonStub;

  afterEach(() => {
    if (originalTokenSecret === undefined) {
      delete process.env.ODATA_TOKEN_SECRET;
    } else {
      process.env.ODATA_TOKEN_SECRET = originalTokenSecret;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalOdataEnv === undefined) {
      delete process.env.ODATA_ENV;
    } else {
      process.env.ODATA_ENV = originalOdataEnv;
    }
    consoleInfoStub?.restore();
  });

  it('uses ODATA_TOKEN_SECRET from the environment when provided', () => {
    process.env.ODATA_TOKEN_SECRET = 'env-secret';
    process.env.ODATA_ENV = 'production';
    const app = new Application();
    app.component(ODataComponent);
    const config = app.getSync<ODataConfig>(ODATA_BINDINGS.CONFIG);
    expect(config.tokenSecret).to.equal('env-secret');
  });

  it('auto-generates a random secret and logs guidance in non-production environments', () => {
    delete process.env.ODATA_TOKEN_SECRET;
    process.env.ODATA_ENV = 'development';
    consoleInfoStub = sinon.stub(console, 'info');

    const app = new Application();
    app.component(ODataComponent);
    const config = app.getSync<ODataConfig>(ODATA_BINDINGS.CONFIG);
    expect(config.tokenSecret).to.be.String();
    expect(config.tokenSecret).to.have.length(64);
    expect(consoleInfoStub.calledWithMatch(/Generated per-boot OData token secret/)).to.be.true();
  });

  it('fails fast in production when the token secret is missing', () => {
    delete process.env.ODATA_TOKEN_SECRET;
    process.env.ODATA_ENV = 'production';
    const app = new Application();
    expect(() => app.component(ODataComponent)).to.throw(/ODATA_TOKEN_SECRET is required/);
  });
});

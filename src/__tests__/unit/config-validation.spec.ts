import 'reflect-metadata';
import { expect } from '@loopback/testlab';
import { validateODataConfig, validatePaginationLimits } from '../../util/config-validation';
import { ODataConfig } from '../../types';
import { EntitySetRegistry } from '../../registry/entityset-registry';
import { ODataConfigValidatorObserver } from '../../observers/odata-config.validator';
import { DEFAULT_TOKEN_SECRET } from '../../constants';
import { ODataLogger } from '../../keys';

describe('OData config validation', () => {
  it('normalizes numeric strings and accepts positive values', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      pageSize: '25' as unknown as number,
      skipTokenTtl: '120' as unknown as number,
      pagination: {
        maxPageSize: '10' as unknown as number,
      },
    };

    validateODataConfig(config);

    expect(config.pageSize).to.equal(25);
    expect(config.skipTokenTtl).to.equal(120);
    expect(config.pagination?.maxPageSize).to.equal(10);
  });

  it('throws for non-positive guardrail values', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      pageSize: 0,
    };

    expect(() => validateODataConfig(config)).to.throw(/ODataConfig\.pageSize/);
  });

  it('throws for invalid entity pagination overrides', () => {
    expect(() =>
      validatePaginationLimits('EntitySet "Products".pagination', { maxTop: -5 }),
    ).to.throw(/EntitySet "Products"\.pagination\.maxTop/);
  });

  it('requires tokenSecret to be configured', () => {
    expect(() => validateODataConfig({} as ODataConfig)).to.throw(/tokenSecret/);
    expect(() => validateODataConfig({ tokenSecret: '   ' } as unknown as ODataConfig)).to.throw(
      /tokenSecret/,
    );
  });
});

describe('ODataConfigValidatorObserver warnings', () => {
  it('warns when the placeholder token secret is used', async () => {
    const config: ODataConfig = { tokenSecret: DEFAULT_TOKEN_SECRET };
    const registry = new EntitySetRegistry();
    const logger = new LoggerStub();
    const observer = new ODataConfigValidatorObserver(config, registry, logger);

    await observer.start();

    expect(logger.warnings).to.have.length(1);
    expect(logger.warnings[0].message).to.match(/tokenSecret/i);
  });

  it('does not warn when token secret is customized', async () => {
    const config: ODataConfig = { tokenSecret: 'custom-secret' };
    const registry = new EntitySetRegistry();
    const logger = new LoggerStub();
    const observer = new ODataConfigValidatorObserver(config, registry, logger);

    await observer.start();

    expect(logger.warnings).to.have.length(0);
  });

  class LoggerStub implements ODataLogger {
    warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    trace(_message: string, _context?: Record<string, unknown>): void {}
    debug(_message: string, _context?: Record<string, unknown>): void {}
    info(_message: string, _context?: Record<string, unknown>): void {}
    warn(message: string, context?: Record<string, unknown>) {
      this.warnings.push({ message, context });
    }
    error(_message: string, _context?: Record<string, unknown>, _error?: Error): void {}
  }
});

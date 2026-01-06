import 'reflect-metadata';
import { expect } from '@loopback/testlab';
import { validateODataConfig, validatePaginationLimits } from '../../util/config-validation';
import { ODataConfig } from '../../types';

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

  it('throws for invalid filter guardrails', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      filter: { maxInListItems: 0 },
    };

    expect(() => validateODataConfig(config)).to.throw(/ODataConfig\.filter\.maxInListItems/);
  });

  it('throws for invalid filter pushdown guardrails', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      filter: { pushdownMaxJoinCount: 0 },
    };

    expect(() => validateODataConfig(config)).to.throw(/ODataConfig\.filter\.pushdownMaxJoinCount/);
  });

  it('normalizes capabilities filterFunctions and validates filterFunctionsPreset', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      capabilities: {
        filterFunctionsPreset: 'POSTGRES' as any,
        filterFunctions: [' Contains ', 'contains', 'STARTSWITH', '  '],
      },
    };

    validateODataConfig(config);

    expect(config.capabilities?.filterFunctionsPreset).to.equal('postgres');
    expect(config.capabilities?.filterFunctions).to.deepEqual(['contains', 'startswith']);
  });

  it('throws for invalid capabilities filterFunctionsPreset', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      capabilities: {
        filterFunctionsPreset: 'nope' as any,
      },
    };

    expect(() => validateODataConfig(config)).to.throw(/capabilities\.filterFunctionsPreset/);
  });

  it('throws for invalid post-filter scan guardrails', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      filter: { maxPostFilterScanRows: 0 },
    };

    expect(() => validateODataConfig(config)).to.throw(
      /ODataConfig\.filter\.maxPostFilterScanRows/,
    );
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

  it('normalizes composition boolean flags', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      composition: {
        requireTransactionSupport: 'false' as unknown as boolean,
      },
    };

    validateODataConfig(config);

    expect(config.composition?.requireTransactionSupport).to.equal(false);
  });

  it('throws for invalid composition boolean flags', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      composition: {
        requireTransactionSupport: 'nope' as unknown as boolean,
      },
    };

    expect(() => validateODataConfig(config)).to.throw(/composition\.requireTransactionSupport/);
  });

  it('normalizes composition enforcement', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      composition: {
        enforcement: 'APPLICATION' as any,
      },
    };

    validateODataConfig(config);

    expect(config.composition?.enforcement).to.equal('application');
  });

  it('throws for invalid composition enforcement', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      composition: {
        enforcement: 'nope' as any,
      },
    };

    expect(() => validateODataConfig(config)).to.throw(/composition\.enforcement/);
  });
});

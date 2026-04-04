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
        filterRestrictions: {
          filterable: 'true' as unknown as boolean,
          requiresFilter: 'false' as unknown as boolean,
          nonFilterableProperties: [' sku ', 'sku', '  '],
          nonFilterableNavigationProperties: [' gadgets ', 'gadgets', ''],
        },
      },
    };

    validateODataConfig(config);

    expect(config.capabilities?.filterFunctionsPreset).to.equal('postgres');
    expect(config.capabilities?.filterFunctions).to.deepEqual(['contains', 'startswith']);
    expect(config.capabilities?.filterRestrictions).to.deepEqual({
      filterable: true,
      requiresFilter: false,
      nonFilterableProperties: ['sku'],
      nonFilterableNavigationProperties: ['gadgets'],
    });
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

  it('normalizes telemetry, correlation, tenant quota, and write transaction settings', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      telemetry: {
        level: 'info',
        categories: ['apply', 'requests'],
        sampleRate: '0.5' as any,
        statisticsHeaderName: '  X-Stats  ' as any,
        statisticsPrecision: '3' as any,
        requestLogging: {
          maxPayloadBytes: '2048' as any,
          maskHeaders: ['authorization'],
          maskBodyPaths: ['password'],
        },
      },
      correlation: {
        headerName: '  x-correlation-id  ' as any,
        responseHeaderName: '  x-request-id  ' as any,
        generateWhenMissing: true,
        propagateToRepositories: false,
        repositoryOptionsKey: '  requestContext  ' as any,
      },
      tenantQuotas: {
        maxRequestsPerMinute: '60' as any,
        maxConcurrentRequests: '5' as any,
        maxLeaseRefreshers: '2' as any,
        overrides: {
          alpha: {
            maxRequestsPerMinute: '30' as any,
            maxConcurrentRequests: '3' as any,
          },
        },
      },
      writeTransactions: {
        enabled: true,
        requireTransactionSupport: true,
        rejectMultiDataSource: false,
        isolationLevel: ' read_committed ' as any,
      },
    };

    validateODataConfig(config);

    expect(config.telemetry?.sampleRate).to.equal(0.5);
    expect(config.telemetry?.statisticsHeaderName).to.equal('X-Stats');
    expect(config.telemetry?.statisticsPrecision).to.equal(3);
    expect(config.telemetry?.requestLogging?.maxPayloadBytes).to.equal(2048);
    expect(config.correlation?.headerName).to.equal('x-correlation-id');
    expect(config.correlation?.responseHeaderName).to.equal('x-request-id');
    expect(config.correlation?.repositoryOptionsKey).to.equal('requestContext');
    expect(config.tenantQuotas?.maxRequestsPerMinute).to.equal(60);
    expect(config.tenantQuotas?.maxConcurrentRequests).to.equal(5);
    expect(config.tenantQuotas?.maxLeaseRefreshers).to.equal(2);
    expect(config.tenantQuotas?.overrides?.alpha?.maxRequestsPerMinute).to.equal(30);
    expect(config.tenantQuotas?.overrides?.alpha?.maxConcurrentRequests).to.equal(3);
    expect(config.writeTransactions?.isolationLevel).to.equal('READ_COMMITTED');
  });

  it('throws for invalid telemetry settings', () => {
    expect(() =>
      validateODataConfig({
        tokenSecret: 'test-secret',
        telemetry: {sampleRate: 2 as any},
      }),
    ).to.throw(/telemetry\.sampleRate/);

    expect(() =>
      validateODataConfig({
        tokenSecret: 'test-secret',
        telemetry: {categories: ['apply', 'nope' as any]},
      }),
    ).to.throw(/telemetry\.categories contains unsupported value/);

    expect(() =>
      validateODataConfig({
        tokenSecret: 'test-secret',
        telemetry: {
          requestLogging: {maskHeaders: 'authorization' as any},
        },
      }),
    ).to.throw(/requestLogging\.maskHeaders must be an array/);
  });

  it('throws for invalid correlation, tenant quota, and write transaction settings', () => {
    expect(() =>
      validateODataConfig({
        tokenSecret: 'test-secret',
        correlation: {headerName: '   ' as any},
      }),
    ).to.throw(/correlation\.headerName/);

    expect(() =>
      validateODataConfig({
        tokenSecret: 'test-secret',
        tenantQuotas: {
          maxRequestsPerMinute: 10,
          overrides: {alpha: {maxConcurrentRequests: 0}},
        },
      }),
    ).to.throw(/tenantQuotas\.overrides\["alpha"\]\.maxConcurrentRequests/);

    expect(() =>
      validateODataConfig({
        tokenSecret: 'test-secret',
        writeTransactions: {isolationLevel: 'snapshot' as any},
      }),
    ).to.throw(/writeTransactions\.isolationLevel/);
  });

  it('validates composition entity-set relation delete policies', () => {
    const config: ODataConfig = {
      tokenSecret: 'test-secret',
      composition: {
        entitySets: {
          Orders: {
            relations: {
              items: {
                delete: 'cascade',
              },
            },
          },
        },
      },
    };

    validateODataConfig(config);

    expect(config.composition?.entitySets?.Orders?.relations?.items?.delete).to.equal('cascade');
  });

  it('throws for invalid composition entity-set relation config', () => {
    expect(() =>
      validateODataConfig({
        tokenSecret: 'test-secret',
        composition: {
          entitySets: {
            Orders: {
              relations: {
                items: {
                  delete: 'archive' as any,
                },
              },
            },
          },
        },
      }),
    ).to.throw(/must be "restrict" or "cascade"/);
  });
});

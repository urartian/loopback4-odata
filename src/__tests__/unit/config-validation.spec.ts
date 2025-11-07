import { expect } from '@loopback/testlab';
import { validateODataConfig, validatePaginationLimits } from '../../util/config-validation';
import { ODataConfig } from '../../types';

describe('OData config validation', () => {
  it('normalizes numeric strings and accepts positive values', () => {
    const config: ODataConfig = {
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
      pageSize: 0,
    };

    expect(() => validateODataConfig(config)).to.throw(/ODataConfig\.pageSize/);
  });

  it('throws for invalid entity pagination overrides', () => {
    expect(() =>
      validatePaginationLimits('EntitySet "Products".pagination', { maxTop: -5 }),
    ).to.throw(/EntitySet "Products"\.pagination\.maxTop/);
  });
});

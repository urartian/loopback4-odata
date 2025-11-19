import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataConfig } from '../../types';
import { ODataLogger, ODataTenantThrottler } from '../../keys';

@model()
class Product extends Entity {
  @property({ id: true })
  id!: number;
}

const def: EntitySetDef = {
  name: 'Products',
  modelCtor: Product,
  repositoryBindingKey: 'repositories.ProductRepository',
};

const noopLogger: ODataLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const throttler: ODataTenantThrottler = {
  check: async () => undefined,
  release: () => undefined,
};

function createController(config: Partial<ODataConfig> = {}) {
  const Controller = defineODataCrudController(def);
  return new Controller(
    {} as any,
    {
      protocol: 'https',
      headers: { host: 'example.test' },
    } as any,
    {
      set() {},
      status() {
        return this;
      },
      end() {},
    } as any,
    {} as any,
    config,
    {} as any,
    noopLogger,
    throttler,
  );
}

describe('CRUD controller navigation reference parsing', () => {
  it('parses default /odata references', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference('/odata/Products(10)');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '10' });
  });

  it('parses relative references without leading slash', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference('Products(25)');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '25' });
  });

  it('strips configured basePath prefixes', () => {
    const controller = createController({ basePath: '/api/odata' });
    const result = (controller as any).parseODataIdReference('/api/odata/Products(42)');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '42' });
  });

  it('accepts /odata prefixes even when basePath differs', () => {
    const controller = createController({ basePath: '/api/odata' });
    const result = (controller as any).parseODataIdReference('/odata/Products(7)');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '7' });
  });

  it('strips namespace and alias prefixes', () => {
    const controller = createController({
      basePath: '/api/odata',
      namespace: 'Catalog.Service',
      namespaceAlias: 'CatalogNS',
    });
    const namespaced = (controller as any).parseODataIdReference(
      '/api/odata/Catalog.Service.Products(1)',
    );
    expect(namespaced).to.deepEqual({ entitySet: 'Products', keyExpression: '1' });

    const aliased = (controller as any).parseODataIdReference('/api/odata/CatalogNS.Products(2)');
    expect(aliased).to.deepEqual({ entitySet: 'Products', keyExpression: '2' });
  });

  it('parses absolute URLs that include the basePath', () => {
    const controller = createController({ basePath: '/api/odata' });
    const result = (controller as any).parseODataIdReference(
      'https://example.test/api/odata/Products(99)',
    );
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '99' });
  });

  it('strips query strings from @odata.id references', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference('/odata/Products(5)?$select=Id');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '5' });
  });

  it('strips fragments from @odata.id references', () => {
    const controller = createController();
    const result = (controller as any).parseODataIdReference('/odata/Products(6)#foo');
    expect(result).to.deepEqual({ entitySet: 'Products', keyExpression: '6' });
  });
});

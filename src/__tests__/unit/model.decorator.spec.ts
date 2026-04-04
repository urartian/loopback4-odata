import 'reflect-metadata';
import { MetadataInspector } from '@loopback/core';
import { Entity, model, MODEL_KEY } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { getODataModelMeta, odataModel } from '../../decorators/model.decorator';

describe('@odataModel decorator', () => {
  it('applies LoopBack @model() metadata when lbModel is absent', () => {
    @odataModel()
    class Product extends Entity {}

    const loopbackMeta = MetadataInspector.getClassMetadata(MODEL_KEY, Product);
    expect(loopbackMeta).to.containEql({ name: 'Product' });

    expect(getODataModelMeta(Product)).to.eql({});
  });

  it('applies LoopBack @model() metadata using lbModel settings', () => {
    @odataModel({ lbModel: { settings: { strict: true } } })
    class Order extends Entity {}

    const loopbackMeta = MetadataInspector.getClassMetadata(MODEL_KEY, Order);
    expect(loopbackMeta).to.containEql({ settings: { strict: true } });

    expect(getODataModelMeta(Order)).to.containEql({ lbModel: { settings: { strict: true } } });
  });

  it('accepts full LoopBack @model() definition via lbModel and does not mutate user options', () => {
    const decoratorOptions = {
      lbModel: {
        name: 'CustomName',
        settings: {
          strict: true,
          postgresql: { table: 'my_table' },
          indexes: {
            idxSku: { keys: { sku: 1 }, options: { unique: true } },
          },
        },
      },
      etag: 'updatedAt',
    } as const;

    @odataModel(decoratorOptions)
    class CatalogItem extends Entity {}

    const loopbackMeta = MetadataInspector.getClassMetadata(MODEL_KEY, CatalogItem);
    expect(loopbackMeta).to.containEql(decoratorOptions.lbModel);

    expect(getODataModelMeta(CatalogItem)).to.eql(decoratorOptions);
  });

  it('throws when lbModel is provided and @model() metadata already exists', () => {
    const expectedMessage =
      '@odataModel({ lbModel: ... }) cannot be used on a class that already has @model() metadata. Remove @model() and configure model options via @odataModel({ lbModel: ... }).';

    let thrown: unknown;
    try {
      @odataModel({ lbModel: { settings: { strict: false } } })
      @model({ settings: { strict: true } })
      class Conflicting extends Entity {}

      throw new Error(`Expected decorator application to fail for ${Conflicting.name}.`);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.equal(expectedMessage);
  });

  it('does not throw when @model() metadata exists and lbModel is absent', () => {
    expect(() => {
      @odataModel()
      @model()
      class ExistingModel extends Entity {}

      const loopbackMeta = MetadataInspector.getClassMetadata(MODEL_KEY, ExistingModel);
      expect(loopbackMeta).to.containEql({ name: 'ExistingModel' });

      expect(getODataModelMeta(ExistingModel)).to.eql({});
    }).to.not.throw();
  });
});

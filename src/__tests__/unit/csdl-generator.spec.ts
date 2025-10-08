import 'reflect-metadata';
import {expect} from '@loopback/testlab';
import {
  Entity,
  model,
  property,
  hasMany,
  belongsTo,
} from '@loopback/repository';
import {CsdlGenerator} from '../../metadata/csdl-generator';
import {EntitySetRegistry, EntitySetDef} from '../../registry/entityset-registry';

@model()
class Gadget extends Entity {
  @property({id: true, type: 'number'})
  id!: number;

  @belongsTo(() => Widget)
  widgetId!: number;
}

@model()
class Widget extends Entity {
  @property({id: true, type: 'number'})
  id!: number;

  @property({
    type: 'string',
    required: true,
    jsonSchema: {maxLength: 128, unicode: false},
  })
  name!: string;

  @property({
    type: 'number',
    jsonSchema: {format: 'decimal', precision: 10, scale: 2},
  })
  price?: number;

  @property({type: 'string', jsonSchema: {format: 'uuid'}})
  sku?: string;

  @property({type: 'array', itemType: 'string'})
  tags?: string[];

  @property({type: 'date', required: true})
  updatedAt!: Date;

  @property({type: 'string', default: 'draft'})
  status?: string;

  @hasMany(() => Gadget)
  gadgets?: Gadget[];
}

describe('CsdlGenerator', () => {
  let registry: EntitySetRegistry;
  let generator: CsdlGenerator;

  beforeEach(() => {
    registry = new EntitySetRegistry();

    const widgets: EntitySetDef = registry.register({
      name: 'Widgets',
      modelCtor: Widget,
      etagProperties: ['updatedAt'],
      actions: [
        {
          name: 'resetInventory',
          methodName: 'resetInventory',
          binding: 'entity',
          rawResponse: false,
          parameters: [{name: 'confirm', type: 'Edm.Boolean'}],
        },
      ],
      functions: [
        {
          name: 'topWidgets',
          methodName: 'topWidgets',
          binding: 'collection',
          rawResponse: false,
          returnType: 'Edm.Int32',
        },
        {
          name: 'ping',
          methodName: 'ping',
          binding: 'unbound',
          rawResponse: false,
          returnType: 'Edm.String',
        },
      ],
    });

    registry.register({
      name: 'Gadgets',
      modelCtor: Gadget,
    });


    generator = new CsdlGenerator(registry, {
      namespace: 'Catalog',
      entityContainerName: 'CatalogService',
    });

    expect(widgets).to.be.ok();
  });

  it('produces enriched XML metadata', () => {
    const xml = generator.generate('xml');

    expect(xml.includes('<Schema Namespace="Catalog"')).to.be.true();
    expect(xml.includes('<EntityType Name="Widget">')).to.be.true();
    expect(
      xml.includes(
        '<Property Name="name" Type="Edm.String" Nullable="false" MaxLength="128" Unicode="false"',
      ),
    ).to.be.true();
    expect(xml.includes('ConcurrencyMode="Fixed"')).to.be.true();
    expect(xml.includes('Collection(Edm.String)')).to.be.true();
    expect(xml.includes('Precision="10"')).to.be.true();
    expect(xml.includes('Scale="2"')).to.be.true();
    expect(xml.includes('<Property Name="sku" Type="Edm.Guid" Nullable="true"')).to.be.true();
    expect(
      xml.includes('<Property Name="status" Type="Edm.String" Nullable="true" DefaultValue="draft"'),
    ).to.be.true();
    expect(
      xml.includes('<NavigationProperty Name="gadgets" Type="Collection(Catalog.Gadget)"'),
    ).to.be.true();
    expect(xml.includes('PropertyPath>updatedAt</PropertyPath>')).to.be.true();
    expect(xml.includes('<Action Name="resetInventory" IsBound="true">')).to.be.true();
    expect(xml.includes('<Function Name="topWidgets" IsBound="true">')).to.be.true();
    expect(xml.includes('<Function Name="ping"')).to.be.true();
    expect(xml.includes('<EntityContainer Name="CatalogService">')).to.be.true();
  });

  it('produces aligned JSON CSDL', () => {
    const jsonDoc = generator.generate('json');
    const parsed = JSON.parse(jsonDoc);

    expect(parsed).to.have.property('$Version', '4.0');
    expect(parsed).to.have.property('Catalog');
    const schema = parsed.Catalog;
    expect(schema.Widget.$Kind).to.equal('EntityType');
    expect(schema.Widget.$Key).to.eql(['id']);
    expect(schema.Widget.name.$Type).to.equal('Edm.String');
    expect(schema.Widget.name.Nullable).to.equal(false);
    expect(schema.Widget.name.MaxLength).to.equal(128);
    expect(schema.Widget.name.Unicode).to.equal(false);
    expect(schema.Widget.price.Precision).to.equal(10);
    expect(schema.Widget.price.Scale).to.equal(2);
    expect(schema.Widget.sku.$Type).to.equal('Edm.Guid');
    expect(schema.Widget.tags.$Type).to.equal('Collection(Edm.String)');
    expect(schema.Widget['updatedAt@ConcurrencyMode']).to.equal('Fixed');
    expect(schema.Widget.status.DefaultValue).to.equal('draft');
    expect(schema.Widget.gadgets.$Kind).to.equal('NavigationProperty');
    expect(schema.Widget.gadgets.$Type).to.equal('Collection(Catalog.Gadget)');

    expect(schema).to.have.property('resetInventory');
    expect(schema.resetInventory.$Kind).to.equal('Action');
    expect(schema.resetInventory.$IsBound).to.equal(true);
    expect(Array.isArray(schema.resetInventory.$Parameter)).to.be.true();

    expect(schema).to.have.property('topWidgets');
    expect(schema.topWidgets.$Kind).to.equal('Function');
    expect(schema.topWidgets.$IsBound).to.equal(true);
    expect(schema.topWidgets.$ReturnType.$Type).to.equal('Edm.Int32');

    expect(schema).to.have.property('CatalogService');
    const container = schema.CatalogService;
    expect(container.$Kind).to.equal('EntityContainer');
    expect(container.Widgets.$Type).to.equal('Catalog.Widget');
    expect(container.Widgets.$NavigationPropertyBinding.gadgets).to.equal('Gadgets');
    expect(container.Widgets['@Org.OData.Core.V1.OptimisticConcurrency'][0].$PropertyPath).to.equal('updatedAt');
    expect(container.Gadgets.$Type).to.equal('Catalog.Gadget');
    expect(container.ping.$Function).to.equal('Catalog.ping');
  });

  it('reports MIME types', () => {
    expect(generator.contentType('xml')).to.equal('application/xml');
    expect(generator.contentType('json')).to.equal('application/json');
  });
});

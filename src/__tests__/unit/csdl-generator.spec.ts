import 'reflect-metadata';
import { expect, sinon } from '@loopback/testlab';
import {
  AnyObject,
  Entity,
  Model,
  model,
  property,
  hasMany,
  belongsTo,
} from '@loopback/repository';
import { CsdlGenerator } from '../../metadata/csdl-generator';
import { EntitySetRegistry, EntitySetDef } from '../../registry/entityset-registry';
import { odataSearchable } from '../../decorators/search.decorators';

@model()
class Dimensions extends Model {
  @property({ type: 'number' })
  width!: number;

  @property({ type: 'number' })
  height!: number;
}

@model()
class Gadget extends Entity {
  @property({ id: true, type: 'number' })
  id!: number;

  @belongsTo(() => Widget)
  widgetId!: number;
}

@model()
class Widget extends Entity {
  @property({ id: true, type: 'number' })
  id!: number;

  @odataSearchable()
  @property({
    type: 'string',
    required: true,
    jsonSchema: { maxLength: 128, unicode: false },
  })
  name!: string;

  @property({
    type: 'number',
    jsonSchema: { format: 'decimal', precision: 10, scale: 2 },
  })
  price?: number;

  @property({ type: 'string', jsonSchema: { format: 'uuid' } })
  sku?: string;

  @property({ type: 'string' })
  contentType?: string;

  @property({ type: 'buffer' })
  data?: Buffer;

  @property({ type: 'array', itemType: 'string' })
  tags?: string[];

  @property({ type: () => Dimensions })
  dimensions?: Dimensions;

  @property({ type: 'date', required: true })
  updatedAt!: Date;

  @property({
    type: 'string',
    default: 'draft',
    jsonSchema: { enum: ['draft', 'active', 'discontinued'] },
  })
  status?: string;

  @hasMany(() => Gadget)
  gadgets?: Gadget[];
}

@model()
class AdvancedWidget extends Widget {
  @property({ type: 'string' })
  feature?: string;
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
      hasStream: true,
      mediaField: 'data',
      mediaContentTypeField: 'contentType',
      mediaEtagField: 'sku',
      deepInsert: true,
      supportsTransactions: true,
      capabilities: {
        countable: false,
        filterFunctions: ['contains', 'startswith'],
        navigationRestrictions: {
          gadgets: { navigable: false },
        },
        permissions: [
          {
            scheme: 'OAuth2',
            scopes: ['widget.read', { scope: 'widget.write', description: 'Modify widgets' }],
          },
        ],
        hasStream: true,
        aggregation: true,
        aggregationMethods: ['Sum', 'Count'],
        insertRestrictions: {
          insertable: false,
          description: 'Widgets are managed externally',
          nonInsertableNavigationProperties: ['gadgets'],
        },
        updateRestrictions: {
          updatable: true,
          nonUpdatableProperties: ['status'],
        },
        deleteRestrictions: {
          deletable: true,
          requiresFilter: true,
        },
        searchRestrictions: {
          unsupportedExpressions: ['not'],
        },
      },
      actions: [
        {
          name: 'resetInventory',
          methodName: 'resetInventory',
          binding: 'entity',
          rawResponse: false,
          parameters: [{ name: 'confirm', type: 'Edm.Boolean' }],
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
      supportsTransactions: false,
      hasStream: true,
    });

    registry.register({
      name: 'AdvancedWidgets',
      modelCtor: AdvancedWidget,
    });

    generator = new CsdlGenerator(registry, {
      namespace: 'Catalog',
      entityContainerName: 'CatalogService',
      namespaceAlias: 'CatalogNS',
      capabilities: {
        filterFunctions: ['contains', 'startswith', 'endswith'],
      },
    });

    expect(widgets).to.be.ok();
  });

  it('produces enriched XML metadata', () => {
    const xml = generator.generate('xml');
    expect(xml.includes('<Schema Namespace="Catalog" Alias="CatalogNS"')).to.be.true();
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
      xml.includes(
        '<Property Name="status" Type="Catalog.WidgetStatusEnum" Nullable="true" DefaultValue="draft"',
      ),
    ).to.be.true();
    expect(xml.includes('<ComplexType Name="Dimensions">')).to.be.true();
    expect(
      xml.includes('<Property Name="dimensions" Type="Catalog.Dimensions" Nullable="true"'),
    ).to.be.true();
    expect(xml.includes('<EnumType Name="WidgetStatusEnum"')).to.be.true();
    expect(xml.includes('<Member Name="draft" Value="0"')).to.be.true();
    expect(xml.includes('Annotation Term="Org.OData.Core.V1.HasStream" Bool="true"')).to.be.true();
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.Streaming" Bool="true"'),
    ).to.be.true();
    expect(
      xml.includes(
        '<Annotation Term="Org.OData.Core.V1.MediaType"><Path>contentType</Path></Annotation>',
      ),
    ).to.be.true();
    expect(
      xml.includes('<Annotation Term="Org.OData.Core.V1.MediaETag"><Path>sku</Path></Annotation>'),
    ).to.be.true();
    const mediaEtagAnnotations = xml.match(/Org\.OData\.Core\.V1\.MediaETag/g) ?? [];
    expect(mediaEtagAnnotations).to.have.length(1);
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.CountRestrictions"'),
    ).to.be.true();
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.FilterFunctions"'),
    ).to.be.true();
    expect(xml.includes('Annotation Term="Org.OData.Capabilities.V1.Aggregate"')).to.be.true();
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.NavigationRestrictions"'),
    ).to.be.true();
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.DeepInsertSupport"'),
    ).to.be.true();
    expect(
      xml.includes('<NavigationProperty Name="gadgets" Type="Collection(Catalog.Gadget)"'),
    ).to.be.true();
    expect(
      xml.includes(
        '<NavigationProperty Name="gadgets" Type="Collection(Catalog.Gadget)" Partner="widget" />',
      ),
    ).to.be.true();
    expect(
      xml.includes('<ReferentialConstraint Property="widgetId" ReferencedProperty="id" />'),
    ).to.be.true();
    expect(xml.includes('PropertyPath>updatedAt</PropertyPath>')).to.be.true();
    expect(xml.includes('<Action Name="resetInventory" IsBound="true">')).to.be.true();
    expect(xml.includes('<Function Name="topWidgets" IsBound="true">')).to.be.true();
    expect(xml.includes('<Function Name="ping"')).to.be.true();
    expect(xml.includes('Annotation Term="Org.OData.Core.V1.Permissions"')).to.be.true();
    expect(xml.includes('<EntityContainer Name="CatalogService">')).to.be.true();
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.InsertRestrictions"'),
    ).to.be.true();
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.UpdateRestrictions"'),
    ).to.be.true();
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.DeleteRestrictions"'),
    ).to.be.true();
    expect(
      xml.includes('Annotation Term="Org.OData.Capabilities.V1.SearchRestrictions"'),
    ).to.be.true();
    expect(xml.includes('Annotation Term="Org.OData.Capabilities.V1.BatchSupported"')).to.be.true();
    expect(xml.includes('PropertyValue Property="ChangeSetsSupported" Bool="false"')).to.be.true();
    expect(
      xml.includes(
        'Annotation Term="LoopBack.V1.BatchCapabilities.ChangeSetsSupported" Bool="true"',
      ),
    ).to.be.true();
    expect(
      xml.includes(
        'Annotation Term="LoopBack.V1.BatchCapabilities.ChangeSetsSupported" Bool="false"',
      ),
    ).to.be.true();
    expect(
      xml.includes('<EntityType Name="AdvancedWidget" BaseType="Catalog.Widget">'),
    ).to.be.true();
    expect(
      xml.includes(
        '<edmx:Reference Uri="http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/vocabularies/Org.OData.Core.V1.xml">',
      ),
    ).to.be.true();
    expect(
      xml.includes(
        '<edmx:Reference Uri="http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/vocabularies/Org.OData.Capabilities.V1.xml">',
      ),
    ).to.be.true();
  });

  it('produces aligned JSON CSDL', () => {
    const widgetsSet = registry.findByName('Widgets');
    expect(widgetsSet).to.be.ok();
    if (widgetsSet) {
      widgetsSet.applyPushdown = false;
    }

    const jsonDoc = generator.generate('json');
    const parsed = JSON.parse(jsonDoc);

    expect(parsed).to.have.property('$Version', '4.0');
    expect(parsed.$Reference).to.containDeep({
      'http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/vocabularies/Org.OData.Core.V1.xml':
        {
          $Include: [{ $Namespace: 'Org.OData.Core.V1', $Alias: 'Core' }],
        },
      'http://docs.oasis-open.org/odata/odata/v4.0/errata03/os/vocabularies/Org.OData.Capabilities.V1.xml':
        {
          $Include: [{ $Namespace: 'Org.OData.Capabilities.V1', $Alias: 'Capabilities' }],
        },
    });
    expect(parsed).to.have.property('Catalog');
    const schema = parsed.Catalog;
    expect(schema.$Alias).to.equal('CatalogNS');
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
    expect(schema.Widget.dimensions.$Type).to.equal('Catalog.Dimensions');
    expect(schema.Widget['updatedAt@ConcurrencyMode']).to.equal('Fixed');
    expect(schema.Widget['@Org.OData.Core.V1.MediaETag']).to.containDeep({ $Path: 'sku' });
    expect(schema.Dimensions.$Kind).to.equal('ComplexType');
    expect(schema.Dimensions.width.$Type).to.equal('Edm.Double');
    expect(schema.Widget.status.$Type).to.equal('Catalog.WidgetStatusEnum');
    expect(schema.WidgetStatusEnum.$Kind).to.equal('EnumType');
    expect(schema.WidgetStatusEnum.Members).to.have.length(3);
    expect(schema.WidgetStatusEnum.Members[0]).to.containEql({ Name: 'draft', Value: 0 });
    expect(schema.Widget.status.DefaultValue).to.equal('draft');
    expect(schema.Widget.gadgets.$Kind).to.equal('NavigationProperty');
    expect(schema.Widget.gadgets.$Type).to.equal('Collection(Catalog.Gadget)');
    expect(schema.Widget['@Org.OData.Core.V1.HasStream']).to.equal(true);
    expect(schema.Gadget['@Org.OData.Core.V1.MediaETag']).to.equal(undefined);
    expect(schema.AdvancedWidget.$BaseType).to.equal('Catalog.Widget');
    expect(schema.Widget.gadgets.$Partner).to.equal('widget');
    expect(schema.Widget.gadgets.$ReferentialConstraint).to.equal(undefined);
    expect(schema.Gadget.widget.$ReferentialConstraint[0]).to.containDeep({
      Property: 'widgetId',
      ReferencedProperty: 'id',
    });
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
    expect(container.Widgets['@Org.OData.Core.V1.OptimisticConcurrency'][0].$PropertyPath).to.equal(
      'updatedAt',
    );
    expect(container.Widgets['@Org.OData.Capabilities.V1.FilterFunctions']).to.deepEqual([
      'contains',
      'startswith',
    ]);
    expect(container.Widgets['@Org.OData.Capabilities.V1.CountRestrictions'].Countable).to.equal(
      false,
    );
    expect(
      container.Widgets['@Org.OData.Capabilities.V1.NavigationRestrictions']
        .RestrictedProperties[0],
    ).to.containDeep({
      NavigationProperty: 'gadgets',
      Navigability: 'Org.OData.Capabilities.V1.NavigationType/None',
    });
    expect(container.Widgets['@Org.OData.Core.V1.Permissions'][0].SchemeName).to.equal('OAuth2');
    expect(container.Widgets['@Org.OData.Core.V1.Permissions'][0].Scopes).to.have.length(2);
    expect(
      container.Widgets['@Org.OData.Capabilities.V1.Aggregate'].SupportedAggregationMethods,
    ).to.deepEqual(['Sum', 'Count']);
    expect(container.Widgets['@Org.OData.Capabilities.V1.DeepInsertSupport'].Supported).to.equal(
      true,
    );
    expect(container['@Org.OData.Capabilities.V1.BatchSupported']).to.containDeep({
      Supported: true,
      ChangeSetsSupported: false,
    });
    expect(container.Widgets['@LoopBack.V1.BatchCapabilities.ChangeSetsSupported']).to.equal(true);
    expect(container.Gadgets['@LoopBack.V1.BatchCapabilities.ChangeSetsSupported']).to.equal(false);
    expect(container.Widgets['@Org.OData.Capabilities.V1.InsertRestrictions'].Insertable).to.equal(
      false,
    );
    expect(
      container.Widgets['@Org.OData.Capabilities.V1.DeleteRestrictions'].RequiresFilter,
    ).to.equal(true);
    expect(container.Widgets['@Org.OData.Capabilities.V1.SearchRestrictions'].Searchable).to.equal(
      true,
    );
    expect(
      container.Widgets['@Org.OData.Capabilities.V1.SearchRestrictions'].UnsupportedExpressions,
    ).to.containEql('Org.OData.Capabilities.V1.SearchExpressions/Not');
    expect(container.Widgets['@Org.OData.Capabilities.V1.ApplySupported'].ApplySupported).to.equal(
      true,
    );
    expect(container.Gadgets.$Type).to.equal('Catalog.Gadget');
    expect(container.AdvancedWidgets.$Type).to.equal('Catalog.AdvancedWidget');
    expect(container.ping.$Function).to.equal('Catalog.ping');
  });

  it('reports MIME types', () => {
    expect(generator.contentType('xml')).to.equal('application/xml');
    expect(generator.contentType('json')).to.equal('application/json');
  });

  it('caches generated schemas per format and invalidates when the registry changes', () => {
    const generatorInternals = generator as unknown as AnyObject;
    const buildSpy = sinon.spy(generatorInternals, 'buildJsonDocument');
    try {
      const firstXml = generator.generate('xml');
      const secondXml = generator.generate('xml');
      expect(secondXml).to.equal(firstXml);
      expect(buildSpy.callCount).to.equal(0);

      const firstJson = generator.generate('json');
      const secondJson = generator.generate('json');
      expect(secondJson).to.equal(firstJson);
      expect(buildSpy.callCount).to.equal(1); // only JSON build invoked

      registry.register({ name: 'Widgets', modelCtor: Widget });
      const thirdJson = generator.generate('json');
      expect(thirdJson).to.be.a.String();
      expect(buildSpy.callCount).to.equal(2);
    } finally {
      buildSpy.restore();
    }
  });

  it('invalidates cached schemas when configuration changes', () => {
    const initial = generator.generate('xml');
    const internals = generator as unknown as AnyObject;
    internals.cfg.namespace = 'CatalogV2';
    const updated = generator.generate('xml');
    expect(updated).to.not.equal(initial);
    expect(updated.includes('Namespace="CatalogV2"')).to.be.true();
  });
});

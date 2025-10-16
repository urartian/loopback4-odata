import 'reflect-metadata';
import {Application, inject} from '@loopback/core';
import {RestApplication} from '@loopback/rest';
import {
  DefaultCrudRepository,
  Entity,
  RepositoryMixin,
  juggler,
  model,
  property,
  RelationType,
} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {ODataBooter} from '../../booters/odata.booter';
import {EntitySetRegistry} from '../../registry/entityset-registry';
import {odataModel} from '../../decorators/model.decorator';
import {odataController} from '../../decorators/controller.decorator';
import {ODataApplyExecutorRegistry} from '../../services/odata-apply-executor.registry';

describe('ODataBooter entity set naming', () => {
  it('uses inflection to pluralize model names by default', () => {
    @model()
    class Person extends Entity {}

    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(app, registry, {} as any, new ODataApplyExecutorRegistry());

    const setName = (booter as any).getEntitySetName(Person);
    expect(setName).to.equal('People');
  });

  it('respects explicit entity set name metadata', () => {
    @odataModel({entitySetName: 'CustomPeople'})
    @model()
    class Citizen extends Entity {}

    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(app, registry, {} as any, new ODataApplyExecutorRegistry());

    const setName = (booter as any).getEntitySetName(Citizen);
    expect(setName).to.equal('CustomPeople');
  });
});

describe('ODataBooter repository binding resolution', () => {
  it('uses naming conventions to resolve repositories without instantiating them', async () => {
    const RepoApp = RepositoryMixin(Application);
    const app = new RepoApp();
    app.dataSource(new juggler.DataSource({name: 'db', connector: 'memory'}), 'db');

    @model()
    class Widget extends Entity {
      @property({id: true})
      id?: number;
    }

    let instantiationAttempts = 0;

    class WidgetRepository extends DefaultCrudRepository<
      Widget,
      typeof Widget.prototype.id
    > {
      constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
        instantiationAttempts++;
        super(Widget, dataSource);
        throw new Error('Repository should not be instantiated during OData boot.');
      }
    }

    @odataController(Widget)
    class WidgetODataController {}

    app.repository(WidgetRepository);
    app.controller(WidgetODataController);

    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(app, registry, {} as any, new ODataApplyExecutorRegistry());

    await booter.load();

    expect(instantiationAttempts).to.equal(0);
    const def = registry.get(Widget);
    expect(def?.repositoryBindingKey).to.equal('repositories.WidgetRepository');
  });
});

describe('ODataBooter navigation reference routes', () => {
  it('registers $ref routes when the foreign key can be inferred', async () => {
    const app = new RestApplication();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(app, registry, {} as any, new ODataApplyExecutorRegistry());

    @model()
    class Order extends Entity {
      @property({id: true})
      id!: number;
    }

    @model()
    class OrderItem extends Entity {
      @property({id: true})
      id!: number;

      @property()
      orderId!: number;
    }

    const orderDef = (Order as typeof Entity).definition;
    orderDef.addRelation({
      name: 'items',
      type: RelationType.hasMany,
      targetsMany: true,
      source: Order,
      target: () => OrderItem,
    });

    @odataController(Order)
    class OrderODataController {
      async linkNavigationRef() {}
      async unlinkNavigationRef() {}
    }

    app.controller(OrderODataController);

    const def = registry.register({
      name: 'Orders',
      modelCtor: Order,
      controllerCtor: OrderODataController,
    });

    (booter as any).registerNavigationRefRoutes(def, orderDef, OrderODataController);

    const spec = await app.restServer.getApiSpec();
    expect(spec.paths?.['/odata/Orders/{id}/items/$ref']).to.be.Object();
    expect(spec.paths?.['/odata/Orders/{id}/items/{targetKey}/$ref']).to.be.Object();
  });
});

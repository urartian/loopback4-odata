import 'reflect-metadata';
import {Application, inject} from '@loopback/core';
import {
  DefaultCrudRepository,
  Entity,
  RepositoryMixin,
  juggler,
  model,
  property,
} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {ODataBooter} from '../../booters/odata.booter';
import {EntitySetRegistry} from '../../registry/entityset-registry';
import {odataModel} from '../../decorators/model.decorator';
import {odataController} from '../../decorators/controller.decorator';

describe('ODataBooter entity set naming', () => {
  it('uses inflection to pluralize model names by default', () => {
    @model()
    class Person extends Entity {}

    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(app, registry, {} as any);

    const setName = (booter as any).getEntitySetName(Person);
    expect(setName).to.equal('People');
  });

  it('respects explicit entity set name metadata', () => {
    @odataModel({entitySetName: 'CustomPeople'})
    @model()
    class Citizen extends Entity {}

    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(app, registry, {} as any);

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
    const booter = new ODataBooter(app, registry, {} as any);

    await booter.load();

    expect(instantiationAttempts).to.equal(0);
    const def = registry.get(Widget);
    expect(def?.repositoryBindingKey).to.equal('repositories.WidgetRepository');
  });
});

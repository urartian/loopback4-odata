import 'reflect-metadata';
import {Application} from '@loopback/core';
import {Entity, model} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {ODataBooter} from '../../booters/odata.booter';
import {EntitySetRegistry} from '../../registry/entityset-registry';
import {odataModel} from '../../decorators/model.decorator';

describe('ODataBooter entity set naming', () => {
  it('uses inflection to pluralize model names by default', () => {
    @model()
    class Person extends Entity {}

    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(app, registry);

    const setName = (booter as any).getEntitySetName(Person);
    expect(setName).to.equal('People');
  });

  it('respects explicit entity set name metadata', () => {
    @odataModel({entitySetName: 'CustomPeople'})
    @model()
    class Citizen extends Entity {}

    const app = new Application();
    const registry = new EntitySetRegistry();
    const booter = new ODataBooter(app, registry);

    const setName = (booter as any).getEntitySetName(Citizen);
    expect(setName).to.equal('CustomPeople');
  });
});

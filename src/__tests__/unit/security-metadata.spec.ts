import 'reflect-metadata';
import {Entity, model} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {defineODataCrudController} from '../../controllers/crud-controller-factory';
import {EntitySetDef} from '../../registry/entityset-registry';
import {collectControllerSecurityMetadata} from '../../util/security-metadata';

const AUTH_KEY = 'authentication:metadata';
const AUTHZ_KEY = 'authorization:metadata';

describe('Security metadata propagation', () => {
  it('collects metadata from the source controller and applies it to the generated CRUD controller', () => {
    @model()
    class Widget extends Entity {}

    class WidgetController {
      list() {}
    }

    Reflect.defineMetadata(AUTH_KEY, {strategy: 'jwt'}, WidgetController);
    Reflect.defineMetadata(AUTHZ_KEY, {scopes: ['widget.read']}, WidgetController.prototype, 'list');

    const securityMetadata = collectControllerSecurityMetadata(WidgetController);
    expect(securityMetadata).to.not.be.undefined();

    const def: EntitySetDef = {
      name: 'Widgets',
      modelCtor: Widget,
      repositoryBindingKey: 'repositories.WidgetRepository',
      securityMetadata,
    };

    const Generated = defineODataCrudController(def);

    expect(Reflect.getMetadata(AUTH_KEY, Generated)).to.deepEqual({strategy: 'jwt'});
    expect(Reflect.getMetadata(AUTHZ_KEY, Generated.prototype, 'list')).to.deepEqual({scopes: ['widget.read']});
  });
});

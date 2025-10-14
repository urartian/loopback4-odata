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

  it('maps find metadata from the source controller to the list handler', () => {
    @model()
    class Gadget extends Entity {}

    class GadgetController {
      find() {}
    }

    Reflect.defineMetadata(AUTHZ_KEY, {scopes: ['gadget.read']}, GadgetController.prototype, 'find');

    const securityMetadata = collectControllerSecurityMetadata(GadgetController);
    expect(securityMetadata?.methodMetadata).to.have.property('find');

    const def: EntitySetDef = {
      name: 'Gadgets',
      modelCtor: Gadget,
      repositoryBindingKey: 'repositories.GadgetRepository',
      securityMetadata,
    };

    const Generated = defineODataCrudController(def);
    expect(Reflect.getMetadata(AUTHZ_KEY, Generated.prototype, 'list')).to.deepEqual({scopes: ['gadget.read']});
  });

  it('maps deleteById metadata to the delete handler by default', () => {
    @model()
    class Thing extends Entity {}

    class ThingController {
      deleteById() {}
    }

    Reflect.defineMetadata(AUTHZ_KEY, {scopes: ['thing.delete']}, ThingController.prototype, 'deleteById');

    const securityMetadata = collectControllerSecurityMetadata(ThingController);
    expect(securityMetadata?.methodMetadata).to.have.property('deleteById');

    const def: EntitySetDef = {
      name: 'Things',
      modelCtor: Thing,
      repositoryBindingKey: 'repositories.ThingRepository',
      securityMetadata,
    };

    const Generated = defineODataCrudController(def);
    expect(Reflect.getMetadata(AUTHZ_KEY, Generated.prototype, 'delete')).to.deepEqual({scopes: ['thing.delete']});
  });

  it('allows overriding derived method aliases', () => {
    @model()
    class Gizmo extends Entity {}

    class GizmoController {
      deleteById() {}
    }

    Reflect.defineMetadata(AUTHZ_KEY, {scopes: ['gizmo.delete']}, GizmoController.prototype, 'deleteById');

    const securityMetadata = collectControllerSecurityMetadata(GizmoController);
    expect(securityMetadata?.methodMetadata).to.have.property('deleteById');

    const def: EntitySetDef = {
      name: 'Gizmos',
      modelCtor: Gizmo,
      repositoryBindingKey: 'repositories.GizmoRepository',
      securityMetadata,
      securityMethodAliases: {
        deleteById: [],
      },
    };

    const Generated = defineODataCrudController(def);
    expect(Reflect.getMetadata(AUTHZ_KEY, Generated.prototype, 'delete')).to.be.undefined();
  });

  it('maps update/delete metadata to navigation link/unlink handlers', () => {
    @model()
    class Order extends Entity {}

    class OrderController {
      updateById() {}
      deleteById() {}
    }

    Reflect.defineMetadata(AUTHZ_KEY, {scopes: ['order.update']}, OrderController.prototype, 'updateById');
    Reflect.defineMetadata(AUTHZ_KEY, {scopes: ['order.delete']}, OrderController.prototype, 'deleteById');

    const securityMetadata = collectControllerSecurityMetadata(OrderController);
    const def: EntitySetDef = {
      name: 'Orders',
      modelCtor: Order,
      repositoryBindingKey: 'repositories.OrderRepository',
      securityMetadata,
    };

    const Generated = defineODataCrudController(def);
    expect(Reflect.getMetadata(AUTHZ_KEY, Generated.prototype, 'linkNavigationRef')).to.deepEqual({scopes: ['order.update']});
    expect(Reflect.getMetadata(AUTHZ_KEY, Generated.prototype, 'unlinkNavigationRef')).to.deepEqual({scopes: ['order.delete']});
  });

  it('falls back to update metadata for unlink when delete metadata is absent', () => {
    @model()
    class Invoice extends Entity {}

    class InvoiceController {
      updateById() {}
    }

    Reflect.defineMetadata(AUTHZ_KEY, {scopes: ['invoice.write']}, InvoiceController.prototype, 'updateById');

    const securityMetadata = collectControllerSecurityMetadata(InvoiceController);
    const def: EntitySetDef = {
      name: 'Invoices',
      modelCtor: Invoice,
      repositoryBindingKey: 'repositories.InvoiceRepository',
      securityMetadata,
    };

    const Generated = defineODataCrudController(def);
    expect(Reflect.getMetadata(AUTHZ_KEY, Generated.prototype, 'linkNavigationRef')).to.deepEqual({scopes: ['invoice.write']});
    expect(Reflect.getMetadata(AUTHZ_KEY, Generated.prototype, 'unlinkNavigationRef')).to.deepEqual({scopes: ['invoice.write']});
  });
});

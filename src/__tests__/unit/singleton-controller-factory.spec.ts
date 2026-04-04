import 'reflect-metadata';
import { strict as assert } from 'assert';
import { HttpErrors } from '@loopback/rest';
import { Entity, model, property } from '@loopback/repository';
import { defineODataSingletonController } from '../../controllers/singleton-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';

@model()
class Library extends Entity {
  @property({ id: true })
  id!: number;
}

describe('defineODataSingletonController', () => {
  const createDef = (): EntitySetDef => ({
    name: 'Libraries',
    modelCtor: Library,
    repositoryBindingKey: 'repositories.LibraryRepository',
  });

  class CrudStub {
    constructor(..._args: unknown[]) {}

    async findById(id: unknown) {
      return {'@odata.context': '/odata/$metadata#Libraries/$entity', id};
    }

    async update(id: unknown, payload: unknown) {
      return {'@odata.context': '/odata/$metadata#Libraries/$entity', id, payload};
    }

    async replace(id: unknown, payload: unknown) {
      return {'@odata.context': '/odata/$metadata#Libraries/$entity', id, payload};
    }

    async delete(id: unknown) {
      return {'@odata.context': '/odata/$metadata#Libraries/$entity', id, deleted: true};
    }

    async getMediaValue(id: unknown) {
      return {id, media: true};
    }

    async replaceMediaValue(id: unknown, body: unknown) {
      return {id, body, replaced: true};
    }

    async deleteMediaValue(id: unknown) {
      return {id, deleted: true};
    }

    async getPropertyValue(id: unknown, property: string) {
      return {id, property, raw: true};
    }

    async getEntityProperty(id: unknown, property: string) {
      return {'@odata.context': '/odata/$metadata#Libraries/name', id, property};
    }

    async linkNavigationRef(relationName: string, parentIdRaw: unknown, targetUri?: string) {
      return {relationName, parentIdRaw, targetUri};
    }

    async unlinkNavigationRef(
      relationName: string,
      parentIdRaw: unknown,
      targetKeyRaw?: string,
    ) {
      return {relationName, parentIdRaw, targetKeyRaw};
    }
  }

  it('proxies singleton operations through the CRUD controller and rewrites contexts', async () => {
    const Controller = defineODataSingletonController(
      createDef(),
      CrudStub as any,
      {name: 'PrimaryLibrary', id: 1, nullable: true},
    );

    const controller = new (Controller as any)(
      {},
      {header: () => undefined},
      {},
      {},
      {},
      {},
      {},
      {},
    );

    assert.deepEqual(await controller.findById(), {
      '@odata.context': '/odata/$metadata#PrimaryLibrary',
      id: 1,
    });
    assert.deepEqual(await controller.update({name: 'Updated'}), {
      '@odata.context': '/odata/$metadata#PrimaryLibrary',
      id: 1,
      payload: {name: 'Updated'},
    });
    assert.deepEqual(await controller.replace({name: 'Replaced'}), {
      '@odata.context': '/odata/$metadata#PrimaryLibrary',
      id: 1,
      payload: {name: 'Replaced'},
    });
    assert.deepEqual(await controller.delete(), {
      '@odata.context': '/odata/$metadata#PrimaryLibrary',
      id: 1,
      deleted: true,
    });
    assert.deepEqual(await controller.getMediaValue(), {id: 1, media: true});
    assert.deepEqual(await controller.replaceMediaValue(Buffer.from('x')), {
      id: 1,
      body: Buffer.from('x'),
      replaced: true,
    });
    assert.deepEqual(await controller.deleteMediaValue(), {id: 1, deleted: true});
    assert.deepEqual(await controller.getPropertyValue('name'), {
      id: 1,
      property: 'name',
      raw: true,
    });
    assert.deepEqual(await controller.getProperty('name'), {
      '@odata.context': '/odata/$metadata#PrimaryLibrary/name/$entity',
      id: 1,
      property: 'name',
    });
    assert.deepEqual(await controller.linkNavigationRef('books', 1, '/odata/Books(2)'), {
      relationName: 'books',
      parentIdRaw: 1,
      targetUri: '/odata/Books(2)',
    });
    assert.deepEqual(await controller.unlinkNavigationRef('books', 1, '2'), {
      relationName: 'books',
      parentIdRaw: 1,
      targetKeyRaw: '2',
    });
  });

  it('rejects POST and non-nullable singleton deletes', async () => {
    const Controller = defineODataSingletonController(
      createDef(),
      CrudStub as any,
      {name: 'PrimaryLibrary', id: 1},
    );
    const controller = new (Controller as any)(
      {},
      {header: () => undefined},
      {},
      {},
      {},
      {},
      {},
      {},
    );

    await assert.rejects(() => controller.create(), (error: unknown) => {
      assert.ok(error instanceof HttpErrors.MethodNotAllowed);
      return true;
    });
    await assert.rejects(() => controller.delete(), (error: unknown) => {
      assert.ok(error instanceof HttpErrors.MethodNotAllowed);
      return true;
    });
  });

  it('resolves singleton ids dynamically and rejects missing entities', async () => {
    const DynamicController = defineODataSingletonController(
      createDef(),
      CrudStub as any,
      {
        name: 'SessionLibrary',
        resolveId: async () => 9,
        nullable: true,
      },
    );
    const dynamic = new (DynamicController as any)(
      {},
      {header: () => undefined},
      {},
      {},
      {},
      {},
      {},
      {},
    );
    assert.deepEqual(await dynamic.findById(), {
      '@odata.context': '/odata/$metadata#SessionLibrary',
      id: 9,
    });

    const MissingController = defineODataSingletonController(
      createDef(),
      CrudStub as any,
      {
        name: 'MissingLibrary',
        resolveId: async () => undefined,
      },
    );
    const missing = new (MissingController as any)(
      {},
      {header: () => undefined},
      {},
      {},
      {},
      {},
      {},
      {},
    );

    await assert.rejects(() => missing.findById(), (error: unknown) => {
      assert.ok(error instanceof HttpErrors.NotFound);
      return true;
    });
  });
});

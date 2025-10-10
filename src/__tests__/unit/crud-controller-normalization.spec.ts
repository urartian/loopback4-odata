import {Entity} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {defineODataCrudController} from '../../controllers/crud-controller-factory';
import {EntitySetDef} from '../../registry/entityset-registry';

describe('OData CRUD controller property normalization', () => {
  it('normalizes filters using repository model definitions when decorator metadata is missing', () => {
    class PlainModel extends Entity {}

    const initialDefinition = {
      properties: {},
      idProperties: () => ['id'],
      relations: {},
      settings: new Map(),
    } as any;

    (PlainModel as any).definition = initialDefinition;

    const def: EntitySetDef = {
      name: 'PlainModels',
      modelCtor: PlainModel as any,
      repositoryBindingKey: 'repositories.PlainModelRepository',
    };

    const ControllerCtor = defineODataCrudController(def);

    const runtimeDefinition = {
      properties: {
        id: {type: Number},
        name: {type: String},
      },
      idProperties: () => ['id'],
      relations: {},
      settings: new Map(),
    };

    (PlainModel as any).definition = runtimeDefinition;

    const repositoryStub = {
      entityClass: PlainModel,
      modelClass: PlainModel,
    } as any;

    const requestStub = {query: {}, get: () => undefined, headers: {}} as any;
    const responseStub = {headersSent: false, set() {}, getHeader() {}} as any;
    const httpCtxStub = {} as any;
    const configStub = {} as any;

    const controller = new (ControllerCtor as any)(
      repositoryStub,
      requestStub,
      responseStub,
      httpCtxStub,
      configStub,
    );

    const filter = {
      where: {ID: {neq: 'All'}},
      order: 'ID asc',
      fields: ['ID', 'name'],
    } as any;

    controller.normalizeFilterProperties(filter);

    expect(filter.where).to.eql({id: {neq: 'All'}});
    expect(filter.order).to.equal('id asc');
    expect(filter.fields).to.eql(['id', 'name']);
  });
});

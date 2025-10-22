import 'reflect-metadata';
import {Entity, model, property} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {defineODataCrudController} from '../../controllers/crud-controller-factory';
import {EntitySetDef} from '../../registry/entityset-registry';

describe('CRUD controller response normalization', () => {
  @model()
  class Invoice extends Entity {
    @property({id: true})
    id!: string;

    @property({type: 'date'})
    issuedAt?: Date;

    @property({type: 'string'})
    status?: string;
  }

  const def: EntitySetDef = {
    name: 'Invoices',
    modelCtor: Invoice,
    repositoryBindingKey: 'repositories.InvoiceRepository',
  };

  const Controller = defineODataCrudController(def);

  const createController = () =>
    new Controller(
      {} as any,
      {} as any,
      {set() {}, status() {return this;}, end() {}} as any,
      {} as any,
      {} as any,
      {} as any,
    );

  it('normalizes DateTimeOffset strings in decorated entities', () => {
    const controller = createController();
    const raw = {id: 'A1', issuedAt: '2025-10-22 00:00:00+00', status: 'sent'};
    const decorated = controller.decoratePlainEntity(raw);
    expect(decorated.issuedAt).to.equal('2025-10-22T00:00:00Z');
    expect(raw.issuedAt).to.equal('2025-10-22 00:00:00+00');
  });

  it('normalizes collections when ETags are disabled', () => {
    const controller = createController();
    const collection = controller.decoratePlainEntities([
      {id: 'A1', issuedAt: '2025-10-22 00:00:00+00'},
      {id: 'A2', issuedAt: '2025-11-05 12:30:00+0400'},
    ]);

    expect(collection[0].issuedAt).to.equal('2025-10-22T00:00:00Z');
    expect(collection[1].issuedAt).to.equal('2025-11-05T12:30:00+04:00');
  });

  it('normalizes toPlainEntity results derived from JSON payloads', () => {
    const controller = createController();
    const plain = controller.toPlainEntity({
      toJSON: () => ({id: 'A3', issuedAt: '2025-12-01 09:15:00+00'}),
    } as any);

    expect(plain).to.not.be.undefined();
    expect(plain).to.have.property('issuedAt', '2025-12-01T09:15:00Z');
  });

  it('preserves fractional seconds and offsets when normalizing', () => {
    const controller = createController();
    const decorated = controller.decoratePlainEntity({
      id: 'A4',
      issuedAt: '2025-12-01 09:15:00.1234567+0030',
    });
    expect(decorated.issuedAt).to.equal('2025-12-01T09:15:00.1234567+00:30');
  });
});

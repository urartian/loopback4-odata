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

    @property({type: 'number', jsonSchema: {format: 'int64'}})
    recordNo?: number;

    @property({
      type: 'array',
      itemType: 'number',
      jsonSchema: {type: 'array', items: {type: 'number', format: 'int64'}},
    })
    history?: number[];

    @property({type: 'number', jsonSchema: {format: 'decimal', precision: 18, scale: 6}})
    total?: number;

    @property({type: 'string', jsonSchema: {format: 'date'}})
    dueDate?: string;

    @property({type: 'string', jsonSchema: {format: 'time'}})
    startTime?: string;

    @property({type: 'string', jsonSchema: {format: 'duration'}})
    elapsed?: string;
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

  it('serializes Edm.Int64 values as strings with annotations', () => {
    const controller = createController();
    const decorated = controller.decoratePlainEntity({
      id: 'A5',
      recordNo: 42,
      history: [1, 2, 3],
    });

    expect(decorated.recordNo).to.equal('42');
    expect(decorated['recordNo@odata.type']).to.equal('Edm.Int64');
    expect(decorated.history).to.deepEqual(['1', '2', '3']);
    expect(decorated['history@odata.type']).to.equal('Collection(Edm.Int64)');

    const stringDecorated = controller.decoratePlainEntity({
      id: 'A6',
      recordNo: '9007199254740993' as any,
    });
    expect(stringDecorated.recordNo).to.equal('9007199254740993');
    expect(stringDecorated['recordNo@odata.type']).to.equal('Edm.Int64');
  });

  it('serializes decimals as IEEE754-compatible strings', () => {
    const controller = createController();
    const decorated = controller.decoratePlainEntity({
      id: 'A7',
      total: 0.000000123,
    });

    expect(decorated.total).to.equal('0.000000123');
    expect(decorated['total@odata.type']).to.equal('Edm.Decimal');
  });

  it('normalizes date-only inputs to canonical strings', () => {
    const controller = createController();
    const decorated = controller.decoratePlainEntity({
      id: 'A8',
      dueDate: '2025/01/15',
    });

    expect(decorated.dueDate).to.equal('2025-01-15');
  });

  it('normalizes time-of-day inputs from strings and milliseconds', () => {
    const controller = createController();
    const decorated = controller.decoratePlainEntity({
      id: 'A9',
      startTime: '9:05',
    });

    expect(decorated.startTime).to.equal('09:05:00');

    const millisDecorated = controller.decoratePlainEntity({
      id: 'A10',
      startTime: 90_500,
    } as any);
    expect(millisDecorated.startTime).to.equal('00:01:30.5');
  });

  it('normalizes duration inputs to ISO8601', () => {
    const controller = createController();
    const decorated = controller.decoratePlainEntity({
      id: 'A11',
      elapsed: '01:30:00',
    });

    expect(decorated.elapsed).to.equal('PT1H30M');

    const millisDecorated = controller.decoratePlainEntity({
      id: 'A12',
      elapsed: 1500,
    } as any);
    expect(millisDecorated.elapsed).to.equal('PT1.5S');
  });
});

import 'reflect-metadata';
import { AnyObject, Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { HttpErrors } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller $orderby validation', () => {
  @model()
  class Gadget extends Entity {
    @property({ id: true })
    id!: number;

    @property()
    name?: string;
  }

  const def: EntitySetDef = {
    name: 'Gadgets',
    modelCtor: Gadget,
    repositoryBindingKey: 'repositories.GadgetRepository',
  };

  const noopLogger: ODataLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  function createController(cfg: Partial<ODataConfig> = {}) {
    const Controller = defineODataCrudController(def);
    const resolvedConfig = {
      ...cfg,
      tokenSecret: cfg.tokenSecret ?? 'test-secret',
    } as ODataConfig;
    return new Controller(
      {} as any,
      {} as any,
      {
        set() {},
        status() {
          return this;
        },
        end() {},
      } as any,
      {} as any,
      resolvedConfig,
      {} as any,
      noopLogger,
      {
        check: async (_tenant?: string) => undefined,
        release: () => undefined,
      } as ODataTenantThrottler,
    );
  }

  it('rejects unknown $orderby fields even when strict mode is disabled', () => {
    const controller = createController({ strict: false });
    const filter = { order: ['nonexistent DESC'] };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.throw(
      HttpErrors.BadRequest,
      /Unknown property in \$orderby/i,
    );
  });

  it('accepts valid $orderby fields', () => {
    const controller = createController({ strict: false });
    const filter = { order: ['name ASC'] };

    expect(() => (controller as any).validateFieldsStrict(filter)).to.not.throw();
  });

  it('appends entity keys to manual $orderby when enabled', () => {
    const controller = createController({ appendKeysForClientPaging: true });
    const filter: AnyObject = { order: ['name DESC'], fields: ['name'] };

    const descriptors = (controller as any).ensureManualSkipOrderDeterminism(filter, ['id']);

    expect(descriptors?.map((item: AnyObject) => item.field)).to.eql(['name', 'id']);
    expect(filter.order).to.eql(['name DESC', 'id ASC']);
    expect(filter.fields).to.containEql('id');
  });

  it('respects appendKeysForClientPaging=false', () => {
    const controller = createController({ appendKeysForClientPaging: false });
    const filter: AnyObject = { order: ['name DESC'], fields: ['name'] };

    const descriptors = (controller as any).ensureManualSkipOrderDeterminism(filter, ['id']);

    expect(descriptors).to.be.undefined();
    expect(filter.order).to.eql(['name DESC']);
    expect(filter.fields).to.eql(['name']);
  });
});

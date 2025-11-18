import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller $count Accept negotiation', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;
  }

  const def: EntitySetDef = {
    name: 'Widgets',
    modelCtor: Widget,
    repositoryBindingKey: 'repositories.WidgetRepository',
  };

  const Controller = defineODataCrudController(def);

  const noopLogger: ODataLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const throttler: ODataTenantThrottler = {
    check: async () => undefined,
    release: () => undefined,
  };

  const baseRepo = {
    count: async () => ({ count: 5 }),
  };

  const createRequest = (accept?: string) =>
    ({
      query: {},
      headers: accept ? { accept } : {},
      get(header: string) {
        if (header.toLowerCase() === 'accept') return accept;
        return undefined;
      },
    }) as any;

  const createResponse = () => {
    const headers: Record<string, unknown> = {};
    return {
      headersSent: false,
      set(name: string, value: unknown) {
        headers[name.toLowerCase()] = value;
      },
      getHeader(name: string) {
        return headers[name.toLowerCase()];
      },
      type(value?: string) {
        if (value) {
          headers['content-type'] = value;
        }
        return this;
      },
      status() {
        return this;
      },
      once() {
        return this;
      },
    } as any;
  };

  const createController = (accept?: string, cfg?: Partial<ODataConfig>) => {
    const response = createResponse();
    const controller = new Controller(
      { ...baseRepo } as any,
      createRequest(accept),
      response,
      {} as any,
      { strict: true, ...(cfg ?? {}) } as ODataConfig,
      {} as any,
      noopLogger,
      throttler,
    );
    return { controller, response };
  };

  it('allows text/plain Accept headers for count responses', async () => {
    const { controller, response } = createController('text/plain');
    const result = await controller.count();
    expect(result).to.equal('5');
    expect(response.getHeader('content-type')).to.equal('text/plain');
  });

  it('allows text/* Accept headers for count responses', async () => {
    const { controller } = createController('text/*');
    const result = await controller.count();
    expect(result).to.equal('5');
  });

  it('rejects unsupported Accept headers for count responses', async () => {
    const { controller } = createController('text/html');
    await expect(controller.count()).to.be.rejectedWith(
      'Accept header must allow one of: application/json, text/plain.',
    );
  });

  it('rejects Accept headers that assign q=0 to supported types', async () => {
    const { controller } = createController('application/json;q=0, text/plain;q=0');
    await expect(controller.count()).to.be.rejectedWith(
      'Accept header must allow one of: application/json, text/plain.',
    );
  });
});

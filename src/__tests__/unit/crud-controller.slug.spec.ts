import 'reflect-metadata';
import { AnyObject, DefaultCrudRepository, Entity, model, property } from '@loopback/repository';
import { Request, RequestContext, Response } from '@loopback/rest';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';
import { ODataApplyExecutorRegistry } from '../../services/odata-apply-executor.registry';

@model()
class Widget extends Entity {
  @property({ id: true })
  id!: number;
}

describe('Slug handling for binary media entities', () => {
  const ControllerCtor = defineODataCrudController({
    name: 'Widgets',
    modelCtor: Widget,
    repositoryBindingKey: 'repositories.WidgetRepository',
  });

  const logger: ODataLogger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  const throttler: ODataTenantThrottler = {
    async check() {},
    release() {},
  };
  const request = { headers: {}, get: () => undefined } as unknown as Request;
  const response = {
    headersSent: false,
    set: () => undefined,
    status: () => undefined,
    once: () => undefined,
  } as unknown as Response;
  const httpCtx = {
    getSync: () => undefined,
  } as unknown as RequestContext;
  const cfg = { tokenSecret: 'slug-test' } as ODataConfig;
  const applyExecutors = {} as ODataApplyExecutorRegistry;

  function givenController() {
    const repository = {} as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;
    return new ControllerCtor(
      repository,
      request,
      response,
      httpCtx,
      cfg,
      applyExecutors,
      logger,
      throttler,
    );
  }

  it('coerces slug headers to BigInt without precision loss', () => {
    const controller = givenController();
    const slug = '9223372036854775807';

    const result = controller.coerceSlugValue(slug, { type: 'bigint' });

    expect(result).to.equal(BigInt(slug));
    expect(typeof result).to.equal('bigint');
  });

  it('rejects invalid BigInt slug values', () => {
    const controller = givenController();

    const result = controller.coerceSlugValue('not-a-number', { type: 'bigint' });

    expect(result).to.be.undefined();
  });

  it('coerces slug headers to booleans when literals are provided', () => {
    const controller = givenController();

    const trueResult = controller.coerceSlugValue('TRUE', { type: 'boolean' });
    const falseResult = controller.coerceSlugValue('false', { type: 'boolean' });

    expect(trueResult).to.be.true();
    expect(falseResult).to.be.false();
  });

  it('rejects invalid boolean slug values', () => {
    const controller = givenController();

    const result = controller.coerceSlugValue('not-a-boolean', { type: 'boolean' });

    expect(result).to.be.undefined();
  });
});

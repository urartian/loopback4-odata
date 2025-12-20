import 'reflect-metadata';
import { AnyObject, DefaultCrudRepository, Entity, model, property } from '@loopback/repository';
import { Request, RequestContext, Response } from '@loopback/rest';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataApplyExecutorRegistry } from '../../services/odata-apply-executor.registry';
import { ODataConfig } from '../../types';

@model()
class BigIdentifier extends Entity {
  @property({
    id: true,
    type: 'string',
    jsonSchema: { type: 'string', dataType: 'int64', format: 'int64' },
  })
  id!: bigint;
}

@model()
class RealBigIdentifier extends Entity {
  @property({
    id: true,
    type: () => BigInt,
    jsonSchema: { type: 'string', dataType: 'int64', format: 'int64' },
  })
  id!: bigint;
}

@model()
class BooleanIdentifier extends Entity {
  @property({ id: true, type: 'boolean' })
  id!: boolean;
}

describe('Identifier coercion', () => {
  const BigControllerCtor = defineODataCrudController({
    name: 'BigIdentifiers',
    modelCtor: BigIdentifier,
    repositoryBindingKey: 'repositories.BigIdentifierRepository',
  });
  const RealBigControllerCtor = defineODataCrudController({
    name: 'RealBigIdentifiers',
    modelCtor: RealBigIdentifier,
    repositoryBindingKey: 'repositories.RealBigIdentifierRepository',
  });
  const BooleanControllerCtor = defineODataCrudController({
    name: 'BooleanIdentifiers',
    modelCtor: BooleanIdentifier,
    repositoryBindingKey: 'repositories.BooleanIdentifierRepository',
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
  const cfg = { tokenSecret: 'identifier-test' } as ODataConfig;
  const applyExecutors = {} as ODataApplyExecutorRegistry;

  const repository = {} as unknown as DefaultCrudRepository<Entity & AnyObject, unknown>;

  const givenBigController = () =>
    new BigControllerCtor(
      repository,
      request,
      response,
      httpCtx,
      cfg,
      applyExecutors,
      logger,
      throttler,
    );

  const givenRealBigController = () =>
    new RealBigControllerCtor(
      repository,
      request,
      response,
      httpCtx,
      cfg,
      applyExecutors,
      logger,
      throttler,
    );

  const givenBooleanController = () =>
    new BooleanControllerCtor(
      repository,
      request,
      response,
      httpCtx,
      cfg,
      applyExecutors,
      logger,
      throttler,
    );

  it('returns validated string identifiers when property is declared as string', () => {
    const controller = givenBigController();
    const literal = '9223372036854775807';

    const result = controller.coerceParentId(literal);

    expect(result).to.equal(literal);
    expect(typeof result).to.equal('string');
  });

  it('rejects invalid BigInt identifiers', () => {
    const controller = givenBigController();

    expect(() => controller.coerceParentId('not-a-number')).to.throw(/Invalid identifier/);
  });

  it('coerces parent identifiers when property is declared as BigInt', () => {
    const controller = givenRealBigController();
    const literal = '9223372036854775807';

    const result = controller.coerceParentId(literal);

    expect(result).to.equal(BigInt(literal));
    expect(typeof result).to.equal('bigint');
  });

  it('coerces boolean navigation target identifiers', () => {
    const controller = givenBooleanController();
    const targetRepo = { entityClass: BooleanIdentifier } as AnyObject;

    const truthy = controller.coerceTargetId(targetRepo, 'true');
    const falsy = controller.coerceTargetId(targetRepo, 'false');

    expect(truthy).to.equal(true);
    expect(falsy).to.equal(false);
  });

  it('rejects malformed boolean navigation identifiers', () => {
    const controller = givenBooleanController();
    const targetRepo = { entityClass: BooleanIdentifier } as AnyObject;

    expect(() => controller.coerceTargetId(targetRepo, 'nope')).to.throw(/Invalid identifier/);
  });
});

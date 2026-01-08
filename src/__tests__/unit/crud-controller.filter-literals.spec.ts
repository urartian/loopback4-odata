import 'reflect-metadata';
import { Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { HttpErrors } from '@loopback/rest';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { ODataConfig } from '../../types';

describe('CRUD controller $filter typed literal coercion', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;

    @property({ type: Date })
    createdAt?: Date;

    @property({ type: 'string', jsonSchema: { type: 'string', format: 'date' } })
    birthDate?: string;

    @property({ type: 'string', jsonSchema: { type: 'string', format: 'uuid' } })
    sku?: string;

    @property({
      type: 'string',
      jsonSchema: { type: 'string', format: 'int64', dataType: 'int64' },
    })
    recordNo?: string;

    @property({
      type: 'string',
      jsonSchema: { type: 'string', format: 'decimal', dataType: 'decimal' },
    })
    total?: string;
  }

  const baseDef: EntitySetDef = {
    name: 'Widgets',
    modelCtor: Widget,
    repositoryBindingKey: 'repositories.WidgetRepository',
  };

  const noopLogger: ODataLogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const baseConfig: ODataConfig = { tokenSecret: 'test-secret', strict: true };

  const createController = (query: Record<string, string | string[] | undefined>, repo?: any) => {
    const Controller = defineODataCrudController(baseDef);
    const request = {
      query,
      get: () => undefined,
      headers: {},
    };
    const response = {
      headersSent: false,
      set() {},
      getHeader() {
        return undefined;
      },
      type() {
        return this;
      },
      status() {
        return this;
      },
      end() {},
      once() {},
    };
    const repository =
      repo ??
      ({
        find: async () => [],
        count: async () => ({ count: 0 }),
      } as any);

    return new Controller(
      repository,
      request as any,
      response as any,
      {} as any,
      baseConfig,
      {} as any,
      noopLogger,
      {
        check: async () => undefined,
        release: () => undefined,
      } as ODataTenantThrottler,
    );
  };

  it('coerces DateTimeOffset lexical to Date for Date properties', async () => {
    let captured: any;
    const controller = createController(
      { $filter: 'createdAt eq 2026-01-03T10:20:30Z' },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.createdAt).to.be.instanceOf(Date);
    expect((captured.where.createdAt as Date).toISOString()).to.equal('2026-01-03T10:20:30.000Z');
  });

  it("supports datetimeoffset'...' wrappers for DateTimeOffset literals", async () => {
    let captured: any;
    const controller = createController(
      { $filter: "createdAt eq datetimeoffset'2026-01-03T10:20:30Z'" },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.createdAt).to.be.instanceOf(Date);
    expect((captured.where.createdAt as Date).toISOString()).to.equal('2026-01-03T10:20:30.000Z');
  });

  it('coerces Edm.Date lexical to YYYY-MM-DD for date-only properties', async () => {
    let captured: any;
    const controller = createController(
      { $filter: 'birthDate eq 2026-01-03' },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.birthDate).to.equal('2026-01-03');
  });

  it('coerces Edm.Date lexical to Date for DateTimeOffset properties', async () => {
    let captured: any;
    const controller = createController(
      { $filter: 'createdAt eq 2026-01-03' },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.createdAt).to.be.instanceOf(Date);
    expect((captured.where.createdAt as Date).toISOString()).to.equal('2026-01-03T00:00:00.000Z');
  });

  it('normalizes GUID literals for GUID properties', async () => {
    let captured: any;
    const controller = createController(
      { $filter: "sku eq guid'01234567-89AB-CDEF-0123-456789ABCDEF'" },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.sku).to.equal('01234567-89ab-cdef-0123-456789abcdef');
  });

  it('coerces Int64 literals to strings for Int64 properties', async () => {
    let captured: any;
    const controller = createController(
      { $filter: 'recordNo eq 123L' },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.recordNo).to.equal('123');
  });

  it('preserves large integer lexemes so Int64 properties can accept them as strings', async () => {
    let captured: any;
    const controller = createController(
      { $filter: 'recordNo eq 12345678901234567890' },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.recordNo).to.equal('12345678901234567890');
  });

  it('handles maximum int64 value correctly without precision loss', async () => {
    let captured: any;
    const controller = createController(
      { $filter: "recordNo eq int64'9223372036854775807'" },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.recordNo).to.equal('9223372036854775807');
  });

  it("supports decimal'...' wrappers for Decimal literals", async () => {
    let captured: any;
    const controller = createController(
      { $filter: "total eq decimal'123.45'" },
      {
        find: async (filter: any) => {
          captured = filter;
          return [];
        },
        count: async () => ({ count: 0 }),
      },
    );

    await controller.list();
    expect(captured.where.total).to.equal('123.45');
  });

  it('rejects invalid Int64 literals with stable error code', async () => {
    const controller = createController({ $filter: 'recordNo eq 123.4L' });
    try {
      await controller.list();
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.BadRequest);
      expect((err as Error).message).to.match(/Invalid Int64 literal/i);
      expect((err as any).code).to.equal('invalid-int64-literal');
    }
  });

  it('rejects invalid DateTimeOffset literals with stable error code', async () => {
    const controller = createController({ $filter: 'createdAt eq 2026-99-99T00:00:00Z' });
    try {
      await controller.list();
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.BadRequest);
      expect((err as any).code).to.equal('invalid-datetimeoffset-literal');
    }
  });

  it('rejects invalid GUID literals with stable error code', async () => {
    const controller = createController({ $filter: "sku eq guid'not-a-guid'" });
    try {
      await controller.list();
    } catch (err) {
      expect(err).to.be.instanceOf(HttpErrors.BadRequest);
      expect((err as any).code).to.equal('invalid-guid-literal');
    }
  });
});

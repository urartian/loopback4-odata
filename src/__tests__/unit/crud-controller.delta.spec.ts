import 'reflect-metadata';
import { AnyObject, Entity, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import { defineODataCrudController } from '../../controllers/crud-controller-factory';
import { EntitySetDef } from '../../registry/entityset-registry';
import { ODataLogger, ODataTenantThrottler } from '../../keys';
import { decodeDeltaToken } from '../../util/delta-token';
import { ODataConfig } from '../../types';

describe('CRUD controller delta helpers', () => {
  @model()
  class Widget extends Entity {
    @property({ id: true })
    id!: number;

    @property({ type: 'date' })
    updatedAt?: Date;
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

  const throttleStub: ODataTenantThrottler = {
    check: async () => undefined,
    release: () => undefined,
  };

  const responseStub = {
    set() {},
    status() {
      return this;
    },
    end() {},
  };

  const createController = (options?: {
    request?: Record<string, unknown>;
    config?: Partial<ODataConfig>;
  }) => {
    const request = {
      query: {},
      path: '/odata/Widgets',
      baseUrl: '',
      originalUrl: '/odata/Widgets',
      get: () => undefined,
      header: () => undefined,
      accepts: () => [],
      ...options?.request,
    };
    const cfg: ODataConfig = {
      tokenSecret: 'delta-secret',
      ...(options?.config ?? {}),
    } as ODataConfig;
    return new Controller(
      {} as any,
      request as any,
      responseStub as any,
      {} as any,
      cfg,
      {} as any,
      noopLogger,
      throttleStub,
    );
  };

  it('uses the final visible row when generating delta tokens', () => {
    const controller = createController();
    const rows = [
      { id: 3, updatedAt: new Date('2024-01-03T00:00:00Z') },
      { id: 2, updatedAt: new Date('2024-01-02T00:00:00Z') },
      { id: 1, updatedAt: new Date('2024-01-01T00:00:00Z') },
    ];
    const pageRows = rows.slice(0, 2);

    const token = (controller as any).createDeltaTokenForRows(
      'Widgets',
      rows,
      'updatedAt',
      ['id'],
      undefined,
      undefined,
      pageRows,
    );
    const payload = decodeDeltaToken(token, {
      secret: 'delta-secret',
      allowLegacyUnsigned: false,
    });

    expect(payload.lastValue).to.equal('2024-01-02T00:00:00.000Z');
    expect(payload.keyValues).to.containDeep({ id: 2 });
    expect(payload.pageKeys).to.containDeep([{ id: 3 }, { id: 2 }]);
  });

  it('builds next links using the originalUrl path when available', () => {
    const controller = createController({
      request: {
        query: { $top: '5' },
        path: '/odata/Widgets',
        originalUrl: '/api/odata/Widgets?$top=5',
      },
    });

    const link = controller.buildNextLink('cursor');

    expect(link).to.equal('/api/odata/Widgets?%24top=5&%24skiptoken=cursor');
  });

  it('falls back to baseUrl when originalUrl is missing for delta links', () => {
    const controller = createController({
      request: {
        query: {},
        baseUrl: '/api',
        path: '/odata/Widgets',
        originalUrl: undefined,
      },
    });

    const link = controller.buildDeltaLink('delta');

    expect(link).to.equal('/api/odata/Widgets?%24deltatoken=delta');
  });

  it('captures page keys separately from the overall cursor', () => {
    const controller = createController();
    const allRows = [
      { id: 3, updatedAt: new Date('2024-01-03T00:00:00Z') },
      { id: 2, updatedAt: new Date('2024-01-02T00:00:00Z') },
      { id: 1, updatedAt: new Date('2024-01-01T00:00:00Z') },
    ];
    const pageRows = allRows.slice(0, 2);

    const token = (controller as any).createDeltaTokenForRows(
      'Widgets',
      allRows,
      'updatedAt',
      ['id'],
      undefined,
      undefined,
      pageRows,
    );
    const payload = decodeDeltaToken(token, {
      secret: 'delta-secret',
      allowLegacyUnsigned: false,
    });

    expect(payload.keyValues).to.containDeep({ id: 2 });
    expect(payload.pageKeys).to.containDeep([{ id: 3 }, { id: 2 }]);
  });

  it('skips tombstones when determining the page cursor', () => {
    const controller = createController();
    const rows = [
      { id: 5, updatedAt: new Date('2024-01-05T00:00:00Z') },
      { id: 4, updatedAt: new Date('2024-01-04T00:00:00Z') },
    ];
    const pageRows = [
      rows[0],
      { id: 99, updatedAt: new Date('2024-01-04T12:00:00Z'), '@removed': { reason: 'deleted' } },
      rows[1],
      { id: 100, updatedAt: new Date('2024-01-03T00:00:00Z'), '@removed': { reason: 'deleted' } },
    ];

    const token = (controller as any).createDeltaTokenForRows(
      'Widgets',
      rows,
      'updatedAt',
      ['id'],
      undefined,
      undefined,
      pageRows,
    );
    const payload = decodeDeltaToken(token, {
      secret: 'delta-secret',
      allowLegacyUnsigned: false,
    });

    expect(payload.keyValues).to.containDeep({ id: 4 });
    expect(payload.pageKeys).to.containDeep([{ id: 5 }, { id: 4 }]);
  });

  it('falls back when page rows only contain tombstones', () => {
    const controller = createController();
    const pageRows = [
      { id: 101, updatedAt: new Date('2024-01-03T00:00:00Z'), '@removed': { reason: 'deleted' } },
    ];

    const token = (controller as any).createDeltaTokenForRows(
      'Widgets',
      [],
      'updatedAt',
      ['id'],
      undefined,
      undefined,
      pageRows,
    );
    const payload = decodeDeltaToken(token, {
      secret: 'delta-secret',
      allowLegacyUnsigned: false,
    });

    expect(payload.keyValues).to.be.undefined();
    expect(payload.pageKeys).to.be.undefined();
  });

  it('reissues delta tokens for empty grouped pages instead of reusing stale bucket state', () => {
    const controller = createController();
    const previousToken = (controller as any).createDeltaTokenForRows(
      'Widgets',
      [{ id: 8, updatedAt: new Date('2024-01-08T00:00:00Z') }],
      'updatedAt',
      ['id'],
      undefined,
      [{ key: { region: 'west' }, data: { total: 1 } }],
      [{ id: 8, updatedAt: new Date('2024-01-08T00:00:00Z') }],
    );
    const previousPayload = decodeDeltaToken(previousToken, {
      secret: 'delta-secret',
      allowLegacyUnsigned: false,
    });

    const nextToken = (controller as any).createDeltaTokenForRows(
      'Widgets',
      [],
      'updatedAt',
      ['id'],
      previousToken,
      [],
      [],
    );
    const nextPayload = decodeDeltaToken(nextToken, {
      secret: 'delta-secret',
      allowLegacyUnsigned: false,
    });

    expect(nextToken).to.not.equal(previousToken);
    expect(nextPayload.lastValue).to.equal(previousPayload.lastValue);
    expect(nextPayload.buckets).to.be.undefined();
  });

  it('anchors on source rows when filtered page rows are empty', () => {
    const controller = createController();
    const rows = [{ id: 7, updatedAt: new Date('2024-01-07T00:00:00Z') }];
    const pageRows = [
      { id: 200, updatedAt: new Date('2024-01-08T00:00:00Z'), '@removed': { reason: 'deleted' } },
    ];

    const token = (controller as any).createDeltaTokenForRows(
      'Widgets',
      rows,
      'updatedAt',
      ['id'],
      undefined,
      undefined,
      pageRows,
    );
    const payload = decodeDeltaToken(token, {
      secret: 'delta-secret',
      allowLegacyUnsigned: false,
    });

    expect(payload.keyValues).to.containDeep({ id: 7 });
    expect(payload.pageKeys).to.containDeep([{ id: 7 }]);
  });

  it('round-trips bigint bucket state without crashing token generation', () => {
    const controller = createController();

    const token = (controller as any).createDeltaTokenForRows(
      'Widgets',
      [{ id: 9, updatedAt: new Date('2024-01-09T00:00:00Z') }],
      'updatedAt',
      ['id'],
      undefined,
      [
        {
          key: { bucketId: BigInt(10) },
          data: {
            total: BigInt(11),
            nested: { count: BigInt(12) },
            values: [BigInt(13)],
          },
        },
      ],
      [{ id: 9, updatedAt: new Date('2024-01-09T00:00:00Z') }],
    );
    const payload = decodeDeltaToken(token, {
      secret: 'delta-secret',
      allowLegacyUnsigned: false,
    });

    expect(payload.buckets).to.have.length(1);
    expect(payload.buckets?.[0]).to.deepEqual({
      key: { bucketId: BigInt(10) },
      data: {
        total: BigInt(11),
        nested: { count: BigInt(12) },
        values: [BigInt(13)],
      },
    });
  });

  it('emits tombstones for missing page keys', async () => {
    const controller = createController();
    (controller as AnyObject).repository = {
      findOne: async ({ where }: { where: AnyObject }) => {
        if ((where as AnyObject).id === 2) return undefined;
        return { id: (where as AnyObject).id };
      },
    };

    const tombstones = await (controller as any).computeTombstones([
      { id: 2 },
      { id: 3 },
      { id: 2 },
    ]);

    expect(tombstones).to.have.length(1);
    expect(tombstones[0]).to.containDeep({
      id: 2,
      '@removed': { reason: 'deleted' },
    });
  });

  it('deduplicates bigint tombstone candidates without throwing', async () => {
    const controller = createController();
    (controller as AnyObject).repository = {
      findOne: async () => undefined,
    };

    const tombstones = await (controller as any).computeTombstones([
      { id: BigInt(2) },
      { id: BigInt(2) },
    ]);

    expect(tombstones).to.have.length(1);
    expect(tombstones[0]).to.containDeep({
      id: BigInt(2),
      '@removed': { reason: 'deleted' },
    });
  });
});

import { Client, createRestAppClient, expect } from '@loopback/testlab';
import { Constructor, inject } from '@loopback/core';
import {
  DefaultCrudRepository,
  Entity,
  juggler,
  model,
  property,
} from '@loopback/repository';
import { ODataComponent, odataController, odataModel } from '../../';
import { TestApplication } from '../fixtures/odata-app.fixture';
import { ODATA_BINDINGS } from '../../keys';
import { ODataConfig } from '../../types';

const MEMORY_DS_CONFIG = {
  name: 'db',
  connector: 'memory',
};

@odataModel()
class InternalEntity extends Entity {
  @property({ type: 'number', id: true, generated: true })
  id?: number;

  @property({ type: 'string' })
  name?: string;
}

@odataModel()
@model()
class PublishedEntity extends Entity {
  @property({ type: 'number', id: true, generated: true })
  id?: number;

  @property({ type: 'string' })
  name?: string;
}

@odataModel({ documentInOpenApi: true })
class OptInEntity extends Entity {
  @property({ type: 'number', id: true, generated: true })
  id?: number;

  @property({ type: 'string' })
  name?: string;
}

@odataModel({ documentInOpenApi: false })
@model()
class SuppressedEntity extends Entity {
  @property({ type: 'number', id: true, generated: true })
  id?: number;

  @property({ type: 'string' })
  name?: string;
}

class InternalEntityRepository extends DefaultCrudRepository<
  InternalEntity,
  typeof InternalEntity.prototype.id
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(InternalEntity, dataSource);
  }
}

class PublishedEntityRepository extends DefaultCrudRepository<
  PublishedEntity,
  typeof PublishedEntity.prototype.id
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(PublishedEntity, dataSource);
  }
}

class OptInEntityRepository extends DefaultCrudRepository<
  OptInEntity,
  typeof OptInEntity.prototype.id
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(OptInEntity, dataSource);
  }
}

class SuppressedEntityRepository extends DefaultCrudRepository<
  SuppressedEntity,
  typeof SuppressedEntity.prototype.id
> {
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(SuppressedEntity, dataSource);
  }
}

@odataController(InternalEntity)
class InternalEntityController {}

@odataController(PublishedEntity)
class PublishedEntityController {}

@odataController(OptInEntity)
class OptInEntityController {}

@odataController(SuppressedEntity)
class SuppressedEntityController {}

type EntityKey = 'internal' | 'published' | 'optIn' | 'suppressed';
type CrudRepositoryCtor = new (dataSource: juggler.DataSource) => DefaultCrudRepository<any, any>;

const ENTITY_SETUPS: Record<EntityKey, { repository: CrudRepositoryCtor; controller: Constructor<unknown> }> = {
  internal: { repository: InternalEntityRepository, controller: InternalEntityController },
  published: { repository: PublishedEntityRepository, controller: PublishedEntityController },
  optIn: { repository: OptInEntityRepository, controller: OptInEntityController },
  suppressed: { repository: SuppressedEntityRepository, controller: SuppressedEntityController },
};

interface VisibilityAppOptions {
  entities: EntityKey[];
  config?: Partial<ODataConfig>;
}

async function givenVisibilityApp(options: VisibilityAppOptions): Promise<TestApplication> {
  const app = new TestApplication({ port: 0, host: '127.0.0.1' });
  const dataSource = new juggler.DataSource(MEMORY_DS_CONFIG);
  app.dataSource(dataSource, MEMORY_DS_CONFIG.name);
  app.component(ODataComponent);

  for (const key of options.entities) {
    const setup = ENTITY_SETUPS[key];
    app.repository(setup.repository);
    app.controller(setup.controller);
  }

  if (options.config) {
    const current = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
    Object.assign(current, options.config);
  }

  await app.boot();
  await app.start();
  return app;
}

async function withVisibilityApp<T>(
  options: VisibilityAppOptions,
  fn: (app: TestApplication) => Promise<T>,
): Promise<T> {
  const app = await givenVisibilityApp(options);
  try {
    return await fn(app);
  } finally {
    await app.stop();
  }
}

function findPaths(paths: Record<string, unknown> | undefined, fragment: string): string[] {
  if (!paths) return [];
  return Object.keys(paths).filter((path) => path.includes(fragment));
}

describe('OData OpenAPI visibility', () => {
  it('hides @odataModel-only entity sets by default', async () => {
    await withVisibilityApp({ entities: ['internal', 'published'] }, async (app) => {
      const spec = await app.restServer.getApiSpec();
      const paths = spec.paths ?? {};
      expect(findPaths(paths, 'InternalEntities')).to.be.empty();
      const published = paths['/odata/PublishedEntities'] as Record<string, any> | undefined;
      expect(published).to.be.Object();
      expect(published?.get).to.be.Object();
      expect(published?.get?.['x-visibility']).to.equal('documented');
    });
  });

  it('exposes entity sets opting into documentation', async () => {
    await withVisibilityApp({ entities: ['optIn'] }, async (app) => {
      const spec = await app.restServer.getApiSpec();
      const paths = spec.paths ?? {};
      const optIn = paths['/odata/OptInEntities'] as Record<string, any> | undefined;
      expect(optIn).to.be.Object();
      expect(optIn?.get?.['x-visibility']).to.equal('documented');
    });
  });

  it('honors documentInOpenApi(false) even when @model is present', async () => {
    await withVisibilityApp({ entities: ['suppressed', 'published'] }, async (app) => {
      const spec = await app.restServer.getApiSpec();
      const paths = spec.paths ?? {};
      expect(findPaths(paths, 'SuppressedEntities')).to.be.empty();
      const published = paths['/odata/PublishedEntities'] as Record<string, any> | undefined;
      expect(published).to.be.Object();
      expect(published?.get?.['x-visibility']).to.equal('documented');
    });
  });

  it('retains and retags hidden routes when removal is disabled', async () => {
    await withVisibilityApp(
      { entities: ['internal', 'published'], config: { removeUndocumentedFromSpec: false } },
      async (app) => {
        const spec = await app.restServer.getApiSpec();
        const cfg = app.getSync(ODATA_BINDINGS.CONFIG) as ODataConfig;
        expect(cfg.removeUndocumentedFromSpec).to.be.false();
        const client: Client = createRestAppClient(app);
        await client.get('/odata/PublishedEntities').expect(200);
        await client.get('/odata/InternalEntities').expect(200);
        const rawPaths = (app.restServer as any).httpHandler.describeApiPaths();
        expect(Object.keys(rawPaths)).to.containEql('/odata/InternalEntities');
        const registry = (await app.get(ODATA_BINDINGS.ENTITY_SET_REGISTRY)) as any;
        expect(
          registry
            .list()
            .map((def: any) => `${def.name}:${def.documentInOpenApi}`),
        ).to.containEql('InternalEntities:false');
        const paths = spec.paths ?? {};
        const published = paths['/odata/PublishedEntities'] as Record<string, any> | undefined;
        expect(published).to.be.Object();
        expect(Object.keys(paths)).to.containEql('/odata/InternalEntities');
        const internal = paths['/odata/InternalEntities'] as Record<string, any> | undefined;
        expect(internal).to.be.Object();
        expect(internal?.get?.['x-visibility']).to.equal('internal');
        expect(internal?.get?.['x-odata-generated']).to.be.true();
      },
    );
  });

  it('publishes @odataModel-only sets when the global default is true', async () => {
    await withVisibilityApp(
      { entities: ['internal'], config: { documentInOpenApiDefault: true } },
      async (app) => {
        const spec = await app.restServer.getApiSpec();
        const internal = spec.paths?.['/odata/InternalEntities'] as Record<string, any> | undefined;
        expect(internal).to.be.Object();
        expect(internal?.get?.['x-visibility']).to.equal('documented');
      },
    );
  });

  it('hides @model-annotated sets when the global default is false unless they opt in', async () => {
    await withVisibilityApp(
      { entities: ['published', 'optIn'], config: { documentInOpenApiDefault: false } },
      async (app) => {
        const spec = await app.restServer.getApiSpec();
        const paths = spec.paths ?? {};
        expect(findPaths(paths, 'PublishedEntities')).to.be.empty();
        const optIn = paths['/odata/OptInEntities'] as Record<string, any> | undefined;
        expect(optIn).to.be.Object();
        expect(optIn?.get?.['x-visibility']).to.equal('documented');
      },
    );
  });
});

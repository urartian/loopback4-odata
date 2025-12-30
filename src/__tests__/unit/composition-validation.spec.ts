import 'reflect-metadata';
import { Entity, hasMany, model, property } from '@loopback/repository';
import { expect } from '@loopback/testlab';
import {
  validateCompositionCascadeCycles,
  validateCompositionResolvedConfig,
} from '../../util/composition-validation';
import { EntitySetRegistry } from '../../registry/entityset-registry';
import { ODataLogger } from '../../keys';

describe('Composition validation', () => {
  const captureLogger = () => {
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger: ODataLogger = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (message, context) => warnings.push({ message, context }),
      error: () => undefined,
    };
    return { logger, warnings };
  };

  it('ignores invalid relation config when strict=false', () => {
    @model()
    class Parent extends Entity {
      @property({ id: true })
      id!: number;
    }

    const { logger, warnings } = captureLogger();
    const resolved = validateCompositionResolvedConfig({
      entitySetName: 'Parents',
      modelCtor: Parent,
      modelDefinition: (Parent as any).definition,
      resolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { missing: { delete: 'cascade' } },
      },
      strict: false,
      logger,
    });

    expect(resolved).to.equal(undefined);
    expect(warnings.some((w) => w.context?.event === 'composition.invalid-relation')).to.equal(
      true,
    );
  });

  it('throws for invalid relation config when strict=true', () => {
    @model()
    class Parent extends Entity {
      @property({ id: true })
      id!: number;
    }

    expect(() =>
      validateCompositionResolvedConfig({
        entitySetName: 'Parents',
        modelCtor: Parent,
        modelDefinition: (Parent as any).definition,
        resolved: {
          enforcement: 'application',
          defaultDeletePolicy: 'restrict',
          requireTransactionSupport: true,
          maxDepth: 8,
          maxEntities: 5000,
          relations: { missing: { delete: 'cascade' } },
        },
        strict: true,
      }),
    ).to.throw(/Invalid composition relation config/);
  });

  it('detects cascade config cycles at boot', () => {
    @model()
    class A extends Entity {
      @property({ id: true })
      id!: number;

      @property()
      bId?: number;

      @hasMany(() => B, { keyTo: 'aId' })
      bs?: B[];
    }

    @model()
    class B extends Entity {
      @property({ id: true })
      id!: number;

      @property()
      aId?: number;

      @hasMany(() => A, { keyTo: 'bId' })
      as?: A[];
    }

    const registry = new EntitySetRegistry();
    registry.register({
      name: 'As',
      modelCtor: A,
      repositoryBindingKey: 'repositories.ARepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { bs: { delete: 'cascade' } },
      },
    } as any);
    registry.register({
      name: 'Bs',
      modelCtor: B,
      repositoryBindingKey: 'repositories.BRepo',
      compositionResolved: {
        enforcement: 'application',
        defaultDeletePolicy: 'restrict',
        requireTransactionSupport: true,
        maxDepth: 8,
        maxEntities: 5000,
        relations: { as: { delete: 'cascade' } },
      },
    } as any);

    expect(() =>
      validateCompositionCascadeCycles({
        registry,
        strict: true,
      }),
    ).to.throw(/Composition cascade cycle detected/);
  });
});

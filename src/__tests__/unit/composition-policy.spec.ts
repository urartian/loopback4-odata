import 'reflect-metadata';
import { expect } from '@loopback/testlab';
import { resolveCompositionConfigForEntitySet } from '../../util/composition-policy';
import { ODataConfig } from '../../types';

describe('Composition policy resolver', () => {
  it('merges relation configs with correct precedence', () => {
    const globalConfig: ODataConfig = {
      tokenSecret: 'test-secret',
      composition: {
        defaultDeletePolicy: 'restrict',
        entitySets: {
          Orders: {
            relations: {
              items: { delete: 'restrict' },
              notes: {},
              globalOnly: { delete: 'cascade' },
            },
          },
        },
      },
    };

    const modelMeta = {
      composition: {
        relations: {
          items: { delete: 'cascade' },
          notes: {},
          decoratorOnly: { delete: 'cascade' },
        },
      },
    } as any;

    const registryDef = {
      name: 'Orders',
      composition: {
        relations: {
          items: { delete: 'restrict' },
          registryOnly: { delete: 'cascade' },
        },
      },
    } as any;

    const resolved = resolveCompositionConfigForEntitySet({
      entitySetName: 'Orders',
      modelMeta,
      registryDef,
      globalConfig,
    });

    expect(resolved).to.containEql({
      enforcement: 'database',
      defaultDeletePolicy: 'restrict',
      requireTransactionSupport: true,
      maxDepth: 8,
      maxEntities: 5000,
    });
    expect(resolved?.relations.items.delete).to.equal('restrict'); // registry wins
    expect(resolved?.relations.notes.delete).to.equal('restrict'); // present, inherits default
    expect(resolved?.relations.globalOnly.delete).to.equal('cascade'); // global only
    expect(resolved?.relations.decoratorOnly.delete).to.equal('cascade'); // decorator only
    expect(resolved?.relations.registryOnly.delete).to.equal('cascade'); // registry only
  });

  it('returns undefined when no relations are configured', () => {
    const resolved = resolveCompositionConfigForEntitySet({
      entitySetName: 'Orders',
      globalConfig: { tokenSecret: 'test-secret' } as ODataConfig,
    });
    expect(resolved).to.equal(undefined);
  });
});

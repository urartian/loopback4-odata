import { expect } from '@loopback/testlab';
import { OpenApiSpec } from '@loopback/openapi-v3';
import { ODataVisibilitySpecEnhancer } from '../../spec/odata-visibility.spec-enhancer';
import { ODataConfig } from '../../types';

function buildSpec(): OpenApiSpec {
  return {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: {
      '/odata/InternalEntities': {
        get: {
          'x-odata-generated': true,
          'x-odata-visibility': 'undocumented',
          responses: { '200': { description: 'ok' } },
        },
        post: {
          'x-odata-generated': true,
          'x-odata-visibility': 'documented',
          responses: { '200': { description: 'ok' } },
        },
      },
      '/odata/HiddenOnly': {
        get: {
          'x-odata-generated': true,
          'x-odata-visibility': 'undocumented',
          responses: { '200': { description: 'ok' } },
        },
      },
      '/custom': {
        get: {
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: {},
  };
}

describe('ODataVisibilitySpecEnhancer', () => {
  it('removes undocumented generated operations when configured to prune', () => {
    const enhancer = new ODataVisibilitySpecEnhancer({
      removeUndocumentedFromSpec: true,
    } as ODataConfig);
    const spec = buildSpec();
    enhancer.modifySpec(spec);

    expect(spec.paths?.['/odata/HiddenOnly']).to.be.undefined();
    const internal = spec.paths?.['/odata/InternalEntities'] as Record<string, any> | undefined;
    expect(internal).to.be.Object();
    expect(internal?.get).to.be.undefined();
    expect(internal?.post).to.be.Object();
    const custom = spec.paths?.['/custom'] as Record<string, any> | undefined;
    expect(custom?.get).to.be.Object();
  });

  it('retags undocumented operations as internal when pruning is disabled', () => {
    const enhancer = new ODataVisibilitySpecEnhancer({
      removeUndocumentedFromSpec: false,
    } as ODataConfig);
    const spec = buildSpec();
    enhancer.modifySpec(spec);

    const hidden = spec.paths?.['/odata/HiddenOnly'] as Record<string, any> | undefined;
    expect(hidden).to.be.Object();
    expect(hidden?.get?.['x-visibility']).to.equal('internal');
    expect(hidden?.get?.['x-odata-generated']).to.be.true();

    const internal = spec.paths?.['/odata/InternalEntities'] as Record<string, any> | undefined;
    expect(internal?.get?.['x-visibility']).to.equal('internal');
    expect(internal?.post?.['x-visibility']).to.equal('documented');
  });
});

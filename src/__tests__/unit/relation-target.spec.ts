/// <reference path="../../types/testing.globals.d.ts" />

import {AnyObject, Entity, ModelDefinition} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {resolveRelationTarget} from '../../util/relation-target';
import {
  ModelPropSource,
  ModelPropTarget,
  StringSource,
  StringTarget,
} from '../fixtures/navigation-models';

describe('relation target resolver', () => {
  it('retries name-based lookups after an initial cache miss', () => {
    class DynamicSource extends Entity {}
    const sourceDef = new ModelDefinition('DynamicSource');
    sourceDef.addProperty('id', {type: 'number', id: true});
    sourceDef.addProperty('dynamicTargetId', {type: 'number'});

    const relationMeta = {
      name: 'dynamic',
      type: 'hasOne',
      targetsMany: false,
      source: DynamicSource,
      target: 'DynamicTarget',
      keyFrom: 'id',
      keyTo: 'dynamicTargetId',
    } as AnyObject;

    (sourceDef.relations as AnyObject) = {dynamic: relationMeta};
    (DynamicSource as AnyObject).definition = sourceDef;

    expect(resolveRelationTarget(relationMeta)).to.be.undefined();

    class DynamicTarget extends Entity {}
    const targetDef = new ModelDefinition('DynamicTarget');
    targetDef.addProperty('id', {type: 'number', id: true});
    (DynamicTarget as AnyObject).definition = targetDef;

    const moduleId = '/virtual/dynamic-target.js';
    (require.cache as AnyObject)[moduleId] = {
      id: moduleId,
      filename: moduleId,
      loaded: true,
      exports: {DynamicTarget},
    } as unknown as NodeModule;

    try {
      expect(resolveRelationTarget(relationMeta)).to.equal(DynamicTarget);
    } finally {
      delete (require.cache as AnyObject)[moduleId];
    }
  });

  it('resolves target constructor stored under "model" metadata', () => {
    const relationMeta = ((ModelPropSource as AnyObject).definition.relations as AnyObject)
      .modelRel as AnyObject;

    expect(resolveRelationTarget({...relationMeta})).to.equal(ModelPropTarget);
  });

  it('resolves when target resolver returns a model name string', () => {
    const baseMeta = ((StringSource as AnyObject).definition.relations as AnyObject)
      .stringRel as AnyObject;

    const relationMeta = {
      ...baseMeta,
      target: undefined,
      targetResolver: () => 'StringTarget',
    } as AnyObject;

    const moduleId = '/virtual/string-target.js';
    (require.cache as AnyObject)[moduleId] = {
      id: moduleId,
      filename: moduleId,
      loaded: true,
      exports: {StringTarget},
    } as unknown as NodeModule;

    try {
      expect(resolveRelationTarget(relationMeta)).to.equal(StringTarget);
    } finally {
      delete (require.cache as AnyObject)[moduleId];
    }
  });
});

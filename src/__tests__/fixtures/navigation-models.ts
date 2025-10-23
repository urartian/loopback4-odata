import {AnyObject, Entity, ModelDefinition} from '@loopback/repository';

export class StringTarget extends Entity {}
export class StringSource extends Entity {}

const stringTargetDef = new ModelDefinition('StringTarget');
stringTargetDef.addProperty('id', {type: 'number', id: true});
(StringTarget as AnyObject).definition = stringTargetDef;

const stringSourceDef = new ModelDefinition('StringSource');
stringSourceDef.addProperty('id', {type: 'number', id: true});
stringSourceDef.addProperty('stringTargetId', {type: 'number'});
(stringSourceDef.relations as AnyObject) = {
  stringRel: {
    name: 'stringRel',
    type: 'hasOne',
    targetsMany: false,
    source: StringSource,
    target: 'StringTarget',
    keyFrom: 'id',
    keyTo: 'stringTargetId',
  } as AnyObject,
} as AnyObject;
(StringSource as AnyObject).definition = stringSourceDef;

export class ModelPropTarget extends Entity {}
export class ModelPropSource extends Entity {}

const modelPropTargetDef = new ModelDefinition('ModelPropTarget');
modelPropTargetDef.addProperty('id', {type: 'number', id: true});
(ModelPropTarget as AnyObject).definition = modelPropTargetDef;

const modelPropSourceDef = new ModelDefinition('ModelPropSource');
modelPropSourceDef.addProperty('id', {type: 'number', id: true});
modelPropSourceDef.addProperty('modelPropTargetId', {type: 'number'});
(modelPropSourceDef.relations as AnyObject) = {
  modelRel: {
    name: 'modelRel',
    type: 'hasOne',
    targetsMany: false,
    source: ModelPropSource,
    keyFrom: 'id',
    keyTo: 'modelPropTargetId',
    model: ModelPropTarget,
  } as AnyObject,
} as AnyObject;
(ModelPropSource as AnyObject).definition = modelPropSourceDef;

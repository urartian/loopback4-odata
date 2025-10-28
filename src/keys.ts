import { BindingKey } from '@loopback/core';
import { ODataConfig } from './types';
import { CsdlGenerator } from './metadata/csdl-generator';
import { EntitySetRegistry } from './registry/entityset-registry';
import { ODataApplyExecutorRegistry } from './services/odata-apply-executor.registry';

export const ODATA_BINDINGS = {
  CONFIG: BindingKey.create<ODataConfig>('odata.config'),
  CSDL_GEN: BindingKey.create<CsdlGenerator>('odata.csdl'),
  ENTITY_SET_REGISTRY: BindingKey.create<EntitySetRegistry>('odata.registry.entitysets'),
  APPLY_EXECUTOR_REGISTRY: BindingKey.create<ODataApplyExecutorRegistry>('odata.apply.executors'),
};

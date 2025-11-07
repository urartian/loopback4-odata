import { lifeCycleObserver, LifeCycleObserver, inject } from '@loopback/core';
import { ODATA_BINDINGS } from '../keys';
import { ODataConfig } from '../types';
import { EntitySetRegistry } from '../registry/entityset-registry';
import { ensureConfigValidated, validatePaginationLimits } from '../util/config-validation';

@lifeCycleObserver('odata')
export class ODataConfigValidatorObserver implements LifeCycleObserver {
  constructor(
    @inject(ODATA_BINDINGS.CONFIG)
    private readonly config: ODataConfig,
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
    private readonly registry: EntitySetRegistry,
  ) {}

  async start() {
    ensureConfigValidated(this.config);
    for (const def of this.registry.list()) {
      validatePaginationLimits(`EntitySet "${def.name}".pagination`, def.pagination);
    }
  }
}

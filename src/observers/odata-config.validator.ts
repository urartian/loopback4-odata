import { lifeCycleObserver, LifeCycleObserver, inject } from '@loopback/core';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import { ODataConfig } from '../types';
import { EntitySetRegistry } from '../registry/entityset-registry';
import { ensureConfigValidated, validatePaginationLimits } from '../util/config-validation';
import { DEFAULT_TOKEN_SECRET } from '../constants';

@lifeCycleObserver('odata')
export class ODataConfigValidatorObserver implements LifeCycleObserver {
  constructor(
    @inject(ODATA_BINDINGS.CONFIG)
    private readonly config: ODataConfig,
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
    private readonly registry: EntitySetRegistry,
    @inject(ODATA_BINDINGS.LOGGER)
    private readonly logger: ODataLogger,
  ) {}

  async start() {
    ensureConfigValidated(this.config);
    if (this.config.tokenSecret === DEFAULT_TOKEN_SECRET) {
      this.logger.warn(
        'OData tokenSecret is using the built-in placeholder; configure ODATA_TOKEN_SECRET or rebind odata.config before production.',
        { placeholder: true },
      );
    }
    for (const def of this.registry.list()) {
      validatePaginationLimits(`EntitySet "${def.name}".pagination`, def.pagination);
    }
  }
}

import { EntitySetDef } from '../registry/entityset-registry';
import { ODataModelOptions } from '../decorators/model.decorator';
import {
  ODataCompositionConfig,
  ODataCompositionDeletePolicy,
  ODataCompositionResolvedConfig,
  ODataConfig,
} from '../types';

export function resolveCompositionConfigForEntitySet(params: {
  entitySetName: string;
  modelMeta?: ODataModelOptions;
  registryDef?: EntitySetDef;
  globalConfig?: ODataConfig;
}): ODataCompositionResolvedConfig | undefined {
  const { entitySetName, modelMeta, registryDef, globalConfig } = params;
  const compositionCfg = (globalConfig?.composition ?? {}) as ODataCompositionConfig;
  const enforcement = (compositionCfg.enforcement ??
    'database') as ODataCompositionResolvedConfig['enforcement'];
  const defaultDeletePolicy = (compositionCfg.defaultDeletePolicy ??
    'restrict') as ODataCompositionDeletePolicy;
  const requireTransactionSupport = compositionCfg.requireTransactionSupport ?? true;
  const maxDepth = compositionCfg.maxDepth ?? 8;
  const maxEntities = compositionCfg.maxEntities ?? 5000;

  const globalRelations = compositionCfg.entitySets?.[entitySetName]?.relations ?? {};
  const decoratorRelations = modelMeta?.composition?.relations ?? {};
  const registryRelations = registryDef?.composition?.relations ?? {};

  const relationNames = new Set<string>([
    ...Object.keys(globalRelations ?? {}),
    ...Object.keys(decoratorRelations ?? {}),
    ...Object.keys(registryRelations ?? {}),
  ]);
  if (!relationNames.size) return undefined;

  const relations: Record<string, { delete: ODataCompositionDeletePolicy }> = {};
  for (const relationName of relationNames) {
    const policy =
      registryRelations?.[relationName]?.delete ??
      decoratorRelations?.[relationName]?.delete ??
      globalRelations?.[relationName]?.delete ??
      defaultDeletePolicy;
    relations[relationName] = { delete: policy };
  }

  return {
    enforcement,
    defaultDeletePolicy,
    requireTransactionSupport,
    maxDepth,
    maxEntities,
    relations,
  } satisfies ODataCompositionResolvedConfig;
}

export function compositionConfigHasCascade(
  resolved: ODataCompositionResolvedConfig | undefined,
): boolean {
  if (!resolved) return false;
  return Object.values(resolved.relations).some((rel) => rel.delete === 'cascade');
}

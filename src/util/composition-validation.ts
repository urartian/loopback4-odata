import { AnyObject, Entity, ModelDefinition } from '@loopback/repository';
import { ODataLogger } from '../keys';
import { ODataCompositionDeletePolicy, ODataCompositionResolvedConfig } from '../types';
import { EntitySetRegistry } from '../registry/entityset-registry';
import { ensureModelDefinitionWithRelations } from './model-definition';
import { ensureNavigationTargetKey } from './relation-metadata';

export function validateCompositionResolvedConfig(params: {
  entitySetName: string;
  modelCtor: typeof Entity;
  modelDefinition: ModelDefinition | undefined;
  resolved: ODataCompositionResolvedConfig | undefined;
  strict: boolean;
  logger?: ODataLogger;
}): ODataCompositionResolvedConfig | undefined {
  const { entitySetName, modelCtor, modelDefinition, resolved, strict, logger } = params;
  if (!resolved) return undefined;

  const relationDefs = (modelDefinition?.relations ?? {}) as Record<string, AnyObject>;
  const validRelations: Record<string, { delete: ODataCompositionDeletePolicy }> = {};

  for (const [relationName, relationCfg] of Object.entries(resolved.relations ?? {})) {
    const meta = relationDefs[relationName] as AnyObject | undefined;
    const invalidReason = validateCompositionRelationMeta(meta);
    if (invalidReason) {
      handleInvalidCompositionRelation({
        entitySetName,
        modelCtor,
        relationName,
        reason: invalidReason,
        strict,
        logger,
      });
      continue;
    }

    const resolvedKeyTo = ensureNavigationTargetKey(meta);
    if (!resolvedKeyTo) {
      handleInvalidCompositionRelation({
        entitySetName,
        modelCtor,
        relationName,
        reason: 'Relation does not expose a resolvable foreign key (keyTo).',
        strict,
        logger,
      });
      continue;
    }

    validRelations[relationName] = { delete: relationCfg.delete };
  }

  if (!Object.keys(validRelations).length) return undefined;
  return {
    ...resolved,
    relations: validRelations,
  };
}

export function validateCompositionCascadeCycles(params: {
  registry: EntitySetRegistry;
  strict: boolean;
  logger?: ODataLogger;
}): void {
  const { registry, strict, logger } = params;
  const defs = registry.list();
  const adjacency = new Map<string, Array<{ to: string; via: string }>>();

  for (const def of defs) {
    const resolved = def.compositionResolved;
    if (!resolved || resolved.enforcement !== 'application') continue;
    const modelDefinition =
      ensureModelDefinitionWithRelations(def.modelCtor) ??
      ((def.modelCtor as unknown as { definition?: ModelDefinition }).definition as
        | ModelDefinition
        | undefined);
    const relationDefs = (modelDefinition?.relations ?? {}) as Record<string, AnyObject>;
    for (const [relationName, cfg] of Object.entries(resolved.relations ?? {})) {
      if (cfg.delete !== 'cascade') continue;
      const meta = relationDefs[relationName] as AnyObject | undefined;
      if (!meta) continue;
      const targetGetter = meta.target as (() => typeof Entity) | undefined;
      let targetCtor: typeof Entity | undefined;
      if (typeof targetGetter === 'function') {
        try {
          targetCtor = targetGetter();
        } catch {
          targetCtor = undefined;
        }
      }
      if (!targetCtor) continue;
      const targetDef = registry.get(targetCtor);
      if (!targetDef) continue;
      const from = def.name;
      const to = targetDef.name;
      const via = `${from}.${relationName}`;
      const edges = adjacency.get(from) ?? [];
      edges.push({ to, via });
      adjacency.set(from, edges);
    }
  }

  const visitState = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const edgeStack: string[] = [];

  const report = (cycle: string[]) => {
    const message = `Composition cascade cycle detected: ${cycle.join(' -> ')}`;
    if (strict) {
      throw new Error(message);
    }
    logger?.warn('Composition cascade cycle detected; guardrails may terminate the request.', {
      event: 'composition.cycle',
      cycle,
    });
  };

  const dfs = (node: string): void => {
    visitState.set(node, 'visiting');
    stack.push(node);
    const edges = adjacency.get(node) ?? [];
    for (const edge of edges) {
      const state = visitState.get(edge.to);
      if (state === 'visiting') {
        const startIndex = stack.indexOf(edge.to);
        const labels = edgeStack.slice(startIndex).concat(edge.via);
        report(labels);
        continue;
      }
      if (state === 'done') continue;
      edgeStack.push(edge.via);
      dfs(edge.to);
      edgeStack.pop();
    }
    stack.pop();
    visitState.set(node, 'done');
  };

  for (const node of adjacency.keys()) {
    if (visitState.get(node)) continue;
    dfs(node);
  }
}

function validateCompositionRelationMeta(meta: AnyObject | undefined): string | undefined {
  if (!meta) return 'Relation is not defined on the model.';
  if (meta.through) return 'Relation is a through (many-to-many) relation.';
  const relationType = meta.type ?? meta.relationType;
  if (relationType !== 'hasMany' && relationType !== 'hasOne') {
    return `Relation type must be hasOne/hasMany (found ${String(relationType ?? 'unknown')}).`;
  }
  return undefined;
}

function handleInvalidCompositionRelation(params: {
  entitySetName: string;
  modelCtor: typeof Entity;
  relationName: string;
  reason: string;
  strict: boolean;
  logger?: ODataLogger;
}): void {
  const { entitySetName, modelCtor, relationName, reason, strict, logger } = params;
  const message = `Invalid composition relation config for EntitySet "${entitySetName}" (${modelCtor.name}): ${relationName}. ${reason}`;
  if (strict) {
    throw new Error(message);
  }
  logger?.warn('Ignoring invalid composition relation config.', {
    event: 'composition.invalid-relation',
    entitySet: entitySetName,
    model: modelCtor.name,
    relation: relationName,
    reason,
  });
}

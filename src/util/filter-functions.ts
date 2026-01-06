import { FILTER_FUNCTIONS_DEFAULT, FILTER_FUNCTIONS_POSTGRES } from '../filter-functions';

export type FilterFunctionsPreset = 'default' | 'postgres';

export function expandFilterFunctionsPreset(preset: FilterFunctionsPreset): string[] {
  if (preset === 'default') return FILTER_FUNCTIONS_DEFAULT;
  if (preset === 'postgres') return FILTER_FUNCTIONS_POSTGRES;
  // Exhaustive at compile time, but keep runtime safety.
  throw new Error(`Unsupported filterFunctionsPreset "${String(preset)}".`);
}

export function validateFilterFunctionsPreset(
  value: unknown,
  label: string,
): FilterFunctionsPreset | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = typeof value === 'string' ? (value as string).trim().toLowerCase() : value;
  if (normalized !== 'default' && normalized !== 'postgres') {
    throw new Error(`${label} must be "default" or "postgres".`);
  }
  return normalized;
}

export function normalizeFilterFunctionsList(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`${label} must be an array of strings.`);
    }
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveFilterFunctions(params: {
  entitySet?: { filterFunctions?: unknown; filterFunctionsPreset?: unknown };
  defaults?: { filterFunctions?: unknown; filterFunctionsPreset?: unknown };
  label: string;
}): string[] {
  const { entitySet, defaults, label } = params;

  if (entitySet && 'filterFunctions' in entitySet && entitySet.filterFunctions !== undefined) {
    return (
      normalizeFilterFunctionsList(entitySet.filterFunctions, `${label}.filterFunctions`) ?? []
    );
  }
  if (
    entitySet &&
    'filterFunctionsPreset' in entitySet &&
    entitySet.filterFunctionsPreset !== undefined
  ) {
    const preset = validateFilterFunctionsPreset(
      entitySet.filterFunctionsPreset,
      `${label}.filterFunctionsPreset`,
    );
    if (preset) return expandFilterFunctionsPreset(preset);
  }

  if (defaults && 'filterFunctions' in defaults && defaults.filterFunctions !== undefined) {
    return (
      normalizeFilterFunctionsList(defaults.filterFunctions, `${label}.defaults.filterFunctions`) ??
      []
    );
  }
  if (
    defaults &&
    'filterFunctionsPreset' in defaults &&
    defaults.filterFunctionsPreset !== undefined
  ) {
    const preset = validateFilterFunctionsPreset(
      defaults.filterFunctionsPreset,
      `${label}.defaults.filterFunctionsPreset`,
    );
    if (preset) return expandFilterFunctionsPreset(preset);
  }

  return FILTER_FUNCTIONS_DEFAULT;
}

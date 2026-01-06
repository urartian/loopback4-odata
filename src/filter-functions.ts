/**
 * Default set of supported $filter functions advertised via
 * Org.OData.Capabilities.V1.FilterFunctions.
 *
 * This matches the historical default behavior of this library.
 */
export const FILTER_FUNCTIONS_DEFAULT: string[] = [
  'contains',
  'startswith',
  'endswith',
  'indexof',
  'substring',
  'length',
  'round',
  'floor',
  'ceiling',
  'year',
];

/**
 * Postgres-ready set of supported $filter functions advertised via
 * Org.OData.Capabilities.V1.FilterFunctions.
 *
 * This is aligned with the currently implemented query parser + Postgres pushdown.
 */
export const FILTER_FUNCTIONS_POSTGRES: string[] = [
  'contains',
  'startswith',
  'endswith',
  'tolower',
  'toupper',
  'length',
  'indexof',
  'substring',
  'trim',
  'concat',
  'round',
  'floor',
  'ceiling',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
];

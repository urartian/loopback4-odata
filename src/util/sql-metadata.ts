import {Entity, juggler, ModelDefinition} from '@loopback/repository';
import {EntitySqlMetadata} from '../registry/entityset-registry';

interface ConnectorWithMetadata {
  table?: (modelName: string) => string | undefined;
  tableEscaped?: (modelName: string) => string | undefined;
  schema?: (modelName: string) => string | undefined;
  column?: (modelName: string, propertyName: string) => string | undefined;
  columnEscaped?: (modelName: string, propertyName: string) => string | undefined;
}

function getModelName(modelCtor: typeof Entity): string | undefined {
  const metaName = (modelCtor as typeof Entity & {modelName?: string}).modelName;
  return metaName ?? modelCtor?.name ?? undefined;
}

function getModelDefinition(modelCtor: typeof Entity): ModelDefinition | undefined {
  return (modelCtor as typeof Entity & {definition?: ModelDefinition}).definition;
}

/**
 * Build SQL metadata (schema/table/column mappings) using the connector metadata.
 */
export function inferSqlMetadata(
  modelCtor: typeof Entity,
  dataSource: juggler.DataSource | undefined,
): EntitySqlMetadata | undefined {
  if (!dataSource) return undefined;
  const connector = dataSource.connector as ConnectorWithMetadata | undefined;
  if (!connector) return undefined;

  const modelName = getModelName(modelCtor);
  if (!modelName) return undefined;

  let tableName: string | undefined;
  try {
    tableName = typeof connector.table === 'function'
      ? connector.table(modelName)
      : undefined;
  } catch {
    tableName = undefined;
  }
  if (!tableName) {
    tableName = modelName;
  }

  let schema: string | undefined;
  try {
    schema = typeof connector.schema === 'function'
      ? connector.schema(modelName)
      : undefined;
  } catch {
    schema = undefined;
  }

  const columnMap: Record<string, string> = {};
  const definition = getModelDefinition(modelCtor);
  const properties = definition?.properties ?? {};
  for (const propertyName of Object.keys(properties)) {
    try {
      const columnName = typeof connector.column === 'function'
        ? connector.column(modelName, propertyName)
        : undefined;
      if (columnName) {
        columnMap[propertyName] = columnName;
      }
    } catch {
      // Ignore individual property failures. Fall back to default below.
    }
    if (!columnMap[propertyName]) {
      columnMap[propertyName] = propertyName;
    }
  }

  if (!Object.keys(columnMap).length && definition?.properties) {
    for (const propertyName of Object.keys(definition.properties)) {
      columnMap[propertyName] = propertyName;
    }
  }

  return {
    tableName,
    schema,
    columnMap,
  };
}

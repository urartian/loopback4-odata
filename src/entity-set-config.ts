import { Entity } from '@loopback/repository';
import {
  ODataCapabilitiesConfig,
  ODataCompositionEntitySetConfig,
  ODataPaginationConfig,
  ODataSingletonConfig,
} from './types';

export type ODataSecurityMethodAliases = Record<string, string | string[]>;

/**
 * Public entity-set registration shape for advanced registry-based overrides.
 *
 * This intentionally contains only user-supplied configuration knobs and omits
 * runtime-populated internal state from the registry implementation.
 */
export interface ODataEntitySetConfig<T extends Entity = Entity> {
  name: string;
  modelCtor: typeof Entity & { prototype: T };
  repositoryBindingKey?: string;
  securityMethodAliases?: ODataSecurityMethodAliases;
  singleton?: ODataSingletonConfig;
  etagProperties?: string[];
  capabilities?: ODataCapabilitiesConfig;
  composition?: ODataCompositionEntitySetConfig;
  pagination?: ODataPaginationConfig;
  deepInsert?: boolean;
  deepUpdate?: boolean;
  applyPushdown?: boolean;
  deltaEnabled?: boolean;
  deltaField?: string;
  documentInOpenApi?: boolean;
  hasStream?: boolean;
  mediaField?: string;
  mediaContentTypeField?: string;
  mediaEtagField?: string;
  mediaLengthField?: string;
  mediaHandlerBindingKey?: string;
  mediaMaxPayloadBytes?: number;
}

/**
 * Public advanced registry API exposed through `ODATA_BINDINGS.ENTITY_SET_REGISTRY`.
 */
export interface ODataEntitySetRegistry {
  register(def: ODataEntitySetConfig): ODataEntitySetConfig;
  attachRepository(modelCtor: typeof Entity, bindingKey: string, repositoryCtor?: Function): void;
  get(modelCtor: typeof Entity): ODataEntitySetConfig | undefined;
  list(): ODataEntitySetConfig[];
  findByName(name: string): ODataEntitySetConfig | undefined;
}

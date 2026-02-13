import { BindingScope, injectable } from '@loopback/core';
import { Entity } from '@loopback/repository';
import { DeltaTokenPayload } from '../util/delta-token';
import { OperationMeta } from '../decorators/action.function.decorators';
import type { CrudHookBundle } from '../types/crud-hooks';
import { ControllerSecurityMetadata, MethodAliasMap } from '../util/security-metadata';
import {
  ODataCapabilitiesConfig,
  ODataCompositionEntitySetConfig,
  ODataCompositionResolvedConfig,
  ODataSingletonConfig,
} from '../types';
import { validatePaginationLimits } from '../util/config-validation';

export interface EntitySqlMetadata {
  tableName?: string;
  schema?: string;
  columnMap?: Record<string, string>;
}

export interface EntitySetDef<T extends Entity = Entity> {
  name: string; // e.g. "Products"
  modelCtor: typeof Entity & { prototype: T }; // LB4 model constructor
  /**
   * When false, this model is not exposed as an entity set (collection).
   *
   * Used by singleton-only models to omit `/odata/<EntitySet>` endpoints and metadata entries.
   */
  exposeEntitySet?: boolean;
  controllerCtor?: Function; // generated controller
  repositoryBindingKey?: string; // app.binding key for the repository
  repositoryCtor?: Function; // repository class constructor
  supportsTransactions?: boolean;
  transactionCapabilityLocked?: boolean;
  actions?: OperationMeta[];
  functions?: OperationMeta[];
  singleton?: ODataSingletonConfig;
  etagProperties?: string[];
  securityMetadata?: ControllerSecurityMetadata;
  securityMethodAliases?: MethodAliasMap;
  hooks?: CrudHookBundle; // controller-declared hooks
  sourceControllerBindingKey?: string; // binding key to resolve controller instance
  hasStream?: boolean;
  mediaField?: string;
  mediaContentTypeField?: string;
  mediaEtagField?: string;
  mediaLengthField?: string;
  mediaHandlerBindingKey?: string;
  mediaMaxPayloadBytes?: number;
  capabilities?: ODataCapabilitiesConfig;
  composition?: ODataCompositionEntitySetConfig;
  compositionResolved?: ODataCompositionResolvedConfig;
  deepInsert?: boolean;
  deepUpdate?: boolean;
  applyPushdown?: boolean;
  applyExecutorId?: string;
  sqlMetadata?: EntitySqlMetadata;
  applySupportsNavigation?: boolean;
  deltaEnabled?: boolean;
  deltaField?: string;
  deltaToken?: DeltaTokenPayload;
  documentInOpenApi?: boolean;
  pagination?: {
    maxTop?: number;
    maxSkip?: number;
    maxPageSize?: number;
    maxApplyPageSize?: number;
  };
}

@injectable({ scope: BindingScope.SINGLETON })
export class EntitySetRegistry {
  private readonly sets = new Map<typeof Entity, EntitySetDef>();
  private version = 0;

  private bumpVersion(): void {
    this.version++;
  }

  getVersion(): number {
    return this.version;
  }

  register<T extends Entity>(def: EntitySetDef<T>): EntitySetDef<T> {
    const existing = this.sets.get(def.modelCtor);
    const next: EntitySetDef = { ...(existing ?? {}), ...def };
    if (!def.securityMetadata && existing?.securityMetadata) {
      next.securityMetadata = existing.securityMetadata;
    }
    if (def.composition === undefined && existing?.composition !== undefined) {
      next.composition = existing.composition;
    }
    if (def.compositionResolved === undefined && existing?.compositionResolved !== undefined) {
      next.compositionResolved = existing.compositionResolved;
    }
    if (def.deepInsert === undefined && existing?.deepInsert !== undefined) {
      next.deepInsert = existing.deepInsert;
    }
    if (def.deepUpdate === undefined && existing?.deepUpdate !== undefined) {
      next.deepUpdate = existing.deepUpdate;
    }
    if (def.applyPushdown === undefined && existing?.applyPushdown !== undefined) {
      next.applyPushdown = existing.applyPushdown;
    }
    if (!def.applyExecutorId && existing?.applyExecutorId) {
      next.applyExecutorId = existing.applyExecutorId;
    }
    if (!def.sqlMetadata && existing?.sqlMetadata) {
      next.sqlMetadata = existing.sqlMetadata;
    }
    if (
      def.applySupportsNavigation === undefined &&
      existing?.applySupportsNavigation !== undefined
    ) {
      next.applySupportsNavigation = existing.applySupportsNavigation;
    }
    if (def.deltaEnabled === undefined && existing?.deltaEnabled !== undefined) {
      next.deltaEnabled = existing.deltaEnabled;
    }
    if (!def.deltaField && existing?.deltaField) {
      next.deltaField = existing.deltaField;
    }
    if (def.documentInOpenApi === undefined && existing?.documentInOpenApi !== undefined) {
      next.documentInOpenApi = existing.documentInOpenApi;
    }
    if (def.supportsTransactions === undefined && existing?.supportsTransactions !== undefined) {
      next.supportsTransactions = existing.supportsTransactions;
    }
    if (
      def.transactionCapabilityLocked === undefined &&
      existing?.transactionCapabilityLocked !== undefined
    ) {
      next.transactionCapabilityLocked = existing.transactionCapabilityLocked;
    }
    if (next.supportsTransactions === false && next.transactionCapabilityLocked === undefined) {
      next.transactionCapabilityLocked = true;
    }
    if (def.pagination === undefined && existing?.pagination !== undefined) {
      next.pagination = existing.pagination;
    }
    if (def.hasStream === undefined && existing?.hasStream !== undefined) {
      next.hasStream = existing.hasStream;
    }
    if (!def.mediaField && existing?.mediaField) {
      next.mediaField = existing.mediaField;
    }
    if (!def.mediaContentTypeField && existing?.mediaContentTypeField) {
      next.mediaContentTypeField = existing.mediaContentTypeField;
    }
    if (!def.mediaEtagField && existing?.mediaEtagField) {
      next.mediaEtagField = existing.mediaEtagField;
    }
    if (!def.mediaLengthField && existing?.mediaLengthField) {
      next.mediaLengthField = existing.mediaLengthField;
    }
    if (!def.mediaHandlerBindingKey && existing?.mediaHandlerBindingKey) {
      next.mediaHandlerBindingKey = existing.mediaHandlerBindingKey;
    }
    if (def.mediaMaxPayloadBytes === undefined && existing?.mediaMaxPayloadBytes !== undefined) {
      next.mediaMaxPayloadBytes = existing.mediaMaxPayloadBytes;
    }
    validatePaginationLimits(`EntitySet "${next.name}".pagination`, next.pagination);
    this.sets.set(def.modelCtor, next);
    this.bumpVersion();
    return next as EntitySetDef<T>;
  }

  attachRepository(modelCtor: typeof Entity, bindingKey: string, repositoryCtor?: Function) {
    const def = this.sets.get(modelCtor);
    if (!def) {
      throw new Error(
        `Attempted to attach repository for unregistered model ${modelCtor.name ?? '[Anonymous]'}.`,
      );
    }
    def.repositoryBindingKey = bindingKey;
    def.repositoryCtor = repositoryCtor;
    this.bumpVersion();
  }

  get(modelCtor: typeof Entity): EntitySetDef | undefined {
    return this.sets.get(modelCtor);
  }

  list(): EntitySetDef[] {
    return Array.from(this.sets.values());
  }

  findByName(name: string): EntitySetDef | undefined {
    const normalized = name.toLowerCase();
    for (const def of this.sets.values()) {
      if (def.name.toLowerCase() === normalized) return def;
    }
    return undefined;
  }
}

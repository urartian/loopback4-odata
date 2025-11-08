import { BindingScope, injectable } from '@loopback/core';
import { Entity } from '@loopback/repository';
import { DeltaTokenPayload } from '../util/delta-token';
import { OperationMeta } from '../decorators/action.function.decorators';
import type { CrudHookBundle } from '../types/crud-hooks';
import { ControllerSecurityMetadata, MethodAliasMap } from '../util/security-metadata';
import { ODataCapabilitiesConfig } from '../types';
import { validatePaginationLimits } from '../util/config-validation';

export interface EntitySqlMetadata {
  tableName?: string;
  schema?: string;
  columnMap?: Record<string, string>;
}

export interface EntitySetDef<T extends Entity = Entity> {
  name: string; // e.g. "Products"
  modelCtor: typeof Entity & { prototype: T }; // LB4 model constructor
  controllerCtor?: Function; // generated controller
  repositoryBindingKey?: string; // app.binding key for the repository
  repositoryCtor?: Function; // repository class constructor
  supportsTransactions?: boolean;
  transactionCapabilityLocked?: boolean;
  actions?: OperationMeta[];
  functions?: OperationMeta[];
  etagProperties?: string[];
  securityMetadata?: ControllerSecurityMetadata;
  securityMethodAliases?: MethodAliasMap;
  hooks?: CrudHookBundle; // controller-declared hooks
  sourceControllerBindingKey?: string; // binding key to resolve controller instance
  hasStream?: boolean;
  capabilities?: ODataCapabilitiesConfig;
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

  register<T extends Entity>(def: EntitySetDef<T>): EntitySetDef<T> {
    const existing = this.sets.get(def.modelCtor);
    const next: EntitySetDef = { ...(existing ?? {}), ...def };
    if (!def.securityMetadata && existing?.securityMetadata) {
      next.securityMetadata = existing.securityMetadata;
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
    validatePaginationLimits(`EntitySet "${next.name}".pagination`, next.pagination);
    this.sets.set(def.modelCtor, next);
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

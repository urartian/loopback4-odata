import { Application, CoreBindings, inject } from '@loopback/core';
import {
  post,
  requestBody,
  Response,
  RestBindings,
  HttpErrors,
  Request,
  RequestContext,
} from '@loopback/rest';
import { HttpHandler } from '@loopback/rest/dist/http-handler';
import { IncomingMessage, ServerResponse, STATUS_CODES } from 'http';
import { PassThrough } from 'stream';
import {
  AnyObject,
  Entity,
  IsolationLevel,
  PropertyDefinition,
  Transaction,
  juggler,
} from '@loopback/repository';
import * as ipaddr from 'ipaddr.js';
import { ODATA_BINDINGS, ODataLogger } from '../keys';
import { EntitySetDef, EntitySetRegistry } from '../registry/entityset-registry';
import {
  ODATA_ATOMICITY_STATE,
  ODATA_BATCH_DEPTH,
  ODATA_BATCH_DEPTH_HEADER,
  ODATA_BATCH_DEPTH_PROP,
  ODATA_VERSION,
} from '../constants';
import { AtomicityRequestState } from '../types/batch';
import { parseMultipartBatch } from '../services/multipart-batch.parser';
import { serializeMultipartBatch } from '../services/multipart-batch.serializer';
import { Readable } from 'stream';
import { markUndocumentedOperation } from '../util/openapi';
import { ODataBatchConfig, ODataConfig, ODataRequestState, ODataTelemetryLevel } from '../types';
import {
  dataSourceSupportsTransactions,
  probeDataSourceTransactionalCapability,
} from '../util/datasource-transactions';
import { isEntityCtor } from '../util/model-helpers';
import { emitTelemetryEvent } from '../util/telemetry';
import { rewriteODataUrl } from '../middleware/odata-path-rewriter';
import { ensureModelDefinitionWithRelations } from '../util/model-definition';
import { ODataErrorCodes } from '../odata-error-codes';
import {
  buildODataRootRouteNames,
  matchesConfiguredODataPath,
  normalizeBasePath,
} from '../util/base-path';

const BATCH_OPERATION_SPEC = markUndocumentedOperation({
  responses: {
    '200': {
      description: 'Execute multiple OData operations',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              responses: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    atomicityGroup: { type: 'string' },
                    status: { type: 'integer' },
                    headers: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                    },
                    body: { type: 'object' },
                  },
                  required: ['status'],
                },
              },
            },
            required: ['responses'],
          },
        },
      },
    },
    '400': {
      description: 'Invalid batch payload',
    },
  },
});

export interface BatchRequest {
  id?: string;
  atomicityGroup?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: Buffer;
  dependsOn?: string[];
}

interface BatchPayload {
  requests: BatchRequest[];
}

export interface BatchResponseEntry {
  id?: string;
  atomicityGroup?: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface BatchResponsePayload {
  responses: BatchResponseEntry[];
}

interface NormalizedBatchLimits {
  maxPayloadBytes?: number;
  maxOperations?: number;
  maxChangesetOperations?: number;
  maxDepth?: number;
  maxPartBodyBytes?: number;
  maxResponseBodyBytes?: number;
  maxResponsePayloadBytes?: number;
}

interface ResponseSizeTracker {
  limit?: number;
  isMultipart: boolean;
  bufferedBytes: number;
  serializedBytes: number;
  responsesCount: number;
  activeChangesetId?: string;
}

const ESTIMATED_BATCH_BOUNDARY = 'batch_boundary';
const ESTIMATED_CHANGESET_BOUNDARY = 'changeset_boundary';

interface ContentIdTokenMatch {
  token: string;
  wrapper?: {
    prefix: string;
    suffix: string;
  };
}

const NON_TRANSACTIONAL_WARNINGS = new WeakSet<EntitySetDef>();
const TEXT_LIKE_MIME_TYPES = new Set([
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-www-form-urlencoded',
]);
const DEFAULT_ALLOWED_SUBREQUEST_HEADERS = Object.freeze([
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'content-type',
  'slug',
  'dataserviceversion',
  'maxdataserviceversion',
  'prefer',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
  'odata-version',
  'odata-maxversion',
  'odata-isolation',
]);
const DEFAULT_SUBREQUEST_TIMEOUT_MS = 30_000;
const BATCH_TOKEN_REGEX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
type BatchDepthCarrier = { [ODATA_BATCH_DEPTH]?: number };

class AtomicityGroupContext {
  private readonly requestState: AtomicityRequestState;
  private readonly transactions: Transaction[];
  private settled = false;
  private rolledBack = false;

  constructor(
    public readonly id: string,
    private readonly transactionsBySet: Map<string, Transaction>,
    dataSource?: juggler.DataSource,
    dataSourceKey?: string,
  ) {
    const unique = new Set<Transaction>();
    for (const tx of transactionsBySet.values()) unique.add(tx);
    this.transactions = Array.from(unique.values());
    this.requestState = {
      groupId: id,
      dataSource,
      dataSourceKey,
      getTransaction: (entitySetName: string) => this.transactionsBySet.get(entitySetName),
    };
  }

  applyTo(req: IncomingMessage) {
    (req as any)[ODATA_ATOMICITY_STATE] = this.requestState;
  }

  clearFrom(req: IncomingMessage) {
    delete (req as any)[ODATA_ATOMICITY_STATE];
  }

  async commit() {
    if (this.settled) return;
    try {
      for (const tx of this.transactions) {
        await tx.commit();
      }
      this.settled = true;
    } catch (error) {
      try {
        await this.safeRollback();
      } catch {
        /* ignore rollback errors here to surface original commit failure */
      }
      throw error;
    }
  }

  async rollback() {
    if (this.settled && this.rolledBack) return;
    await this.safeRollback();
  }

  private async safeRollback() {
    if (this.rolledBack) return;
    const errors: Error[] = [];
    for (const tx of this.transactions) {
      try {
        await tx.rollback();
      } catch (err) {
        errors.push(err as Error);
      }
    }
    this.rolledBack = true;
    this.settled = true;
    if (errors.length) {
      const aggregate = new Error(errors.map((e) => e.message ?? String(e)).join('; '));
      (aggregate as any).cause = errors[0];
      throw aggregate;
    }
  }
}

export class ODataBatchController {
  private readonly serviceRootPath: string;
  private readonly serviceRootSegments: string[];
  private cachedRootNames?: Set<string>;
  private cachedRegistryVersion = -1;

  constructor(
    @inject(RestBindings.HANDLER)
    private readonly httpHandler: HttpHandler,
    @inject(RestBindings.URL)
    private readonly serverUrl: string,
    @inject(RestBindings.Http.CONTEXT)
    private readonly httpCtx: RequestContext,
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly app: Application,
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
    private readonly registry: EntitySetRegistry,
    @inject(ODATA_BINDINGS.LOGGER)
    private readonly logger: ODataLogger,
    @inject(ODATA_BINDINGS.CONFIG)
    private readonly cfg: ODataConfig,
  ) {
    this.serviceRootPath = normalizeBasePath(this.cfg?.basePath);
    this.serviceRootSegments = this.serviceRootPath.split('/').filter(Boolean);
  }

  private requestState?: ODataRequestState | null;
  private allowedSubRequestHeaders?: Set<string>;
  private _trustedProxyRanges?: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>;

  @post('/odata/$batch', BATCH_OPERATION_SPEC)
  async handleBatch(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              requests: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'method', 'url'],
                  properties: {
                    id: { type: 'string' },
                    method: { type: 'string' },
                    url: { type: 'string' },
                    headers: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                    },
                    body: {},
                    atomicityGroup: { type: 'string' },
                    dependsOn: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        'multipart/mixed': {
          'x-parser': 'stream',
          schema: { type: 'object' },
        },
      },
    })
    payload: BatchPayload | Readable,
    @inject(RestBindings.Http.RESPONSE) response: Response,
    @inject(RestBindings.Http.REQUEST) request: Request,
  ): Promise<BatchResponsePayload | void> {
    const contentType = request.get('content-type') ?? request.headers['content-type'] ?? '';
    const isMultipart = /multipart\/mixed/i.test(contentType ?? '');
    const limits = this.getBatchLimits();
    this.enforceDeclaredSizeLimit(request, limits);
    const currentDepth = this.getBatchDepth(request);
    this.enforceBatchDepthLimit(currentDepth, limits);
    this.setBatchDepth(request, currentDepth);
    let requests: BatchRequest[];
    let grouped: Array<{ atomicityGroup?: string; requests: BatchRequest[] }> = [];
    let boundary: string | undefined;
    const startedAt = process.hrtime.bigint();
    let telemetryContentLength: number | undefined;
    let operationCount = 0;
    let changesetCount = 0;
    const declaredLength = request.headers['content-length'];
    if (declaredLength) {
      const normalized = Number(declaredLength);
      if (Number.isFinite(normalized)) telemetryContentLength = normalized;
    }

    try {
      if (isMultipart) {
        boundary = this.extractBoundary(contentType);
        if (!boundary) {
          throw new HttpErrors.BadRequest('Multipart batch request must specify a boundary.');
        }
        const stream = isReadable(payload)
          ? (payload as Readable)
          : (request as unknown as Readable);
        const parsed = await parseMultipartBatch(stream, boundary, {
          limits,
          onLimitViolation: (reason) => this.warn(reason),
        });
        requests = parsed.requests as BatchRequest[];
        if (!requests.length) {
          throw new HttpErrors.BadRequest('Batch payload must contain at least one request.');
        }
      } else {
        const jsonPayload = payload as BatchPayload;
        const jsonRequests = jsonPayload?.requests;
        if (!Array.isArray(jsonRequests) || !jsonRequests.length) {
          throw new HttpErrors.BadRequest('Batch payload must contain at least one request.');
        }
        this.enforceOperationLimit(jsonRequests.length, limits);
        this.enforceJsonPayloadSize(jsonPayload, limits);
        requests = jsonRequests;
        this.sanitizeBatchRequestIdentifiers(requests);
        this.validateJsonDependsOn(requests);
        this.enforceJsonPartBodySize(requests, limits);
      }

      this.enforceOperationLimit(requests.length, limits);
      if (isMultipart) {
        this.sanitizeBatchRequestIdentifiers(requests);
      }
      const requestOrder = this.buildRequestOrderIndex(requests);

      this.validateContiguousAtomicityGroups(requests);
      const changeSets = this.collectAtomicityGroups(requests);
      operationCount = requests.length;
      changesetCount = changeSets.size;
      const dependencyResults = new Map<string, BatchResponseEntry>();
      const contentIdMap = new Map<string, string>();
      const contentIdEtags = new Map<string, string>();
      const responses: BatchResponseEntry[] = [];
      const responseSizeTracker = this.createResponseSizeTracker(isMultipart, limits);

      const maxChangesetOps = limits.maxChangesetOperations;
      if (maxChangesetOps && maxChangesetOps > 0) {
        for (const [groupId, groupRequests] of changeSets.entries()) {
          if (groupRequests.length > maxChangesetOps) {
            this.warn('Changeset operation limit exceeded.', {
              group: groupId,
              operations: groupRequests.length,
              maxChangesetOperations: maxChangesetOps,
            });
            const err = new HttpErrors.BadRequest(
              'Changeset exceeds the configured operation limit for $batch requests.',
            );
            (err as AnyObject).code = ODataErrorCodes.ChangesetOperationLimitExceeded;
            throw err;
          }
        }
      }

      const executedGroups = new Map<string, BatchResponseEntry[]>();

      for (const req of requests) {
        const groupId = req.atomicityGroup;
        if (groupId) {
          let pending = executedGroups.get(groupId);
          if (!pending) {
            const groupRequests = changeSets.get(groupId) ?? [];
            try {
              pending = await this.executeAtomicGroup(
                groupRequests,
                groupId,
                request,
                dependencyResults,
                requestOrder,
                limits,
                responseSizeTracker,
                contentIdMap,
                contentIdEtags,
              );
              pending = pending.map((entry) => ({ ...entry, atomicityGroup: groupId }));
            } catch (error) {
              if (this.isBatchValidationError(error)) {
                throw error;
              }
              const status = this.resolveErrorStatus(error, 500);
              pending = groupRequests.map((original) => ({
                id: original.id,
                atomicityGroup: groupId,
                status,
                body: this.odataError(
                  ODataErrorCodes.BatchExecutionError,
                  (error as Error).message ?? 'Failed to execute atomicity group.',
                ),
              }));
            }
            executedGroups.set(groupId, pending);
          }
          const next = pending.shift();
          if (next) {
            responses.push(next);
          }
          continue;
        }

        const entries = await this.executeGroup(
          [req],
          undefined,
          request,
          dependencyResults,
          requestOrder,
          limits,
          responseSizeTracker,
          false,
          contentIdMap,
          contentIdEtags,
        );
        responses.push(...entries);
      }

      this.finalizeResponseSizeTracker(responseSizeTracker);
      response.set('OData-Version', ODATA_VERSION);

      let result: BatchResponsePayload | void = { responses };
      if (isMultipart) {
        const { body, boundary: responseBoundary } = serializeMultipartBatch(responses);
        response.set('Content-Type', `multipart/mixed; boundary=${responseBoundary}`);
        response.set('Content-Length', body.length.toString());
        response.send(body);
        result = undefined;
      } else {
        response.contentType('application/json');
        result = { responses: this.normalizeJsonBatchResponses(responses) };
      }

      this.emitBatchSummary('completed', startedAt, {
        contentType: isMultipart ? 'multipart' : 'json',
        operationCount,
        changesetCount,
        declaredBytes: telemetryContentLength,
      });

      return result;
    } catch (error) {
      this.emitBatchSummary('failed', startedAt, {
        contentType: isMultipart ? 'multipart' : 'json',
        operationCount,
        changesetCount,
        declaredBytes: telemetryContentLength,
        reason: (error as Error).message ?? 'Batch request failed.',
      });
      throw error;
    }
  }

  private getBatchLimits(): NormalizedBatchLimits {
    const cfgBatch = (this.cfg?.batch ?? {}) as ODataBatchConfig;
    return {
      maxPayloadBytes: cfgBatch.maxPayloadBytes ?? 16 * 1024 * 1024,
      maxOperations: cfgBatch.maxOperations ?? 100,
      maxChangesetOperations: cfgBatch.maxChangesetOperations ?? 50,
      maxDepth: cfgBatch.maxDepth ?? 2,
      maxPartBodyBytes: cfgBatch.maxPartBodyBytes ?? 4 * 1024 * 1024,
      maxResponseBodyBytes: cfgBatch.maxResponseBodyBytes ?? 4 * 1024 * 1024,
      maxResponsePayloadBytes: cfgBatch.maxResponsePayloadBytes ?? 32 * 1024 * 1024,
    };
  }

  private enforceDeclaredSizeLimit(request: Request, limits: NormalizedBatchLimits) {
    if (!limits.maxPayloadBytes) return;
    const header = request.headers['content-length'];
    if (!header) return;
    const declared = Number(header);
    if (Number.isFinite(declared) && declared > limits.maxPayloadBytes) {
      this.warn('Batch payload exceeds configured size limit (declared).', {
        declaredBytes: declared,
        maxPayloadBytes: limits.maxPayloadBytes,
      });
      const err = new HttpErrors.PayloadTooLarge(
        'Batch payload exceeds the configured size limit.',
      );
      (err as AnyObject).code = ODataErrorCodes.BatchPayloadSizeLimitExceeded;
      throw err;
    }
  }

  private enforceJsonPayloadSize(payload: BatchPayload, limits: NormalizedBatchLimits) {
    if (!limits.maxPayloadBytes) return;
    try {
      const approxBytes = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf-8');
      if (approxBytes > limits.maxPayloadBytes) {
        this.warn('Batch JSON payload exceeds configured size limit.', {
          computedBytes: approxBytes,
          maxPayloadBytes: limits.maxPayloadBytes,
        });
        const err = new HttpErrors.PayloadTooLarge(
          'Batch payload exceeds the configured size limit.',
        );
        (err as AnyObject).code = ODataErrorCodes.BatchPayloadSizeLimitExceeded;
        throw err;
      }
    } catch (error) {
      this.warn('Failed to evaluate JSON batch payload size.', {
        error: (error as Error).message ?? error,
      });
    }
  }

  private enforceJsonPartBodySize(requests: BatchRequest[], limits: NormalizedBatchLimits) {
    const maxPartBodyBytes = limits.maxPartBodyBytes;
    if (!maxPartBodyBytes || maxPartBodyBytes <= 0) return;
    requests.forEach((request, index) => {
      const bodyBuffer = this.resolveRequestBodyBuffer(request);
      if (bodyBuffer.length > maxPartBodyBytes) {
        this.warn('Batch request body exceeds configured per-part limit.', {
          requestId: request.id,
          requestIndex: index,
          bytes: bodyBuffer.length,
          maxPartBodyBytes,
        });
        const err = new HttpErrors.PayloadTooLarge('Batch part exceeds the configured size limit.');
        (err as AnyObject).code = ODataErrorCodes.BatchPartSizeLimitExceeded;
        throw err;
      }
    });
  }

  private enforceOperationLimit(count: number, limits: NormalizedBatchLimits) {
    const maxOperations = limits.maxOperations;
    if (!maxOperations || maxOperations <= 0) return;
    if (count > maxOperations) {
      this.warn('Batch operation limit exceeded.', {
        operations: count,
        maxOperations,
      });
      const err = new HttpErrors.BadRequest(
        'Batch payload exceeds the configured operation limit.',
      );
      (err as AnyObject).code = ODataErrorCodes.BatchOperationLimitExceeded;
      throw err;
    }
  }

  private warn(message: string, context?: Record<string, unknown>) {
    const payload = { scope: 'batch', ...(context ?? {}) };
    this.logger.warn(message, payload);
    this.emitBatchTelemetry(
      'batch.warning',
      {
        message,
        ...payload,
      },
      'warn',
    );
  }

  private emitBatchSummary(
    status: 'completed' | 'failed',
    startedAt: bigint,
    context: Record<string, unknown>,
  ): void {
    this.emitBatchTelemetry(
      'batch.request',
      {
        status,
        durationMs: this.durationSince(startedAt),
        ...context,
      },
      status === 'completed' ? 'info' : 'warn',
    );
  }

  private emitBatchTelemetry(
    event: string,
    context: Record<string, unknown>,
    level: ODataTelemetryLevel = 'info',
  ): void {
    emitTelemetryEvent(this.logger, this.getRequestState(), {
      category: 'batch',
      event,
      level,
      context,
    });
  }

  private getRequestState(): ODataRequestState | undefined {
    if (this.requestState !== undefined) {
      return this.requestState ?? undefined;
    }
    try {
      const state = this.httpCtx.getSync(ODATA_BINDINGS.REQUEST_STATE, {
        optional: true,
      }) as ODataRequestState | undefined;
      this.requestState = state ?? null;
      return state;
    } catch {
      this.requestState = null;
      return undefined;
    }
  }

  private durationSince(startedAt: bigint): number {
    const elapsed = process.hrtime.bigint() - startedAt;
    return Number(elapsed) / 1e6;
  }

  private async ensureTransactionalSupport(
    def: EntitySetDef,
    groupId: string,
    resolvedDataSource?: juggler.DataSource,
  ): Promise<boolean> {
    if (def.supportsTransactions === true) return true;
    if (def.transactionCapabilityLocked === false) {
      const refreshed = await this.tryRefreshTransactionalSupport(def, resolvedDataSource);
      if (refreshed) return true;
    }
    if (def.supportsTransactions === false) {
      def.supportsTransactions = false;
      def.transactionCapabilityLocked = true;
      this.warn('Atomicity group downgraded: datasource lacks transaction support.', {
        entitySet: def.name,
        atomicityGroup: groupId,
      });
      return false;
    }
    return true;
  }

  private async tryRefreshTransactionalSupport(
    def: EntitySetDef,
    resolvedDataSource?: juggler.DataSource,
  ): Promise<boolean> {
    if (!def.repositoryBindingKey) return false;
    try {
      const dataSource =
        resolvedDataSource ??
        ((await this.app.get(def.repositoryBindingKey)) as { dataSource?: juggler.DataSource })
          .dataSource;
      if (!dataSource) {
        this.markEntitySetNonTransactional(def, def.repositoryBindingKey);
        return false;
      }
      const { capability, error: probeError } =
        await probeDataSourceTransactionalCapability(dataSource);
      if (capability === 'supported') {
        def.supportsTransactions = true;
        def.transactionCapabilityLocked = true;
        return true;
      }
      if (capability === 'unsupported') {
        this.markEntitySetNonTransactional(def, dataSource.name ?? def.repositoryBindingKey);
        return false;
      }
      this.warn('Unable to verify datasource transaction capability during refresh.', {
        entitySet: def.name,
        dataSource: dataSource.name ?? def.repositoryBindingKey,
        error: (probeError as Error)?.message ?? probeError,
      });
      if (probeError instanceof Error) throw probeError;
      throw new Error('Datasource transaction capability could not be verified.');
    } catch (error) {
      this.warn('Failed to refresh datasource transaction capability; propagating error.', {
        entitySet: def.name,
        repositoryBindingKey: def.repositoryBindingKey,
        error: (error as Error)?.message ?? error,
      });
      throw error;
    }
  }

  private markEntitySetNonTransactional(def: EntitySetDef, dataSourceName?: string): void {
    def.supportsTransactions = false;
    def.transactionCapabilityLocked = true;
    if (NON_TRANSACTIONAL_WARNINGS.has(def)) return;
    NON_TRANSACTIONAL_WARNINGS.add(def);
    this.warn('Entity set datasource does not support transactions; atomicity groups disabled.', {
      entitySet: def.name,
      dataSource: dataSourceName,
    });
  }

  private collectAtomicityGroups(requests: BatchRequest[]): Map<string, BatchRequest[]> {
    const groups = new Map<string, BatchRequest[]>();
    for (const req of requests) {
      const groupId = req.atomicityGroup?.trim();
      if (!groupId) continue;
      req.atomicityGroup = groupId;
      let buffer = groups.get(groupId);
      if (!buffer) {
        buffer = [];
        groups.set(groupId, buffer);
      }
      buffer.push(req);
    }
    return groups;
  }

  private validateContiguousAtomicityGroups(requests: BatchRequest[]): void {
    const seen = new Map<string, number>();
    let activeGroup: string | undefined;
    requests.forEach((req, index) => {
      const groupId = req.atomicityGroup?.trim();
      if (!groupId) {
        activeGroup = undefined;
        return;
      }
      req.atomicityGroup = groupId;
      const firstIndex = seen.get(groupId);
      if (firstIndex === undefined) {
        seen.set(groupId, index);
        activeGroup = groupId;
        return;
      }
      if (activeGroup !== groupId) {
        throw new HttpErrors.BadRequest(
          `Atomicity group ${groupId} must be contiguous within the batch payload.`,
        );
      }
      activeGroup = groupId;
    });
  }

  private buildRequestOrderIndex(requests: BatchRequest[]): Map<BatchRequest, number> {
    const index = new Map<BatchRequest, number>();
    requests.forEach((req, idx) => index.set(req, idx));
    return index;
  }

  private validateJsonDependsOn(requests: BatchRequest[]): void {
    const idPositions = new Map<string, number>();

    requests.forEach((request, index) => {
      if (request.id) {
        if (idPositions.has(request.id)) {
          throw new HttpErrors.BadRequest(
            `Duplicate request id detected in batch payload: ${request.id}`,
          );
        }
        idPositions.set(request.id, index);
      }
      if (request.dependsOn === undefined) return;
      if (!Array.isArray(request.dependsOn)) {
        throw new HttpErrors.BadRequest('dependsOn must be an array of request identifiers.');
      }
      const normalized: string[] = [];
      for (const value of request.dependsOn) {
        if (typeof value !== 'string' || !value.trim()) {
          throw new HttpErrors.BadRequest('dependsOn entries must be non-empty strings.');
        }
        normalized.push(value.trim());
      }
      request.dependsOn = normalized;
    });

    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      const deps = request.dependsOn;
      if (!deps?.length) continue;
      if (!request.id) {
        throw new HttpErrors.BadRequest('Requests that declare dependsOn must also specify an id.');
      }
      for (const dependencyId of deps) {
        const dependencyIndex = idPositions.get(dependencyId);
        if (dependencyIndex === undefined) {
          throw new HttpErrors.BadRequest(
            `dependsOn references unknown request id: ${dependencyId}.`,
          );
        }
        if (dependencyIndex >= index) {
          throw new HttpErrors.BadRequest(
            `Request ${request.id} depends on ${dependencyId}, which appears later in the payload.`,
          );
        }
      }
    }
  }

  private sanitizeBatchRequestIdentifiers(requests: BatchRequest[]): void {
    for (const request of requests) {
      request.id = this.sanitizeBatchToken(request.id, 'request id');
      request.atomicityGroup = this.sanitizeBatchToken(request.atomicityGroup, 'atomicityGroup');
      if (request.dependsOn !== undefined) {
        if (!Array.isArray(request.dependsOn)) {
          throw new HttpErrors.BadRequest('dependsOn must be an array of request identifiers.');
        }
        request.dependsOn = request.dependsOn.map(
          (dep) => this.sanitizeBatchToken(dep, 'dependsOn entry')!,
        );
      }
    }
  }

  private sanitizeBatchToken(value: unknown, field: string): string | undefined {
    if (value == null) return undefined;
    if (typeof value !== 'string') {
      throw new HttpErrors.BadRequest(`Batch ${field} must be a string token.`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new HttpErrors.BadRequest(`Batch ${field} must be a non-empty token.`);
    }
    if (!BATCH_TOKEN_REGEX.test(trimmed)) {
      throw new HttpErrors.BadRequest(
        `Batch ${field} contains invalid characters. Only RFC7230 tokens are allowed.`,
      );
    }
    return trimmed;
  }

  private async executeGroup(
    requests: BatchRequest[],
    context: AtomicityGroupContext | undefined,
    parentRequest: Request,
    dependencyResults: Map<string, BatchResponseEntry>,
    requestOrder: Map<BatchRequest, number>,
    limits: NormalizedBatchLimits,
    tracker: ResponseSizeTracker | undefined,
    abortOnFailure: boolean,
    contentIdMap?: Map<string, string>,
    contentIdEtags?: Map<string, string>,
  ): Promise<BatchResponseEntry[]> {
    const entries: BatchResponseEntry[] = [];
    for (const request of requests) {
      if (contentIdMap) {
        this.assertContentIdAvailability(request, contentIdMap);
      }
      const dependencyFailure = this.evaluateDependsOn(request, dependencyResults);
      if (dependencyFailure) {
        if (tracker) {
          this.trackResponseSize(tracker, dependencyFailure);
        }
        entries.push(dependencyFailure);
        if (request.id) dependencyResults.set(request.id, dependencyFailure);
        if (abortOnFailure) break;
        continue;
      }
      const prepared = contentIdMap
        ? this.applyContentIdReferences(request, contentIdMap)
        : request;
      if (contentIdEtags) {
        this.ensureEtagPreconditions(prepared, contentIdEtags);
      }
      const entry = await this.executeSingle(prepared, context, parentRequest, limits);
      if (tracker) {
        this.trackResponseSize(tracker, entry);
      }
      entries.push(entry);
      if (request.id) dependencyResults.set(request.id, entry);
      if (contentIdMap) {
        this.recordContentIdResult(
          request,
          prepared,
          entry,
          contentIdMap,
          requestOrder,
          contentIdEtags,
        );
      }
      if (entry.status >= 400 && abortOnFailure) break;
    }
    return entries;
  }

  private assertContentIdAvailability(request: BatchRequest, contentIds: Map<string, string>) {
    this.detectUnknownContentIdsInString(request.url, contentIds);
    const headers = request.headers ?? {};
    for (const value of Object.values(headers)) {
      this.detectUnknownContentIdsInString(value, contentIds);
    }
    this.detectUnknownContentIdsInBody(request.body, contentIds);
  }

  private detectUnknownContentIdsInString(
    value: string | undefined,
    contentIds: Map<string, string>,
  ) {
    if (!value) return;
    const placeholder = this.extractContentIdToken(value);
    if (!placeholder) return;
    if (!this.resolveContentIdTokenValue(placeholder.token, contentIds)) {
      const err = new HttpErrors.BadRequest(`Unknown Content-ID reference ${value}.`);
      (err as AnyObject).code = ODataErrorCodes.ContentIdReferenceInvalid;
      throw err;
    }
  }

  private detectUnknownContentIdsInBody(
    value: unknown,
    contentIds: Map<string, string>,
    currentKey?: string,
  ) {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (this.shouldInspectContentIdValue(currentKey)) {
        this.detectUnknownContentIdsInString(value, contentIds);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        this.detectUnknownContentIdsInBody(entry, contentIds, currentKey);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        this.detectUnknownContentIdsInBody(entry, contentIds, key);
      }
    }
  }

  private shouldInspectContentIdValue(key?: string): boolean {
    if (!key) return false;
    const normalized = key.toLowerCase();
    return normalized === '@odata.id' || normalized.endsWith('@odata.bind');
  }

  private applyContentIdReferences(
    request: BatchRequest,
    contentIds: Map<string, string>,
  ): BatchRequest {
    const updated: BatchRequest = { ...request };
    updated.url = this.replaceContentIdTokensInString(request.url, contentIds) ?? request.url;
    if (request.headers) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = this.replaceContentIdTokensInString(value, contentIds) ?? value;
      }
      updated.headers = headers;
    }
    if (request.body !== undefined) {
      updated.body = this.replaceContentIdTokensInBody(request.body, contentIds);
    }
    return updated;
  }

  private replaceContentIdTokensInString(
    value: string | undefined,
    contentIds: Map<string, string>,
  ): string | undefined {
    if (!value) return value;
    const placeholder = this.extractContentIdToken(value);
    if (!placeholder) return value;
    const resolved = this.resolveContentIdTokenValue(placeholder.token, contentIds);
    if (!resolved) {
      const err = new HttpErrors.BadRequest(`Unknown Content-ID reference ${value}.`);
      (err as AnyObject).code = ODataErrorCodes.ContentIdReferenceInvalid;
      throw err;
    }
    if (placeholder.wrapper) {
      return `${placeholder.wrapper.prefix}${resolved}${placeholder.wrapper.suffix}`;
    }
    return resolved;
  }

  private replaceContentIdTokensInBody(
    value: unknown,
    contentIds: Map<string, string>,
    currentKey?: string,
  ): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      if (this.shouldInspectContentIdValue(currentKey)) {
        return this.replaceContentIdTokensInString(value, contentIds);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.replaceContentIdTokensInBody(entry, contentIds, currentKey));
    }
    if (this.isPlainObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = this.replaceContentIdTokensInBody(entry, contentIds, key);
      }
      return result;
    }
    return value;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  private extractContentIdToken(value: string | undefined): ContentIdTokenMatch | undefined {
    if (!value || value.length < 2) return undefined;
    let candidate = value;
    let wrapper: ContentIdTokenMatch['wrapper'];
    const unwrapped = this.unwrapContentIdWrapper(candidate);
    if (unwrapped) {
      candidate = unwrapped.value;
      wrapper = unwrapped.wrapper;
    }
    if (candidate.length < 2 || candidate[0] !== '$') return undefined;
    if (/^\$\d+$/.test(candidate)) {
      return { token: candidate.slice(1), wrapper };
    }
    if (/^\$[A-Za-z_][A-Za-z0-9_.-]*$/.test(candidate)) {
      return { token: candidate.slice(1), wrapper };
    }
    if (/^\$requests\([^)]*\)$/i.test(candidate)) {
      const inner = candidate.slice(candidate.indexOf('(') + 1, -1);
      if (!inner) return undefined;
      return { token: `requests(${inner})`, wrapper };
    }
    return undefined;
  }

  private unwrapContentIdWrapper(value: string):
    | {
        value: string;
        wrapper: {
          prefix: string;
          suffix: string;
        };
      }
    | undefined {
    if (value.length < 2) return undefined;
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      if (value.length <= 2) return undefined;
      return {
        value: value.slice(1, -1),
        wrapper: { prefix: first, suffix: first },
      };
    }
    if (
      value.length >= 4 &&
      value[0] === '\\' &&
      (value[1] === '"' || value[1] === "'") &&
      value[value.length - 2] === '\\' &&
      value[value.length - 1] === value[1]
    ) {
      if (value.length <= 4) return undefined;
      const quote = value[1];
      return {
        value: value.slice(2, -2),
        wrapper: { prefix: `\\${quote}`, suffix: `\\${quote}` },
      };
    }
    return undefined;
  }

  private resolveContentIdTokenValue(
    token: string,
    contentIds: Map<string, string>,
  ): string | undefined {
    if (!token) return undefined;
    if (!token.startsWith('requests(')) {
      return this.getContentIdValue(contentIds, token);
    }
    const candidates = this.expandContentIdToken(token);
    for (const candidate of candidates) {
      const resolved = this.getContentIdValue(contentIds, candidate);
      if (resolved) return resolved;
    }
    const inner = token.slice('requests('.length, -1);
    if (!inner) return undefined;
    const direct = this.getContentIdValue(contentIds, inner);
    if (direct) return direct;
    if (
      (inner.startsWith("'") && inner.endsWith("'")) ||
      (inner.startsWith('"') && inner.endsWith('"'))
    ) {
      const stripped = inner.slice(1, -1);
      return this.getContentIdValue(contentIds, stripped);
    }
    return undefined;
  }

  private expandContentIdToken(token: string): string[] {
    if (!token.startsWith('requests(') || !token.endsWith(')')) return [token];
    const inner = token.slice('requests('.length, -1);
    if (
      (inner.startsWith("'") && inner.endsWith("'")) ||
      (inner.startsWith('"') && inner.endsWith('"'))
    ) {
      const unquoted = inner.slice(1, -1);
      return [token, `requests(${unquoted})`];
    }
    return [token];
  }

  private getContentIdValue(contentIds: Map<string, string>, key: string): string | undefined {
    if (!key) return undefined;
    const direct = contentIds.get(key);
    if (direct !== undefined) return direct;
    const normalized = this.normalizeContentIdKey(key);
    if (normalized && normalized !== key) {
      return contentIds.get(normalized);
    }
    return undefined;
  }

  private normalizeContentIdKey(key?: string): string | undefined {
    if (!key) return undefined;
    return key.toLowerCase();
  }

  private registerContentIdAlias(
    contentIds: Map<string, string>,
    key: string | undefined,
    value: string,
  ) {
    if (!key) return;
    contentIds.set(key, value);
    const normalized = this.normalizeContentIdKey(key);
    if (normalized && normalized !== key) {
      contentIds.set(normalized, value);
    }
  }

  private recordContentIdResult(
    originalRequest: BatchRequest,
    preparedRequest: BatchRequest,
    response: BatchResponseEntry,
    contentIds: Map<string, string>,
    requestOrder: Map<BatchRequest, number>,
    contentIdEtags?: Map<string, string>,
  ) {
    if (!originalRequest.id) return;
    if (response.status < 200 || response.status >= 400) return;
    const target = this.resolveContentIdTarget(preparedRequest, response);
    if (!target) return;
    this.registerContentIdAlias(contentIds, originalRequest.id, target);
    const ordinal = requestOrder.get(originalRequest);
    if (ordinal !== undefined) {
      this.registerContentIdAlias(contentIds, `requests(${ordinal + 1})`, target);
    }
    this.registerContentIdAlias(contentIds, `requests(${originalRequest.id})`, target);
    this.registerContentIdAlias(contentIds, `requests('${originalRequest.id}')`, target);
    this.registerContentIdAlias(contentIds, `requests("${originalRequest.id}")`, target);
    if (contentIdEtags) {
      this.recordContentIdEtag(target, response, contentIdEtags);
    }
  }

  private recordContentIdEtag(
    target: string,
    response: BatchResponseEntry,
    contentIdEtags: Map<string, string>,
  ) {
    const etag = this.extractEtagFromResponse(response);
    if (!etag) return;
    const normalized = this.normalizeContentIdPath(target);
    if (!normalized) return;
    contentIdEtags.set(normalized, etag);
  }

  private extractEtagFromResponse(response: BatchResponseEntry): string | undefined {
    const fromHeader = this.getHeaderCaseInsensitive(response.headers, 'etag');
    if (fromHeader) return fromHeader;
    if (response.body && typeof response.body === 'object') {
      const candidate = (response.body as Record<string, unknown>)['@odata.etag'];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
    return undefined;
  }

  private normalizeContentIdPath(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const question = trimmed.indexOf('?');
    return question >= 0 ? trimmed.slice(0, question) : trimmed;
  }

  private ensureEtagPreconditions(
    request: BatchRequest,
    contentIdEtags: Map<string, string>,
  ): void {
    const method = request.method?.toUpperCase();
    if (!method) return;
    if (!['PATCH', 'PUT', 'DELETE'].includes(method)) return;
    const headers = request.headers ?? {};
    if (this.hasIfMatchHeader(headers)) return;
    const normalizedUrl = this.normalizeContentIdLookupPath(request.url);
    if (!normalizedUrl) return;
    const etag = contentIdEtags.get(normalizedUrl);
    if (!etag) return;
    request.headers = headers;
    headers['If-Match'] = etag;
  }

  private normalizeContentIdLookupPath(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const sanitized = this.sanitizeUrl(value, true);
    if (sanitized) return this.normalizeContentIdPath(sanitized);
    return this.normalizeContentIdPath(value);
  }

  private hasIfMatchHeader(headers: Record<string, string>): boolean {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'if-match') return true;
    }
    return false;
  }

  private resolveContentIdTarget(
    request: BatchRequest,
    response: BatchResponseEntry,
  ): string | undefined {
    const fromHeaders =
      this.getHeaderCaseInsensitive(response.headers, 'location') ??
      this.getHeaderCaseInsensitive(response.headers, 'odata-entityid') ??
      this.getHeaderCaseInsensitive(response.headers, 'odata-entity-id');
    if (fromHeaders) {
      const normalized = this.normalizeReferencedUrl(fromHeaders);
      if (normalized) return normalized;
    }

    if (response.body && typeof response.body === 'object') {
      const bodyObject = response.body as Record<string, unknown>;
      const odataId = bodyObject['@odata.id'];
      if (typeof odataId === 'string') {
        const normalized = this.normalizeReferencedUrl(odataId);
        if (normalized) return normalized;
      }
      const entitySet = this.resolveEntitySetName(request.url);
      if (entitySet) {
        const derived = this.buildEntityKeyPath(entitySet, bodyObject);
        if (derived) return derived;
      }
    }
    return undefined;
  }

  private normalizeReferencedUrl(raw: string): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        return parsed.pathname + parsed.search;
      } catch {
        return undefined;
      }
    }
    if (trimmed.startsWith('/')) return trimmed;
    return this.buildServiceRelativePath(trimmed);
  }

  private buildEntityKeyPath(
    entitySetName: string,
    body: Record<string, unknown>,
  ): string | undefined {
    const def = this.registry.findByName(entitySetName);
    const modelCtor = def?.modelCtor as
      | (typeof Entity & {
          definition?: {
            properties?: Record<string, PropertyDefinition>;
            idProperties?: () => string[];
          };
        })
      | undefined;
    if (!modelCtor) return undefined;
    const definition = modelCtor.definition as
      | {
          properties?: Record<string, PropertyDefinition>;
          idProperties?: () => string[];
        }
      | undefined;
    const idProps = modelCtor.getIdProperties?.() ?? definition?.idProperties?.() ?? [];
    const properties = definition?.properties ?? {};
    const keys = idProps.length
      ? idProps
      : Object.keys(properties).filter((name) => {
          const meta = properties[name];
          return Boolean(meta && (meta.id === true || meta.id === 1));
        });
    const targetKeys = keys.length ? keys : ['id'];
    const entries: Array<{ name: string; value: unknown; def?: PropertyDefinition }> = [];
    for (const key of targetKeys) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
      entries.push({ name: key, value: body[key], def: properties[key] });
    }
    if (!entries.length) return undefined;
    const literal = this.buildKeyLiteral(entries);
    const baseRoot = this.serviceRootPath === '/' ? '/' : this.serviceRootPath;
    const separator = baseRoot.endsWith('/') ? '' : '/';
    return `${baseRoot}${separator}${entitySetName}(${literal})`;
  }

  private buildKeyLiteral(
    entries: Array<{ name: string; value: unknown; def?: PropertyDefinition }>,
  ): string {
    if (entries.length === 1) {
      return this.serializeKeyValue(entries[0].value, entries[0].def);
    }
    return entries
      .map(({ name, value, def }) => `${name}=${this.serializeKeyValue(value, def)}`)
      .join(',');
  }

  private serializeKeyValue(value: unknown, def?: PropertyDefinition): string {
    if (value === null || value === undefined) {
      const err = new HttpErrors.BadRequest('Missing key value for Content-ID reference.');
      (err as AnyObject).code = ODataErrorCodes.ContentIdReferenceInvalid;
      throw err;
    }
    const type = def?.type;
    if (
      typeof value === 'bigint' ||
      type === 'bigint' ||
      type === BigInt ||
      type === 'int64' ||
      type === 'long' ||
      type === 'integer'
    ) {
      return value.toString();
    }
    if (type === Number || type === 'number') {
      const num = Number(value);
      if (!Number.isNaN(num)) return String(num);
    }
    if (type === Boolean || type === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (value instanceof Date) {
      return `datetime'${value.toISOString()}'`;
    }
    const literal = String(value);
    const escaped = literal.replace(/'/g, "''");
    return `'${escaped}'`;
  }

  private getHeaderCaseInsensitive(
    headers: Record<string, string> | undefined,
    name: string,
  ): string | undefined {
    if (!headers) return undefined;
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) return value;
    }
    return undefined;
  }

  private sanitizeHeadersForJsonBatchBody(
    headers: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!headers) return undefined;
    // Strip hop-by-hop or length/encoding headers that no longer match the base64 payload.
    const disallowed = new Set([
      'content-length',
      'content-transfer-encoding',
      'content-encoding',
      'transfer-encoding',
      'te',
      'trailer',
      'connection',
      'keep-alive',
      'upgrade',
      'proxy-connection',
    ]);
    let mutated = false;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (disallowed.has(key.toLowerCase())) {
        mutated = true;
        continue;
      }
      result[key] = value;
    }
    return mutated ? result : headers;
  }

  private async executeAtomicGroup(
    requests: BatchRequest[],
    groupId: string,
    parentRequest: Request,
    dependencyResults: Map<string, BatchResponseEntry>,
    requestOrder: Map<BatchRequest, number>,
    limits: NormalizedBatchLimits,
    tracker: ResponseSizeTracker,
    sharedContentIds: Map<string, string>,
    sharedContentIdEtags: Map<string, string>,
  ): Promise<BatchResponseEntry[]> {
    this.ensureAtomicityGroupContainsOnlyWrites(groupId, requests);
    let context: AtomicityGroupContext | undefined;
    try {
      context = await this.createAtomicGroupContext(groupId, requests, requestOrder);
    } catch (error) {
      const rejection = this.describeAtomicityGroupRejection(error);
      if (rejection) {
        this.logger.warn(rejection.logMessage, {
          scope: 'batch',
          atomicityGroup: groupId,
          reason: rejection.reason,
          dataSources: rejection.dataSources,
          entitySets: rejection.entitySets,
        });
        this.emitBatchTelemetry(
          'batch.changeset.rejected',
          {
            atomicityGroup: groupId,
            reason: rejection.reason,
            dataSources: rejection.dataSources,
            entitySets: rejection.entitySets,
          },
          'warn',
        );
        const entries = requests.map((req) => {
          const entry: BatchResponseEntry = {
            id: req.id,
            status: 501,
            body: this.odataError(rejection.code, rejection.message),
          };
          this.trackResponseSize(tracker, entry);
          if (req.id) dependencyResults.set(req.id, entry);
          return entry;
        });
        return entries;
      }
      throw error;
    }
    const contentIdMap = new Map<string, string>(sharedContentIds);
    const contentIdEtags = new Map<string, string>(sharedContentIdEtags);
    try {
      const entries = await this.executeGroup(
        requests,
        context,
        parentRequest,
        dependencyResults,
        requestOrder,
        limits,
        tracker,
        true,
        contentIdMap,
        contentIdEtags,
      );
      const failedIndex = entries.findIndex((entry) => entry.status >= 400);
      if (failedIndex >= 0) {
        await context?.rollback();
        // Append synthetic responses for any requests that were not executed due to failure
        if (entries.length < requests.length) {
          for (const req of requests.slice(entries.length)) {
            const synthetic: BatchResponseEntry = {
              id: req.id,
              status: 424, // Failed Dependency – request aborted due to earlier failure
              body: this.odataError(
                'FailedDependency',
                'Request not executed due to prior failure in changeset.',
              ),
            };
            this.trackResponseSize(tracker, synthetic);
            entries.push(synthetic);
            if (req.id) dependencyResults.set(req.id, synthetic);
          }
        }
        return entries;
      }
      await context?.commit();
      for (const [key, value] of contentIdMap) {
        if (!sharedContentIds.has(key)) {
          sharedContentIds.set(key, value);
        }
      }
      for (const [key, value] of contentIdEtags) {
        if (!sharedContentIdEtags.has(key)) {
          sharedContentIdEtags.set(key, value);
        }
      }
      return entries;
    } catch (error) {
      await context?.rollback();
      throw error;
    }
  }

  private evaluateDependsOn(
    request: BatchRequest,
    dependencyResults: Map<string, BatchResponseEntry>,
  ): BatchResponseEntry | undefined {
    const dependsOn = request.dependsOn;
    if (!dependsOn || !dependsOn.length) return undefined;
    for (const dependencyId of dependsOn) {
      const prior = dependencyResults.get(dependencyId);
      if (!prior) {
        return {
          id: request.id,
          status: 424,
          body: this.odataError(
            'FailedDependency',
            `Request depends on ${dependencyId}, which did not execute.`,
          ),
        };
      }
      if (prior.status >= 400) {
        return {
          id: request.id,
          status: 424,
          body: this.odataError(
            'FailedDependency',
            `Request depends on ${dependencyId}, which failed.`,
          ),
        };
      }
    }
    return undefined;
  }

  private ensureAtomicityGroupContainsOnlyWrites(groupId: string, requests: BatchRequest[]): void {
    const allowed = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    for (const request of requests) {
      const method = (request.method ?? '').toUpperCase();
      if (!allowed.has(method)) {
        throw new HttpErrors.BadRequest(
          `Atomicity group ${groupId} contains unsupported ${method || 'unknown'} request.`,
        );
      }
    }
  }

  private async createAtomicGroupContext(
    groupId: string,
    requests: BatchRequest[],
    requestOrder?: Map<BatchRequest, number>,
  ): Promise<AtomicityGroupContext | undefined> {
    const order = requestOrder ?? this.buildRequestOrderIndex(requests);
    const setNames = new Set<string>();
    const setDefs = new Map<string, EntitySetDef>();
    const dataSourcesBySet = new Map<string, juggler.DataSource>();
    const dataSourceInstances = new Set<juggler.DataSource>();
    const dataSourceNameCounts = new Map<string, number>();
    const dataSourceResolution = new Map<
      juggler.DataSource,
      { name?: string; bindingKey: string }
    >();
    const nonTransactionalSets = new Set<string>();

    const entitySetCache = new Map<BatchRequest, string | undefined>();
    for (const request of requests) {
      const method = (request.method ?? 'GET').toUpperCase();
      // Only open transactions for write operations. GET/HEAD must not require a transaction.
      if (method === 'GET' || method === 'HEAD') continue;
      const resolved = this.resolveAtomicityGroupEntitySetName(
        request,
        groupId,
        requests,
        order,
        entitySetCache,
        new Set(),
      );
      if (!resolved) {
        throw this.atomicityGroupUnsupported(groupId, {
          reason: 'unresolvable',
          entitySets: Array.from(setNames),
        });
      }
      setNames.add(resolved);
    }

    if (!setNames.size) return undefined;

    // Map entity sets to datasources (no transactions opened during this pass).
    for (const setName of setNames) {
      const def = this.registry.findByName(setName);
      if (!def) {
        throw this.atomicityGroupUnsupported(groupId, {
          reason: 'unresolvable',
          entitySets: Array.from(setNames),
        });
      }
      setDefs.set(setName, def);
      if (def.supportsTransactions === false && def.transactionCapabilityLocked === true) {
        nonTransactionalSets.add(def.name);
        continue;
      }
      if (!def.repositoryBindingKey) {
        throw new HttpErrors.InternalServerError(
          `Entity set ${def.name} is missing a repository binding and cannot participate in transactions.`,
        );
      }
      const repository = await this.app.get(def.repositoryBindingKey);
      const dataSource = (repository as { dataSource?: juggler.DataSource }).dataSource;
      if (!dataSource) {
        this.markEntitySetNonTransactional(def, def.repositoryBindingKey);
        nonTransactionalSets.add(def.name);
        continue;
      }
      dataSourcesBySet.set(setName, dataSource);
      dataSourceInstances.add(dataSource);
      const name = dataSource.name;
      if (name) {
        dataSourceNameCounts.set(name, (dataSourceNameCounts.get(name) ?? 0) + 1);
      }
      dataSourceResolution.set(dataSource, {
        name: dataSource.name,
        bindingKey: def.repositoryBindingKey,
      });
    }

    if (nonTransactionalSets.size) {
      const affected = Array.from(nonTransactionalSets);
      this.warn('Atomicity group contains non-transactional entity sets.', {
        atomicityGroup: groupId,
        entitySets: affected,
      });
      throw this.atomicityTransactionsUnsupported(groupId, affected);
    }

    if (dataSourceInstances.size > 1) {
      const dataSources: string[] = [];
      for (const info of dataSourceResolution.values()) {
        if (info.name) {
          const count = dataSourceNameCounts.get(info.name) ?? 0;
          dataSources.push(count > 1 ? `${info.name} (${info.bindingKey})` : info.name);
        } else {
          dataSources.push(info.bindingKey);
        }
      }
      throw this.atomicityMultiDataSourceUnsupported(groupId, {
        dataSources: Array.from(new Set(dataSources)),
        entitySets: Array.from(setNames),
      });
    }

    const chosenSet = Array.from(setNames)[0];
    const chosenDef = setDefs.get(chosenSet);
    const chosenDataSource = chosenSet ? dataSourcesBySet.get(chosenSet) : undefined;
    const chosenKey =
      chosenDataSource && chosenDef
        ? (chosenDataSource.name ?? chosenDef.repositoryBindingKey)
        : undefined;

    // Validate transaction capability for all entity sets before starting a transaction.
    for (const setName of setNames) {
      const def = setDefs.get(setName);
      const dataSource = dataSourcesBySet.get(setName);
      if (!def || !dataSource) continue;
      const transactional = await this.ensureTransactionalSupport(def, groupId, dataSource);
      if (!transactional) {
        nonTransactionalSets.add(def.name);
        continue;
      }
      if (!dataSourceSupportsTransactions(dataSource)) {
        this.markEntitySetNonTransactional(def, dataSource.name ?? def.repositoryBindingKey);
        nonTransactionalSets.add(def.name);
      }
    }

    if (nonTransactionalSets.size) {
      const affected = Array.from(nonTransactionalSets);
      this.warn('Atomicity group contains non-transactional entity sets.', {
        atomicityGroup: groupId,
        entitySets: affected,
      });
      throw this.atomicityTransactionsUnsupported(groupId, affected);
    }

    if (!chosenDataSource || !chosenKey) {
      const affected = Array.from(setNames);
      this.warn('Atomicity group cannot start datasource transactions.', {
        atomicityGroup: groupId,
        entitySets: affected,
      });
      throw this.atomicityTransactionsUnsupported(groupId, affected);
    }

    const transactionsBySet = new Map<string, Transaction>();
    let tx: Transaction;
    try {
      tx = await this.beginTransactionForDataSource(chosenDataSource);
    } catch (error) {
      if (error instanceof HttpErrors.HttpError && error.statusCode === 501) {
        for (const def of setDefs.values()) {
          this.markEntitySetNonTransactional(def, chosenKey);
        }
        throw this.atomicityTransactionsUnsupported(groupId, Array.from(setNames));
      }
      throw error;
    }

    for (const setName of setNames) {
      const def = setDefs.get(setName);
      if (!def) continue;
      def.supportsTransactions = true;
      def.transactionCapabilityLocked = true;
      transactionsBySet.set(def.name, tx);
    }

    return new AtomicityGroupContext(groupId, transactionsBySet, chosenDataSource, chosenKey);
  }

  private resolveAtomicityGroupEntitySetName(
    request: BatchRequest,
    groupId: string,
    groupRequests: BatchRequest[],
    requestOrder: Map<BatchRequest, number>,
    cache: Map<BatchRequest, string | undefined>,
    visiting: Set<BatchRequest>,
  ): string | undefined {
    if (cache.has(request)) return cache.get(request);
    if (visiting.has(request)) return undefined;
    visiting.add(request);
    try {
      const direct = this.resolveEntitySetName(request.url);
      if (direct) {
        cache.set(request, direct);
        return direct;
      }
      const stripped = this.stripServiceRootFromUrl(request.url);
      if (!stripped?.length) {
        cache.set(request, undefined);
        return undefined;
      }
      const firstRaw = this.decodePathSegment(stripped[0]);
      if (!firstRaw || !firstRaw.startsWith('$')) {
        cache.set(request, undefined);
        return undefined;
      }
      const tokenMatch = this.extractContentIdToken(firstRaw);
      if (!tokenMatch) {
        cache.set(request, undefined);
        return undefined;
      }
      const referenced = this.resolveAtomicityGroupContentIdReference(
        tokenMatch.token,
        request,
        groupId,
        groupRequests,
        requestOrder,
      );
      if (!referenced) {
        const err = new HttpErrors.BadRequest(
          `Invalid Content-ID reference ${firstRaw}: must reference an earlier request in the same changeset.`,
        );
        (err as AnyObject).code = ODataErrorCodes.ContentIdReferenceInvalid;
        throw err;
      }
      const baseSet = this.resolveAtomicityGroupEntitySetName(
        referenced,
        groupId,
        groupRequests,
        requestOrder,
        cache,
        visiting,
      );
      if (!baseSet) {
        cache.set(request, undefined);
        return undefined;
      }
      const resolved = this.resolveEntitySetFromBase(baseSet, stripped.slice(1));
      cache.set(request, resolved);
      return resolved;
    } finally {
      visiting.delete(request);
    }
  }

  private resolveAtomicityGroupContentIdReference(
    token: string,
    request: BatchRequest,
    groupId: string,
    groupRequests: BatchRequest[],
    requestOrder: Map<BatchRequest, number>,
  ): BatchRequest | undefined {
    const groupById = new Map<string, BatchRequest>();
    for (const candidate of groupRequests) {
      if (candidate.id) groupById.set(candidate.id, candidate);
    }
    let referenced: BatchRequest | undefined;
    if (token.startsWith('requests(') && token.endsWith(')')) {
      const inner = token.slice('requests('.length, -1).trim();
      if (/^\d+$/.test(inner)) {
        const ordinal = Number(inner);
        if (!Number.isFinite(ordinal) || ordinal <= 0) return undefined;
        for (const [req, idx] of requestOrder) {
          if (idx + 1 === ordinal) {
            referenced = req;
            break;
          }
        }
      } else {
        const stripped =
          (inner.startsWith("'") && inner.endsWith("'")) ||
          (inner.startsWith('"') && inner.endsWith('"'))
            ? inner.slice(1, -1)
            : inner;
        referenced = groupById.get(stripped);
      }
    } else {
      referenced = groupById.get(token);
    }
    if (!referenced) return undefined;
    if (referenced.atomicityGroup?.trim() !== groupId) return undefined;
    const currentIndex = requestOrder.get(request);
    const referencedIndex = requestOrder.get(referenced);
    if (currentIndex === undefined || referencedIndex === undefined) return undefined;
    if (referencedIndex >= currentIndex) return undefined;
    return referenced;
  }

  private resolveEntitySetFromBase(
    baseSetName: string,
    trailingSegments: string[],
  ): string | undefined {
    let current = this.registry.findByName(baseSetName);
    if (!current) return undefined;
    for (const segmentRaw of trailingSegments) {
      const segment = this.normalizePathSegment(segmentRaw);
      if (!segment || segment.startsWith('$')) break;
      const next = this.resolveNavigationTargetEntitySet(current, segment);
      if (!next) break;
      current = next;
    }
    return current?.name;
  }

  private stripServiceRootFromUrl(rawUrl: string): string[] | undefined {
    const sanitized = this.sanitizeUrl(rawUrl, true);
    if (!sanitized) return undefined;
    const [path] = sanitized.split('?');
    const segments = path.split('/').filter(Boolean);
    return this.stripServiceRootSegments(segments);
  }

  private decodePathSegment(segment: string): string {
    if (!segment) return segment;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  private describeAtomicityGroupRejection(error: unknown):
    | {
        code: string;
        message: string;
        reason: 'multi-datasource' | 'unresolvable';
        dataSources: string[];
        entitySets: string[];
        logMessage: string;
      }
    | undefined {
    if (!(error instanceof HttpErrors.HttpError)) return undefined;
    if (error.statusCode !== 501) return undefined;
    const code = (error as AnyObject).code;
    if (
      code !== ODataErrorCodes.MultiDataSourceChangesetNotSupported &&
      code !== ODataErrorCodes.AtomicityGroupNotSupported
    ) {
      return undefined;
    }
    const details = (error as AnyObject).details as AnyObject | undefined;
    const reason =
      (details?.reason as 'multi-datasource' | 'unresolvable' | undefined) ?? 'unresolvable';
    const dataSources = Array.isArray(details?.dataSources)
      ? (details?.dataSources as string[])
      : [];
    const entitySets = Array.isArray(details?.entitySets) ? (details?.entitySets as string[]) : [];
    return {
      code,
      message: error.message ?? 'Atomicity group rejected.',
      reason,
      dataSources,
      entitySets,
      logMessage:
        code === ODataErrorCodes.MultiDataSourceChangesetNotSupported
          ? 'Atomicity group rejected: multi-datasource changeset.'
          : 'Atomicity group rejected: unresolvable datasource.',
    };
  }
  private async rollbackGroupTransactions(transactions: Transaction[]): Promise<void> {
    for (const tx of transactions) {
      try {
        await tx.rollback();
      } catch {
        /* ignore rollback errors */
      }
    }
  }

  private atomicityTransactionsUnsupported(
    groupId: string,
    entitySets: string[],
  ): HttpErrors.HttpError {
    const detail = entitySets.length
      ? `The following entity sets do not support transactions: ${entitySets.join(', ')}.`
      : 'Datasource transactions are unavailable.';
    const err = new HttpErrors.NotImplemented(
      `Atomicity group ${groupId} cannot be executed without transaction support. ${detail}`,
    );
    (err as AnyObject).code = ODataErrorCodes.TransactionsNotSupported;
    (err as AnyObject).details = { entitySets };
    return err;
  }

  private atomicityMultiDataSourceUnsupported(
    groupId: string,
    details: { dataSources: string[]; entitySets: string[] },
  ): HttpErrors.HttpError {
    const list = details.dataSources?.length ? details.dataSources.join(', ') : 'unknown';
    const err = new HttpErrors.NotImplemented(
      `Atomicity group ${groupId} would write to multiple datasources (${list}). Split into separate changesets or use a single datasource.`,
    );
    (err as AnyObject).code = ODataErrorCodes.MultiDataSourceChangesetNotSupported;
    (err as AnyObject).details = { ...details, reason: 'multi-datasource' };
    return err;
  }

  private atomicityGroupUnsupported(
    groupId: string,
    details: { reason: 'unresolvable'; entitySets?: string[]; dataSources?: string[] },
  ): HttpErrors.HttpError {
    const err = new HttpErrors.NotImplemented(
      `Atomicity group ${groupId} contains a write request that cannot be mapped to a registered entity set; changeset atomicity cannot be guaranteed.`,
    );
    (err as AnyObject).code = ODataErrorCodes.AtomicityGroupNotSupported;
    (err as AnyObject).details = { ...details, reason: 'unresolvable' };
    return err;
  }

  private resolveEntitySetName(rawUrl: string): string | undefined {
    const sanitized = this.sanitizeUrl(rawUrl, true);
    if (!sanitized) return undefined;
    const [path] = sanitized.split('?');
    const segments = path.split('/').filter(Boolean);
    const stripped = this.stripServiceRootSegments(segments);
    if (!stripped || !stripped.length) return undefined;

    const normalizedSegments = stripped
      .map((segment) => this.normalizePathSegment(segment))
      .filter((segment): segment is string => Boolean(segment));

    if (!normalizedSegments.length) return undefined;
    const [first, ...rest] = normalizedSegments;
    if (!first || first.startsWith('$')) return undefined;

    const strippedFirst = this.stripNamespacePrefix(first);
    let current = this.registry.findByName(first) ?? this.registry.findByName(strippedFirst);
    if (!current) return undefined;

    for (const segment of rest) {
      if (!segment || segment.startsWith('$')) break;
      const next = this.resolveNavigationTargetEntitySet(current, segment);
      if (!next) break;
      current = next;
    }

    return current?.name;
  }

  private stripNamespacePrefix(entitySet: string): string {
    const prefixes = [this.cfg?.namespace, this.cfg?.namespaceAlias]
      .filter((value): value is string => Boolean(value))
      .map((value) => `${value}.`);
    for (const prefix of prefixes) {
      if (entitySet.startsWith(prefix)) {
        return entitySet.slice(prefix.length);
      }
    }
    return entitySet;
  }

  private normalizePathSegment(segment: string): string | undefined {
    if (!segment) return undefined;
    const trimmed = segment.trim();
    if (!trimmed) return undefined;
    const parenIndex = trimmed.indexOf('(');
    const base = parenIndex >= 0 ? trimmed.slice(0, parenIndex) : trimmed;
    if (!base) return undefined;
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  }

  private resolveNavigationTargetEntitySet(
    current: EntitySetDef,
    segment: string,
  ): EntitySetDef | undefined {
    const modelCtor = current.modelCtor as typeof Entity | undefined;
    if (!modelCtor) return undefined;
    const definition = ensureModelDefinitionWithRelations(modelCtor);
    const relations = (definition?.relations ?? {}) as Record<string, AnyObject | undefined>;
    const relation = this.findRelationMeta(relations, segment);
    if (!relation) return undefined;
    const targetModel = this.resolveRelationTargetModel(relation);
    if (!targetModel) return undefined;
    return this.registry.get(targetModel);
  }

  private findRelationMeta(
    relations: Record<string, AnyObject | undefined>,
    segment: string,
  ): AnyObject | undefined {
    const exact = relations[segment];
    if (exact) return exact;
    const lower = segment.toLowerCase();
    for (const [name, meta] of Object.entries(relations)) {
      if (name.toLowerCase() === lower && meta) {
        return meta;
      }
    }
    return undefined;
  }

  private resolveRelationTargetModel(meta: AnyObject | undefined): typeof Entity | undefined {
    if (!meta) return undefined;
    const target = meta.target;
    if (!target) return undefined;
    if (this.isEntityConstructor(target as AnyObject)) {
      return target as typeof Entity;
    }
    if (typeof target === 'function') {
      try {
        const resolved = (target as () => typeof Entity)();
        if (this.isEntityConstructor(resolved as AnyObject)) {
          return resolved as typeof Entity;
        }
        if (typeof resolved === 'function' && this.isEntityConstructor(resolved as AnyObject)) {
          return resolved as typeof Entity;
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private isEntityConstructor(value: AnyObject): value is typeof Entity {
    return isEntityCtor(value);
  }

  private extractBoundary(contentType: string): string | undefined {
    const match = /boundary=([^;]+)/i.exec(contentType ?? '');
    if (!match) return undefined;
    return match[1]?.trim().replace(/^"|"$/g, '');
  }

  private async beginTransactionForDataSource(
    dataSource: juggler.DataSource,
  ): Promise<Transaction> {
    if (typeof dataSource.beginTransaction !== 'function') {
      throw new HttpErrors.NotImplemented(
        `Datasource ${dataSource.name ?? 'unknown'} cannot begin a transaction: missing beginTransaction().`,
      );
    }
    try {
      return (await dataSource.beginTransaction(
        IsolationLevel.READ_COMMITTED,
      )) as unknown as Transaction;
    } catch (err) {
      if (err instanceof HttpErrors.HttpError && err.statusCode === 501) {
        throw new HttpErrors.NotImplemented(
          `Datasource ${dataSource.name ?? 'unknown'} cannot begin a transaction: ${err.message ?? 'unsupported connector'}.`,
        );
      }
      const message = (err as Error)?.message?.toLowerCase?.() ?? '';
      if (message.includes('not implemented') || message.includes('not support')) {
        throw new HttpErrors.NotImplemented(
          `Datasource ${dataSource.name ?? 'unknown'} cannot begin a transaction: ${(err as Error).message ?? 'unsupported connector'}.`,
        );
      }
      throw err;
    }
  }

  private async executeWithHandler(
    request: BatchRequest,
    context: AtomicityGroupContext | undefined,
    parentRequest: Request,
    limits: NormalizedBatchLimits,
  ): Promise<BatchResponseEntry> {
    const url = this.sanitizeUrl(request.url, true);
    if (!url) {
      return {
        id: request.id,
        status: 400,
        body: this.odataError(ODataErrorCodes.InvalidUrl, `Invalid request URL: ${request.url}`),
      };
    }

    const rewrittenUrl = rewriteODataUrl(url, {
      namespace: this.cfg?.namespace,
      namespaceAlias: this.cfg?.namespaceAlias,
    });

    const method = request.method?.toUpperCase();
    if (!method) {
      return {
        id: request.id,
        status: 400,
        body: this.odataError(ODataErrorCodes.InvalidMethod, 'Batch request method is required.'),
      };
    }

    const bodyBuffer = this.resolveRequestBodyBuffer(request);
    const socket = new PassThrough() as any;
    const remoteAddress = this.getRemoteAddress(parentRequest);
    if (remoteAddress) {
      socket.remoteAddress = remoteAddress;
    }
    // minimal socket surface for Node/Express expectations
    socket.writable = true;
    socket.readable = true;
    socket.setTimeout = () => socket;
    socket.setNoDelay = () => socket;
    socket.setKeepAlive = () => socket;
    socket.ref = () => socket;
    socket.unref = () => socket;
    socket.destroy = () => {};

    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = rewrittenUrl;
    const combinedHeaders = this.buildHeadersForRequest(request, parentRequest);
    (req as any).headers = combinedHeaders;
    const { protocol: resolvedProtocol, secure: isSecure } =
      this.resolveParentProtocolState(parentRequest);
    (req as any).protocol = resolvedProtocol;
    (req as any).secure = isSecure;
    socket.encrypted = isSecure;
    const parentDepth = this.getBatchDepth(parentRequest);
    this.enforceBatchDepthLimit(parentDepth + 1, limits);
    this.setBatchDepth(req, parentDepth + 1);

    Object.defineProperty(req, 'path', {
      enumerable: true,
      configurable: true,
      get() {
        const currentUrl = (req as any).url ?? '';
        if (typeof currentUrl !== 'string') return '';
        const qIndex = currentUrl.indexOf('?');
        return qIndex >= 0 ? currentUrl.slice(0, qIndex) : currentUrl;
      },
    });

    const queryIndex = rewrittenUrl.indexOf('?');
    (req as any).query =
      queryIndex >= 0 && queryIndex < rewrittenUrl.length - 1
        ? this.buildQueryObject(rewrittenUrl.slice(queryIndex + 1))
        : {};
    if (
      bodyBuffer.length &&
      this.shouldDefaultJsonContentType(request) &&
      !combinedHeaders['content-type']
    ) {
      combinedHeaders['content-type'] = 'application/json';
    }
    if (bodyBuffer.length) {
      combinedHeaders['content-length'] = String(bodyBuffer.length);
    }

    // minimal Express-style helpers used by LB4
    (req as any).get = (name: string) => {
      return (req as any).headers?.[String(name).toLowerCase()] as string | undefined;
    };
    (req as any).header = (name: string) => (req as any).get(name);
    (req as any).baseUrl = '';
    (req as any).originalUrl = url;

    const res = new ServerResponse(req);
    res.assignSocket?.(socket);
    const chunks: Buffer[] = [];
    let resolved = false;
    const responseLimit = limits.maxResponseBodyBytes ?? 0;
    const enforceResponseLimit = typeof responseLimit === 'number' && responseLimit > 0;
    let capturedResponseBytes = 0;
    let responseLimitExceeded = false;
    let responseLimitExceededBytes: number | undefined;

    const captureChunk = (chunk: any, encoding?: BufferEncoding) => {
      if (!chunk || responseLimitExceeded) return;
      const bufferChunk = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : Buffer.from(chunk);
      if (enforceResponseLimit) {
        capturedResponseBytes += bufferChunk.length;
        if (capturedResponseBytes > responseLimit) {
          responseLimitExceeded = true;
          responseLimitExceededBytes = capturedResponseBytes;
          chunks.length = 0;
          this.warn('Batch sub-response exceeded configured size limit.', {
            requestId: request.id,
            method,
            url,
            limitBytes: responseLimit,
            observedBytes: responseLimitExceededBytes,
          });
          const overflowError = new HttpErrors.PayloadTooLarge(
            'Batch sub-response exceeded the configured size limit.',
          );
          res.destroy(overflowError);
          socket.destroy?.(overflowError);
          res.emit('close');
          return;
        }
      }
      chunks.push(bufferChunk);
    };

    const finishPromise = new Promise<BatchResponseEntry>((resolve, reject) => {
      const finalize = () => {
        if (resolved) return;
        resolved = true;
        if (responseLimitExceeded) {
          const limitMessage = enforceResponseLimit
            ? `Batch sub-response exceeded the configured size limit of ${responseLimit} bytes.`
            : 'Batch sub-response exceeded the configured size limit.';
          resolve({
            id: request.id,
            status: 413,
            body: this.odataError(ODataErrorCodes.ResponseTooLarge, limitMessage),
          });
          return;
        }
        const payloadBuffer = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.getHeaders())) {
          if (typeof value === 'string') headers[key] = value;
          else if (Array.isArray(value)) headers[key] = value.join(',');
        }
        const body = this.decodeBufferedBody(payloadBuffer, headers);
        resolve({ id: request.id, status: res.statusCode, headers, body });
      };

      res.on('finish', finalize);
      res.on('close', finalize);
      res.on('error', reject);
    });

    const write = res.write.bind(res);
    res.write = function (chunk: any, ...args: any[]) {
      if (responseLimitExceeded) return false;
      const encoding = typeof args[0] === 'string' ? (args[0] as BufferEncoding) : undefined;
      captureChunk(chunk, encoding);
      if (responseLimitExceeded) return false;
      return write(chunk, ...args);
    } as any;

    const end = res.end.bind(res);
    res.end = function (chunk?: any, ...args: any[]) {
      if (!responseLimitExceeded && chunk) {
        const encoding = typeof args[0] === 'string' ? (args[0] as BufferEncoding) : undefined;
        captureChunk(chunk, encoding);
      }
      if (responseLimitExceeded) return res;
      return end(chunk, ...args);
    } as any;

    // Provide Express-style response helpers expected by LoopBack internals
    (res as any).status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    (res as any).contentType = (type: string) => {
      res.setHeader('Content-Type', type);
      return res;
    };
    (res as any).type = (type: string) => {
      res.setHeader('Content-Type', type);
      return res;
    };
    (res as any).set = (field: string, value: string) => {
      res.setHeader(field, value);
      return res;
    };
    (res as any).header = (field: string, value: string) => {
      res.setHeader(field, value);
      return res;
    };
    (res as any).json = (body: unknown) => {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? null));
      res.end(payload);
      return res;
    };
    (res as any).send = (body: unknown) => {
      if (body === undefined || body === null) {
        res.end();
        return res;
      }
      if (Buffer.isBuffer(body)) {
        res.end(body);
        return res;
      }
      if (typeof body === 'object') {
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
        return res;
      }
      res.end(String(body));
      return res;
    };

    if ((parentRequest as any)?.user !== undefined) {
      (req as any).user = (parentRequest as any).user;
    }

    context?.applyTo(req);
    const handlerPromise = this.httpHandler
      .handleRequest(req as any, res as any)
      .catch(() => undefined)
      .finally(() => {
        context?.clearFrom(req);
      });

    // Feed request body to the IncomingMessage stream directly
    if (bodyBuffer.length) {
      (req as any).push(bodyBuffer);
    }
    (req as any).push(null);

    const abortRequest = (reason: Error) => {
      if ((res as any).writableEnded !== true) {
        try {
          res.destroy?.(reason);
        } catch {
          /* ignore */
        }
      }
      try {
        socket.destroy?.(reason);
      } catch {
        /* ignore */
      }
      try {
        (req as any).destroy?.(reason);
      } catch {
        /* ignore */
      }
    };

    // Add per-request timeout to avoid hangs; wait for finish/close
    const timeoutMs = this.cfg?.batch?.subRequestTimeoutMs ?? DEFAULT_SUBREQUEST_TIMEOUT_MS;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (!timeoutMs || timeoutMs <= 0) return;
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        const error = new Error('Batch sub-request timeout');
        abortRequest(error);
        reject(error);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([finishPromise, timeoutPromise]);
      return result;
    } catch (error) {
      const status = timedOut ? 504 : ((error as { statusCode?: number })?.statusCode ?? 500);
      const code = timedOut
        ? ODataErrorCodes.BatchSubRequestTimeout
        : ODataErrorCodes.BatchExecutionError;
      const message =
        (error as Error)?.message ??
        (timedOut ? 'Batch sub-request timeout.' : 'Failed to execute request.');
      return {
        id: request.id,
        status,
        body: this.odataError(code, message),
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async executeSingle(
    request: BatchRequest,
    context: AtomicityGroupContext | undefined,
    parentRequest: Request,
    limits: NormalizedBatchLimits,
  ): Promise<BatchResponseEntry> {
    return this.executeWithRedirects(request, context, parentRequest, limits);
  }

  private async executeWithRedirects(
    request: BatchRequest,
    context: AtomicityGroupContext | undefined,
    parentRequest: Request,
    limits: NormalizedBatchLimits,
  ): Promise<BatchResponseEntry> {
    const MAX_REDIRECTS = 3;
    let remainingRedirects = MAX_REDIRECTS;
    let current: BatchRequest = { ...request };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await this.executeWithHandler(current, context, parentRequest, limits);
      if (!this.isRedirectStatus(response.status)) {
        return response;
      }
      const method = (current.method ?? '').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        return response;
      }
      const location = this.getHeaderCaseInsensitive(response.headers, 'location');
      if (!location) {
        return response;
      }
      const nextPath = this.resolveRedirectPath(location);
      if (!nextPath) {
        return response;
      }
      if (remainingRedirects <= 0) {
        this.warn('Batch sub-request exceeded redirect limits.', {
          requestId: current.id,
          method,
        });
        return {
          id: current.id,
          status: 400,
          body: this.odataError(
            ODataErrorCodes.TooManyRedirects,
            'Batch sub-request exceeded redirect limits.',
          ),
        };
      }
      remainingRedirects -= 1;
      current = { ...current, url: nextPath };
    }
  }

  private sanitizeUrl(rawUrl: string, allowRelative = false): string | undefined {
    if (!rawUrl) return undefined;
    const trimmed = String(rawUrl).trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('//')) {
      return undefined;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        const normalized = parsed.pathname + parsed.search;
        return this.ensureWithinServiceRoot(normalized);
      } catch {
        return undefined;
      }
    }
    // Accept absolute app paths that belong to the service root
    if (trimmed.startsWith('/')) {
      return this.ensureWithinServiceRoot(trimmed);
    }
    // Optionally resolve relative OData paths (e.g. "Books", "Books(1)?$select=...")
    if (allowRelative) {
      return this.buildServiceRelativePath(trimmed);
    }
    // Otherwise, treat relative URLs as invalid in JSON $batch
    return undefined;
  }

  private resolveRedirectPath(location: string | undefined): string | undefined {
    if (!location) return undefined;
    const trimmed = location.trim();
    if (!trimmed) return undefined;
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const candidate = new URL(trimmed);
        const base = new URL(this.serverUrl);
        if (candidate.origin !== base.origin) {
          return undefined;
        }
        return candidate.pathname + candidate.search;
      } catch {
        return undefined;
      }
    }
    const sanitized = this.sanitizeUrl(trimmed, true);
    if (!sanitized) return undefined;
    try {
      const target = new URL(sanitized, this.serverUrl);
      return target.pathname + target.search;
    } catch {
      return undefined;
    }
  }

  private ensureWithinServiceRoot(url: string): string | undefined {
    if (!url || !url.startsWith('/')) return undefined;
    const rootRouteNames =
      this.serviceRootPath === '/' ? this.getConfiguredRootRouteNames() : undefined;
    return matchesConfiguredODataPath(
      url,
      this.serviceRootPath,
      rootRouteNames,
    )
      ? url
      : undefined;
  }

  private buildServiceRelativePath(rawUrl: string): string | undefined {
    const trimmed = String(rawUrl ?? '').trim();
    if (!trimmed) return this.serviceRootPath;
    if (trimmed.startsWith('//')) return undefined;
    if (trimmed.startsWith('/')) return trimmed;
    const question = trimmed.indexOf('?');
    const pathPart = question >= 0 ? trimmed.slice(0, question) : trimmed;
    const query = question >= 0 ? trimmed.slice(question) : '';
    const normalizedPath = pathPart.replace(/^\/+/, '');
    const prefix = this.serviceRootPath === '/' ? '/' : this.serviceRootPath;
    const separator = normalizedPath.length === 0 ? '' : this.serviceRootPath === '/' ? '' : '/';
    return this.ensureWithinServiceRoot(`${prefix}${separator}${normalizedPath}${query}`);
  }

  private buildQueryObject(query: string): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    if (!query) return result;
    const params = new URLSearchParams(query);
    for (const [key, value] of params.entries()) {
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        const current = result[key];
        if (Array.isArray(current)) {
          current.push(value);
        } else {
          result[key] = [current, value];
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private stripServiceRootSegments(segments: string[]): string[] | undefined {
    if (!this.serviceRootSegments.length) return segments;
    if (segments.length < this.serviceRootSegments.length) return undefined;
    for (let i = 0; i < this.serviceRootSegments.length; i++) {
      const expected = this.serviceRootSegments[i];
      if ((segments[i] ?? '').toLowerCase() !== expected.toLowerCase()) {
        return undefined;
      }
    }
    return segments.slice(this.serviceRootSegments.length);
  }

  private getConfiguredRootRouteNames(): ReadonlySet<string> | undefined {
    const version = this.registry.getVersion();
    if (this.cachedRootNames && this.cachedRegistryVersion === version) {
      return this.cachedRootNames;
    }

    this.cachedRootNames = buildODataRootRouteNames(this.registry.list());
    this.cachedRegistryVersion = version;
    return this.cachedRootNames;
  }

  private resolveAllowedSubRequestHeaders(): Set<string> {
    if (this.allowedSubRequestHeaders) return this.allowedSubRequestHeaders;
    const configured = this.cfg?.batch?.allowedSubRequestHeaders;
    const merged = new Set<string>(DEFAULT_ALLOWED_SUBREQUEST_HEADERS);
    if (Array.isArray(configured)) {
      for (const header of configured) {
        if (typeof header !== 'string') continue;
        const normalized = header.trim().toLowerCase();
        if (!normalized) continue;
        merged.add(normalized);
      }
    }
    this.allowedSubRequestHeaders = merged;
    return merged;
  }

  private buildHeadersForRequest(
    request: BatchRequest,
    parentRequest?: Request,
  ): Record<string, string> {
    const merged: Record<string, string> = {};
    const parentHeaders = parentRequest?.headers ?? {};

    for (const [key, value] of Object.entries(parentHeaders)) {
      if (value == null) continue;
      const normalized = key.toLowerCase();
      if (normalized === ODATA_BATCH_DEPTH_HEADER) continue;
      if (Array.isArray(value)) {
        merged[normalized] = value
          .filter((v) => v != null)
          .map((v) => String(v))
          .join(',');
      } else {
        merged[normalized] = String(value);
      }
    }

    const allowedOverrides = this.resolveAllowedSubRequestHeaders();
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (value == null) continue;
      const normalized = key.toLowerCase();
      if (normalized === 'host' || normalized === ODATA_BATCH_DEPTH_HEADER) continue;
      if (!allowedOverrides.has(normalized)) continue;
      merged[normalized] = String(value);
    }

    // Drop hop-by-hop and forbidden headers for sub-requests
    const forbidden = new Set([
      'connection',
      'content-length',
      'transfer-encoding',
      'proxy-connection',
      'keep-alive',
      'upgrade',
      'te',
      'trailer',
      'content-transfer-encoding',
      ODATA_BATCH_DEPTH_HEADER,
    ]);
    for (const name of Object.keys(merged)) {
      if (forbidden.has(name)) delete merged[name];
    }

    const correlationCfg = this.cfg?.correlation;
    if (correlationCfg?.enabled !== false) {
      const headerName = (correlationCfg?.headerName ?? 'x-correlation-id').toLowerCase();
      const correlationId = this.getRequestState()?.correlationId;
      if (correlationId) {
        merged[headerName] = correlationId;
      }
    }

    return merged;
  }

  private resolveParentProtocolState(parentRequest?: Request): {
    protocol: string;
    secure: boolean;
  } {
    const fallback = { protocol: 'http', secure: false };
    if (!parentRequest) return fallback;
    const effective = this.getParentEffectiveProtocol(parentRequest);
    if (effective === 'https') {
      return { protocol: 'https', secure: true };
    }
    if (effective === 'http') {
      return { protocol: 'http', secure: false };
    }
    const rawProtocol =
      typeof parentRequest.protocol === 'string' && parentRequest.protocol.trim().length
        ? parentRequest.protocol.trim().toLowerCase()
        : undefined;
    const parentSecure =
      ((parentRequest as AnyObject)?.secure === true ||
        Boolean(
          (parentRequest as AnyObject)?.connection?.encrypted ??
            (parentRequest as AnyObject)?.socket?.encrypted,
        )) ??
      false;
    if (rawProtocol === 'https') {
      return { protocol: 'https', secure: true };
    }
    if (parentSecure) {
      return { protocol: 'https', secure: true };
    }
    if (rawProtocol === 'http') {
      return { protocol: 'http', secure: false };
    }
    if (rawProtocol) {
      return { protocol: rawProtocol, secure: false };
    }
    return fallback;
  }

  private getParentEffectiveProtocol(parentRequest: Request): 'http' | 'https' | undefined {
    const trustProxy = this.shouldTrustProxyHeaders(parentRequest);
    if (trustProxy) {
      const forwarded = this.parseForwardedHeader(parentRequest);
      const forwardedProto = this.normalizeProtocol(forwarded?.proto);
      if (forwardedProto) return forwardedProto;
      const headerProto = this.normalizeProtocol(
        this.getCommaSeparatedHeaderValue(this.getParentHeader(parentRequest, 'x-forwarded-proto')),
      );
      if (headerProto) return headerProto;
    }
    const normalized = this.normalizeProtocol(
      typeof parentRequest.protocol === 'string' ? parentRequest.protocol : undefined,
    );
    if (normalized) return normalized;
    return undefined;
  }

  private shouldTrustProxyHeaders(parentRequest?: Request): boolean {
    const configured = this.cfg?.trustProxyHeaders;
    if (configured === true) return true;
    if (configured === false) return false;
    if (!this.getTrustedProxyRanges().length) return false;
    return this.isTrustedRemoteAddress(this.getRemoteAddress(parentRequest));
  }

  private getTrustedProxyRanges(): Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> {
    if (this._trustedProxyRanges) return this._trustedProxyRanges;
    const configured = Array.isArray(this.cfg?.trustedProxySubnets)
      ? (this.cfg?.trustedProxySubnets ?? [])
      : [];
    const parsed: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [];
    for (const entry of configured) {
      const raw = entry?.trim();
      if (!raw) continue;
      try {
        const cidr = raw.includes('/') ? raw : raw.includes(':') ? `${raw}/128` : `${raw}/32`;
        const [addr, prefix] = ipaddr.parseCIDR(cidr);
        parsed.push([this.normalizeIpAddress(addr), prefix]);
      } catch {
        this.logger?.warn('Ignoring invalid trustedProxySubnets entry.', {
          event: 'invalid-trusted-proxy-subnet',
          subnet: raw,
        });
      }
    }
    this._trustedProxyRanges = parsed;
    return parsed;
  }

  private getRemoteAddress(parentRequest?: Request): string | undefined {
    if (!parentRequest) return undefined;
    const reqAny = parentRequest as AnyObject;
    const socket =
      reqAny?.socket ??
      reqAny?.connection ??
      (reqAny?.res && typeof reqAny.res === 'object'
        ? (reqAny.res as AnyObject).connection
        : undefined);
    const remote = socket?.remoteAddress;
    if (typeof remote === 'string' && remote.trim()) {
      return remote.trim();
    }
    return undefined;
  }

  private isTrustedRemoteAddress(address: string | undefined): boolean {
    if (!address) return false;
    const ranges = this.getTrustedProxyRanges();
    if (!ranges.length) return false;
    try {
      const parsed = this.normalizeIpAddress(ipaddr.parse(address));
      return ranges.some((range) => this.matchIpAddress(parsed, range));
    } catch {
      return false;
    }
  }

  private normalizeIpAddress(addr: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
    if (addr.kind() === 'ipv6') {
      const ipv6 = addr as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) {
        return ipv6.toIPv4Address();
      }
    }
    return addr;
  }

  private matchIpAddress(
    candidate: ipaddr.IPv4 | ipaddr.IPv6,
    range: [ipaddr.IPv4 | ipaddr.IPv6, number],
  ): boolean {
    const [rangeAddr, prefix] = range;
    if (candidate.kind() === 'ipv4' && rangeAddr.kind() === 'ipv4') {
      return (candidate as ipaddr.IPv4).match([rangeAddr as ipaddr.IPv4, prefix]);
    }
    if (candidate.kind() === 'ipv6' && rangeAddr.kind() === 'ipv6') {
      return (candidate as ipaddr.IPv6).match([rangeAddr as ipaddr.IPv6, prefix]);
    }
    return false;
  }

  private getParentHeader(parentRequest: Request | undefined, name: string): string | undefined {
    if (!parentRequest || !name) return undefined;
    const getter = (parentRequest as AnyObject)?.get;
    if (typeof getter === 'function') {
      const value = getter.call(parentRequest, name);
      if (value != null) {
        return Array.isArray(value) ? String(value[0]) : String(value);
      }
    }
    const headers = (parentRequest as AnyObject)?.headers ?? {};
    const target = name.toLowerCase();
    for (const [key, rawValue] of Object.entries(headers)) {
      if (key?.toLowerCase() !== target) continue;
      if (Array.isArray(rawValue)) {
        const value = rawValue[0];
        return value == null ? undefined : String(value);
      }
      if (rawValue == null) return undefined;
      return String(rawValue);
    }
    return undefined;
  }

  private getCommaSeparatedHeaderValue(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const first = value.split(',')[0]?.trim();
    if (!first) return undefined;
    return first;
  }

  private parseForwardedHeader(
    parentRequest?: Request,
  ): { host?: string; proto?: string } | undefined {
    if (!parentRequest) return undefined;
    const header = this.getParentHeader(parentRequest, 'forwarded');
    if (!header) return undefined;
    const firstEntry = header.split(',')[0];
    if (!firstEntry) return undefined;
    const directives = firstEntry.split(';');
    const result: { host?: string; proto?: string } = {};
    for (const directive of directives) {
      const [rawKey, rawValue] = directive.split('=');
      if (!rawKey || !rawValue) continue;
      const key = rawKey.trim().toLowerCase();
      if (!key) continue;
      let value = rawValue.trim();
      if (!value) continue;
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1);
      }
      if (key === 'host' && !result.host) {
        result.host = value;
      } else if (key === 'proto' && !result.proto) {
        result.proto = value;
      }
    }
    if (!result.host && !result.proto) {
      return undefined;
    }
    return result;
  }

  private normalizeProtocol(value: string | undefined): 'http' | 'https' | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const normalized = trimmed.replace(/:$/, '').toLowerCase();
    if (normalized === 'http' || normalized === 'https') return normalized;
    return undefined;
  }

  private decodeBufferedBody(bodyBuffer: Buffer, headers?: Record<string, string>): unknown {
    if (!bodyBuffer.length) return undefined;
    const contentType = this.getHeaderCaseInsensitive(headers, 'content-type');
    if (this.isJsonContentType(contentType)) {
      const text = bodyBuffer.toString('utf-8');
      try {
        return text ? JSON.parse(text) : undefined;
      } catch {
        return text;
      }
    }
    if (this.isTextContentType(contentType)) {
      return bodyBuffer.toString('utf-8');
    }
    return bodyBuffer;
  }

  private isJsonContentType(contentType?: string): boolean {
    const normalized = this.normalizeContentType(contentType);
    if (!normalized) return false;
    return normalized === 'application/json' || normalized.endsWith('+json');
  }

  private isTextContentType(contentType?: string): boolean {
    const normalized = this.normalizeContentType(contentType);
    if (!normalized) return false;
    if (normalized.startsWith('text/')) return true;
    if (normalized.endsWith('+xml')) return true;
    return TEXT_LIKE_MIME_TYPES.has(normalized);
  }

  private normalizeContentType(value?: string): string | undefined {
    if (!value) return undefined;
    const [type] = value.split(';', 1);
    const normalized = type?.trim().toLowerCase();
    return normalized || undefined;
  }

  private normalizeJsonBatchResponses(responses: BatchResponseEntry[]): BatchResponseEntry[] {
    return responses.map((entry) => {
      if (!Buffer.isBuffer(entry.body)) return entry;
      const headers = {
        ...(this.sanitizeHeadersForJsonBatchBody(entry.headers) ?? entry.headers ?? {}),
      };
      const contentType =
        this.getHeaderCaseInsensitive(headers, 'content-type') ?? 'application/octet-stream';
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-type') {
          delete headers[key];
        }
      }
      headers['Content-Type'] = contentType;
      headers['Content-Transfer-Encoding'] = 'base64';
      return {
        ...entry,
        headers,
        body: entry.body.toString('base64'),
      };
    });
  }

  private createResponseSizeTracker(
    isMultipart: boolean,
    limits: NormalizedBatchLimits,
  ): ResponseSizeTracker {
    return {
      isMultipart,
      limit: limits.maxResponsePayloadBytes,
      bufferedBytes: 0,
      serializedBytes: 0,
      responsesCount: 0,
      activeChangesetId: undefined,
    };
  }

  private trackResponseSize(tracker: ResponseSizeTracker, entry: BatchResponseEntry): void {
    tracker.responsesCount += 1;
    if (!tracker.limit || tracker.limit <= 0) {
      if (!tracker.isMultipart) {
        return;
      }
      if (!entry.atomicityGroup && tracker.activeChangesetId) {
        tracker.activeChangesetId = undefined;
      } else if (entry.atomicityGroup) {
        tracker.activeChangesetId = entry.atomicityGroup;
      }
      return;
    }

    let serializedIncrement = 0;
    if (tracker.isMultipart) {
      serializedIncrement += this.prepareMultipartTrackerState(tracker, entry);
      serializedIncrement += entry.atomicityGroup
        ? this.estimateChangesetEntryBytes(entry)
        : this.estimateMultipartSingleEntryBytes(entry);
    } else {
      serializedIncrement += this.estimateJsonResponseBytes(entry);
    }

    const bufferedIncrement = this.estimateBufferedResponseBytes(entry);
    tracker.bufferedBytes += bufferedIncrement;
    tracker.serializedBytes += serializedIncrement;
    this.enforceResponsePayloadLimit(tracker, entry.id);
  }

  private finalizeResponseSizeTracker(tracker: ResponseSizeTracker): void {
    if (!tracker.limit || tracker.limit <= 0) {
      return;
    }
    if (tracker.isMultipart) {
      if (tracker.activeChangesetId) {
        tracker.serializedBytes += this.estimateChangesetClosingBytes();
        tracker.activeChangesetId = undefined;
      }
      tracker.serializedBytes += this.estimateBatchClosingBytes();
    } else {
      tracker.serializedBytes += this.estimateJsonEnvelopeBytes(tracker.responsesCount);
    }
    this.enforceResponsePayloadLimit(tracker);
  }

  private prepareMultipartTrackerState(
    tracker: ResponseSizeTracker,
    entry: BatchResponseEntry,
  ): number {
    let addition = 0;
    if (entry.atomicityGroup) {
      if (tracker.activeChangesetId && tracker.activeChangesetId !== entry.atomicityGroup) {
        addition += this.estimateChangesetClosingBytes();
        tracker.activeChangesetId = undefined;
      }
      if (tracker.activeChangesetId !== entry.atomicityGroup) {
        addition += this.estimateChangesetStartBytes();
        tracker.activeChangesetId = entry.atomicityGroup;
      }
    } else if (tracker.activeChangesetId) {
      addition += this.estimateChangesetClosingBytes();
      tracker.activeChangesetId = undefined;
    }
    return addition;
  }

  private enforceResponsePayloadLimit(tracker: ResponseSizeTracker, requestId?: string): void {
    if (!tracker.limit || tracker.limit <= 0) return;
    const projected = tracker.bufferedBytes + tracker.serializedBytes;
    if (projected <= tracker.limit) return;
    this.warn('Batch responses exceeded the configured aggregate size limit.', {
      limitBytes: tracker.limit,
      bufferedBytes: tracker.bufferedBytes,
      serializedBytes: tracker.serializedBytes,
      requestId,
    });
    throw new HttpErrors.PayloadTooLarge('Batch responses exceeded the configured size limit.');
  }

  private estimateBufferedResponseBytes(entry: BatchResponseEntry): number {
    const body = entry.body;
    if (body === undefined || body === null) return 0;
    if (Buffer.isBuffer(body)) return body.length;
    if (typeof body === 'string') return Buffer.byteLength(body);
    try {
      return Buffer.byteLength(JSON.stringify(body));
    } catch {
      return Buffer.byteLength(String(body));
    }
  }

  private estimateJsonResponseBytes(entry: BatchResponseEntry): number {
    try {
      const normalized = this.normalizeJsonBatchResponses([entry])[0] ?? entry;
      return Buffer.byteLength(JSON.stringify(normalized));
    } catch {
      return Buffer.byteLength('{}');
    }
  }

  private estimateMultipartSingleEntryBytes(entry: BatchResponseEntry): number {
    const partHeaders = this.buildMultipartPartHeaders(entry);
    const prefix = `--${ESTIMATED_BATCH_BOUNDARY}\r\n${partHeaders}\r\n\r\n`;
    const formatted = prefix.replace(/\\r\\n/g, '\r\n');
    const httpLength = this.estimateHttpResponseLength(entry);
    return Buffer.byteLength(formatted, 'utf-8') + httpLength + Buffer.byteLength('\r\n');
  }

  private estimateChangesetStartBytes(): number {
    const header = `--${ESTIMATED_BATCH_BOUNDARY}\r\nContent-Type: multipart/mixed; boundary=${ESTIMATED_CHANGESET_BOUNDARY}\r\n\r\n`;
    return Buffer.byteLength(header.replace(/\\r\\n/g, '\r\n'), 'utf-8');
  }

  private estimateChangesetEntryBytes(entry: BatchResponseEntry): number {
    const partHeaders = this.buildMultipartPartHeaders(entry);
    const prefix = `--${ESTIMATED_CHANGESET_BOUNDARY}\r\n${partHeaders}\r\n\r\n`;
    const formatted = prefix.replace(/\\r\\n/g, '\r\n');
    const httpLength = this.estimateHttpResponseLength(entry);
    return Buffer.byteLength(formatted, 'utf-8') + httpLength + Buffer.byteLength('\r\n');
  }

  private estimateChangesetClosingBytes(): number {
    return Buffer.byteLength(
      `--${ESTIMATED_CHANGESET_BOUNDARY}--\r\n`.replace(/\\r\\n/g, '\r\n'),
      'utf-8',
    );
  }

  private estimateBatchClosingBytes(): number {
    return Buffer.byteLength(
      `--${ESTIMATED_BATCH_BOUNDARY}--\r\n`.replace(/\\r\\n/g, '\r\n'),
      'utf-8',
    );
  }

  private estimateJsonEnvelopeBytes(count: number): number {
    const base = Buffer.byteLength('{"responses":', 'utf-8') + Buffer.byteLength('}', 'utf-8');
    if (count <= 0) {
      return base + Buffer.byteLength('[]', 'utf-8');
    }
    const brackets = Buffer.byteLength('[', 'utf-8') + Buffer.byteLength(']', 'utf-8');
    const commas = count > 1 ? count - 1 : 0;
    return base + brackets + commas;
  }

  private buildMultipartPartHeaders(entry: BatchResponseEntry): string {
    const lines: string[] = [];
    if (entry.id) {
      lines.push(`Content-ID: ${entry.id}`);
    }
    lines.push('Content-Type: application/http');
    lines.push('Content-Transfer-Encoding: binary');
    return lines.join('\r\n');
  }

  private estimateHttpResponseLength(entry: BatchResponseEntry): number {
    const reason = STATUS_CODES[entry.status] ?? '';
    const headers = this.normalizeHeadersForLength(entry.headers ?? {});
    const bodyLength = this.estimateSerializedBodyLength(entry.body, headers);
    if (bodyLength > 0 && !headers['content-length']) {
      headers['content-length'] = bodyLength.toString();
    }
    const headerLines = Object.entries(headers).map(
      ([key, value]) => `${this.formatHeaderNameForLength(key)}: ${value}`,
    );
    let responseHead = `HTTP/1.1 ${entry.status} ${reason}`;
    if (headerLines.length) {
      responseHead += `\r\n${headerLines.join('\r\n')}`;
    }
    responseHead += '\r\n\r\n';
    return Buffer.byteLength(responseHead, 'utf-8') + bodyLength;
  }

  private normalizeHeadersForLength(headers: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value == null) continue;
      normalized[key.toLowerCase()] = value;
    }
    return normalized;
  }

  private estimateSerializedBodyLength(body: unknown, headers: Record<string, string>): number {
    if (body === undefined || body === null) return 0;
    if (Buffer.isBuffer(body)) return body.length;
    if (typeof body === 'string') {
      return Buffer.byteLength(body);
    }
    if (typeof body === 'number' || typeof body === 'boolean' || typeof body === 'object') {
      if (!headers['content-type']) {
        headers['content-type'] = 'application/json; charset=utf-8';
      }
      try {
        return Buffer.byteLength(JSON.stringify(body));
      } catch {
        return Buffer.byteLength(String(body));
      }
    }
    return Buffer.byteLength(String(body));
  }

  private formatHeaderNameForLength(name: string): string {
    return name
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('-');
  }

  private resolveRequestBodyBuffer(request: BatchRequest): Buffer {
    if (request.rawBody) {
      return request.rawBody;
    }
    if (request.body === undefined) {
      return Buffer.alloc(0);
    }
    if (typeof request.body === 'string') {
      return Buffer.from(request.body);
    }
    return Buffer.from(JSON.stringify(request.body));
  }

  private shouldDefaultJsonContentType(request: BatchRequest): boolean {
    return !request.rawBody && request.body !== undefined && typeof request.body !== 'string';
  }

  private getBatchDepth(req?: Request | IncomingMessage): number {
    const stateDepth = this.getRequestState()?.batchDepth;
    if (typeof stateDepth === 'number' && Number.isFinite(stateDepth) && stateDepth >= 0) {
      return Math.floor(stateDepth);
    }
    const extract = (carrier: unknown): number | undefined => {
      if (!carrier || typeof carrier !== 'object') return undefined;
      const record = carrier as BatchDepthCarrier;
      const depth =
        record?.[ODATA_BATCH_DEPTH] ??
        (record && typeof (record as AnyObject)[ODATA_BATCH_DEPTH_PROP] === 'number'
          ? (record as AnyObject)[ODATA_BATCH_DEPTH_PROP]
          : undefined);
      if (typeof depth === 'number' && Number.isFinite(depth) && depth >= 0) {
        return depth;
      }
      return undefined;
    };
    const candidates: Array<unknown> = [
      req,
      (req as AnyObject | undefined)?.res,
      (req as AnyObject | undefined)?.res?.req,
      (req as AnyObject | undefined)?.socket,
      (req as AnyObject | undefined)?.connection,
    ];
    for (const candidate of candidates) {
      const depth = extract(candidate);
      if (depth !== undefined) return depth;
    }
    const headerValue = this.getBatchDepthHeader(req);
    if (headerValue !== undefined) return headerValue;
    return 0;
  }

  private setBatchDepth(req: Request | IncomingMessage, depth: number) {
    const assign = (carrier: unknown) => {
      if (!carrier || typeof carrier !== 'object') return;
      (carrier as BatchDepthCarrier)[ODATA_BATCH_DEPTH] = depth;
      (carrier as AnyObject)[ODATA_BATCH_DEPTH_PROP] = depth;
    };
    assign(req);
    const response = (req as AnyObject | undefined)?.res;
    assign(response);
    assign(response?.req);
    assign((req as AnyObject | undefined)?.socket);
    assign((req as AnyObject | undefined)?.connection);
    const headers = ((req as AnyObject).headers ??= {});
    headers[ODATA_BATCH_DEPTH_HEADER] = String(depth);
  }

  private enforceBatchDepthLimit(depth: number, limits: NormalizedBatchLimits) {
    const maxDepth = limits.maxDepth;
    if (maxDepth && maxDepth > 0 && depth >= maxDepth) {
      this.warn('Batch request exceeded configured nesting depth.', {
        depth,
        maxDepth,
      });
      const err = new HttpErrors.BadRequest('Batch request exceeds the configured nesting depth.');
      (err as AnyObject).code = ODataErrorCodes.BatchDepthLimitExceeded;
      throw err;
    }
  }

  private getBatchDepthHeader(req?: Request | IncomingMessage): number | undefined {
    if (!req) return undefined;
    const headers = (req as AnyObject)?.headers;
    if (!headers) return undefined;
    const raw = headers[ODATA_BATCH_DEPTH_HEADER];
    if (raw == null) return undefined;
    const first = Array.isArray(raw) ? raw[0] : raw;
    const parsed = Number(first);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return Math.floor(parsed);
  }

  private isBatchValidationError(error: unknown): boolean {
    if (error instanceof HttpErrors.HttpError) {
      const candidate = error as { statusCode?: number; status?: number };
      const status = candidate.statusCode ?? candidate.status;
      return typeof status === 'number' && status >= 400 && status < 500;
    }
    return false;
  }

  private resolveErrorStatus(error: unknown, fallback: number): number {
    if (typeof error === 'object' && error !== null) {
      const withStatus = error as { statusCode?: number; status?: number };
      const status = withStatus.statusCode ?? withStatus.status;
      if (typeof status === 'number' && !Number.isNaN(status)) return status;
    }
    return fallback;
  }

  private isRedirectStatus(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status);
  }

  private odataError(code: string, message: string) {
    return {
      error: {
        code,
        message,
      },
    };
  }
}

function isReadable(value: unknown): value is Readable {
  return !!value && typeof (value as Readable).pipe === 'function';
}

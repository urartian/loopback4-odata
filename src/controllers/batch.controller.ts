import {Application, CoreBindings, inject} from '@loopback/core';
import {post, requestBody, Response, RestBindings, HttpErrors} from '@loopback/rest';
import {HttpHandler} from '@loopback/rest/dist/http-handler';
import {IncomingMessage, ServerResponse} from 'http';
import {PassThrough} from 'stream';
import {IsolationLevel, Transaction} from '@loopback/repository';
import {ODATA_BINDINGS} from '../keys';
import {EntitySetRegistry} from '../registry/entityset-registry';
import {ODATA_ATOMICITY_STATE} from '../constants';
import {AtomicityRequestState} from '../types/batch';

interface BatchRequest {
  id: string;
  atomicityGroup?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface BatchPayload {
  requests: BatchRequest[];
}

interface BatchResponseEntry {
  id?: string;
  atomicityGroup?: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface BatchResponsePayload {
  responses: BatchResponseEntry[];
}

class AtomicityGroupContext {
  private readonly requestState: AtomicityRequestState;
  private readonly transactions: Transaction[];
  private settled = false;
  private rolledBack = false;

  constructor(
    public readonly id: string,
    private readonly transactionsBySet: Map<string, Transaction>,
  ) {
    const unique = new Set<Transaction>();
    for (const tx of transactionsBySet.values()) unique.add(tx);
    this.transactions = Array.from(unique.values());
    this.requestState = {
      groupId: id,
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
      const aggregate = new Error(errors.map(e => e.message ?? String(e)).join('; '));
      (aggregate as any).cause = errors[0];
      throw aggregate;
    }
  }
}

export class ODataBatchController {
  constructor(
    @inject(RestBindings.HANDLER)
    private readonly httpHandler: HttpHandler,
    @inject(RestBindings.URL)
    private readonly serverUrl: string,
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly app: Application,
    @inject(ODATA_BINDINGS.ENTITY_SET_REGISTRY)
    private readonly registry: EntitySetRegistry,
  ) {}

  @post('/odata/$batch', {
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
                      id: {type: 'string'},
                      atomicityGroup: {type: 'string'},
                      status: {type: 'integer'},
                      headers: {
                        type: 'object',
                        additionalProperties: {type: 'string'},
                      },
                      body: {type: 'object'},
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
  })
  async handleBatch(
    @requestBody({
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['requests'],
            properties: {
              requests: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'method', 'url'],
                  properties: {
                    id: {type: 'string'},
                    method: {type: 'string'},
                    url: {type: 'string'},
                    headers: {
                      type: 'object',
                      additionalProperties: {type: 'string'},
                    },
                    body: {},
                    atomicityGroup: {type: 'string'},
                  },
                },
              },
            },
          },
        },
      },
    })
    payload: BatchPayload,
    @inject(RestBindings.Http.RESPONSE) response: Response,
  ): Promise<BatchResponsePayload> {
    const requests = payload?.requests;
    if (!Array.isArray(requests) || !requests.length) {
      throw new HttpErrors.BadRequest('Batch payload must contain at least one request.');
    }

    const grouped = this.groupByAtomicity(requests);
    const responses: BatchResponseEntry[] = [];

    for (const group of grouped) {
      if (group.atomicityGroup) {
        try {
          const {entries, failure} = await this.executeAtomicGroup(group.requests, group.atomicityGroup);
          if (failure) {
            responses.push({
              atomicityGroup: group.atomicityGroup,
              id: failure.id,
              status: failure.status,
              headers: failure.headers,
              body: failure.body,
            });
          } else if (entries?.length) {
            responses.push(
              ...entries.map(entry => ({
                ...entry,
                atomicityGroup: group.atomicityGroup,
              })),
            );
          }
        } catch (error) {
          const status = this.resolveErrorStatus(error, 500);
          responses.push({
            atomicityGroup: group.atomicityGroup,
            status,
            body: this.odataError(
              'BatchExecutionError',
              (error as Error).message ?? 'Failed to execute atomicity group.',
            ),
          });
        }
      } else {
        const entries = await this.executeGroup(group.requests);
        responses.push(...entries);
      }
    }

    response.contentType('application/json');
    response.set('OData-Version', '4.01');
    return {responses};
  }

  private groupByAtomicity(requests: BatchRequest[]) {
    const result: Array<{atomicityGroup?: string; requests: BatchRequest[]}> = [];
    const handled = new Set<string>();

    for (const req of requests) {
      if (req.atomicityGroup) {
        if (handled.has(req.atomicityGroup)) continue;
        const groupRequests = requests.filter(r => r.atomicityGroup === req.atomicityGroup);
        handled.add(req.atomicityGroup);
        result.push({atomicityGroup: req.atomicityGroup, requests: groupRequests});
      } else {
        result.push({requests: [req]});
      }
    }

    return result;
  }

  private async executeGroup(
    requests: BatchRequest[],
    context?: AtomicityGroupContext,
  ): Promise<BatchResponseEntry[]> {
    const entries: BatchResponseEntry[] = [];
    for (const request of requests) {
      const entry = await this.executeSingle(request, context);
      entries.push(entry);
      if (entry.status >= 400) break;
    }
    return entries;
  }

  private async executeAtomicGroup(
    requests: BatchRequest[],
    groupId: string,
  ): Promise<{entries?: BatchResponseEntry[]; failure?: BatchResponseEntry}> {
    const context = await this.createAtomicGroupContext(groupId, requests);
    try {
      const entries = await this.executeGroup(requests, context);
      const failed = entries.find(entry => entry.status >= 400);
      if (failed) {
        await context.rollback();
        return {failure: failed};
      }
      await context.commit();
      return {entries};
    } catch (error) {
      await context.rollback();
      throw error;
    }
  }

  private async createAtomicGroupContext(
    groupId: string,
    requests: BatchRequest[],
  ): Promise<AtomicityGroupContext> {
    const setNames = new Set<string>();
    for (const request of requests) {
      const setName = this.resolveEntitySetName(request.url);
      if (setName) setNames.add(setName);
    }

    const transactionsBySet = new Map<string, Transaction>();
    const transactionsByDataSource = new Map<string, Transaction>();
    const startedTransactions: Transaction[] = [];

    try {
      for (const setName of setNames) {
        const def = this.registry.findByName(setName);
        if (!def) continue;
        if (!def.repositoryBindingKey) {
          throw new HttpErrors.InternalServerError(
            `Entity set ${def.name} is missing a repository binding and cannot participate in transactions.`,
          );
        }

        const repository = await this.app.get(def.repositoryBindingKey);
        const dataSource = (repository as {dataSource?: {beginTransaction?: Function; name?: string}}).dataSource;
        if (!dataSource || typeof dataSource.beginTransaction !== 'function') {
          throw new HttpErrors.NotImplemented(
            `Repository for entity set ${def.name} does not support transactions required for atomicity group ${groupId}.`,
          );
        }

        const dsKey = dataSource.name ?? def.repositoryBindingKey;
        let tx = transactionsByDataSource.get(dsKey);
        if (!tx) {
          tx = await this.beginTransactionForDataSource(
            dataSource as {
              beginTransaction: (options: IsolationLevel) => Promise<Transaction>;
              name?: string;
            },
          );
          transactionsByDataSource.set(dsKey, tx);
          startedTransactions.push(tx);
        }
        transactionsBySet.set(def.name, tx);
      }
    } catch (error) {
      for (const tx of startedTransactions) {
        try {
          await tx.rollback();
        } catch {
          /* no-op */
        }
      }
      throw error;
    }

    return new AtomicityGroupContext(groupId, transactionsBySet);
  }

  private resolveEntitySetName(rawUrl: string): string | undefined {
    const sanitized = this.sanitizeUrl(rawUrl);
    if (!sanitized) return undefined;
    const [path] = sanitized.split('?');
    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return undefined;
    if (segments[0].toLowerCase() !== 'odata') return undefined;
    const candidate = segments[1];
    if (!candidate || candidate.startsWith('$')) return undefined;
    const normalized = candidate.includes('(')
      ? candidate.slice(0, candidate.indexOf('('))
      : candidate;
    return normalized;
  }

  private async beginTransactionForDataSource(dataSource: {
    beginTransaction: (options: IsolationLevel) => Promise<Transaction>;
    name?: string;
  }): Promise<Transaction> {
    try {
      return await dataSource.beginTransaction(IsolationLevel.READ_COMMITTED);
    } catch (err) {
      throw new HttpErrors.NotImplemented(
        `Datasource ${dataSource.name ?? 'unknown'} cannot begin a transaction: ${(err as Error).message ?? 'unsupported connector'}.`,
      );
    }
  }

  private async executeWithHandler(
    request: BatchRequest,
    context: AtomicityGroupContext,
  ): Promise<BatchResponseEntry> {
    const url = this.sanitizeUrl(request.url);
    if (!url) {
      return {
        id: request.id,
        status: 400,
        body: this.odataError('InvalidUrl', `Invalid request URL: ${request.url}`),
      };
    }

    const method = request.method?.toUpperCase();
    if (!method) {
      return {
        id: request.id,
        status: 400,
        body: this.odataError('InvalidMethod', 'Batch request method is required.'),
      };
    }

    const bodyBuffer = request.body ? Buffer.from(JSON.stringify(request.body)) : Buffer.alloc(0);
    const socket = new PassThrough() as any;
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
    req.url = url;
    (req as any).headers = Object.fromEntries(
      Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    if (bodyBuffer.length && !(req as any).headers['content-type']) {
      (req as any).headers['content-type'] = 'application/json';
    }
    if (bodyBuffer.length) {
      (req as any).headers['content-length'] = String(bodyBuffer.length);
    }

    // minimal Express-style helpers used by LB4
    (req as any).get = (name: string) => {
      return (req as any).headers?.[String(name).toLowerCase()] as string | undefined;
    };
    (req as any).header = (name: string) => (req as any).get(name);
    (req as any).protocol = 'http';
    (req as any).baseUrl = '';
    (req as any).originalUrl = url;

    const res = new ServerResponse(req);
    res.assignSocket?.(socket);
    const chunks: Buffer[] = [];
    let resolved = false;

    const finishPromise = new Promise<BatchResponseEntry>((resolve, reject) => {
      const finalize = () => {
        if (resolved) return;
        resolved = true;
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        let body: unknown;
        try {
          body = bodyText ? JSON.parse(bodyText) : undefined;
        } catch {
          body = bodyText;
        }
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.getHeaders())) {
          if (typeof value === 'string') headers[key] = value;
          else if (Array.isArray(value)) headers[key] = value.join(',');
        }
        resolve({ id: request.id, status: res.statusCode, headers, body });
      };

      res.on('finish', finalize);
      res.on('close', finalize);
      res.on('error', reject);
    });

    const write = res.write.bind(res);
    res.write = function (chunk: any, ...args: any[]) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return write(chunk, ...args);
    } as any;

    const end = res.end.bind(res);
    res.end = function (chunk?: any, ...args: any[]) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return end(chunk, ...args);
    } as any;

    // Provide Express-style response helpers expected by LoopBack internals
    (res as any).status = (code: number) => { res.statusCode = code; return res; };
    (res as any).contentType = (type: string) => { res.setHeader('Content-Type', type); return res; };
    (res as any).type = (type: string) => { res.setHeader('Content-Type', type); return res; };
    (res as any).set = (field: string, value: string) => { res.setHeader(field, value); return res; };
    (res as any).header = (field: string, value: string) => { res.setHeader(field, value); return res; };
    (res as any).json = (body: unknown) => {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? null));
      res.end(payload);
      return res;
    };
    (res as any).send = (body: unknown) => {
      if (body === undefined || body === null) { res.end(); return res; }
      if (Buffer.isBuffer(body)) { res.end(body); return res; }
      if (typeof body === 'object') {
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
        return res;
      }
      res.end(String(body));
      return res;
    };

    context.applyTo(req);
    const handlerPromise = this.httpHandler.handleRequest(req as any, res as any);

    socket.end(bodyBuffer.length ? bodyBuffer : undefined);

    try {
      // Add per-request timeout to avoid hangs
      const TIMEOUT_MS = 30000;
      const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Batch sub-request timeout')), TIMEOUT_MS));
      await Promise.race([handlerPromise, timeoutPromise]);
      const result = await finishPromise;
      context.clearFrom(req);
      return result;
    } catch (error) {
      context.clearFrom(req);
      const status = (error && typeof error === 'object' && 'statusCode' in error
        ? (error as {statusCode?: number}).statusCode
        : undefined) ?? 500;
      const body = this.odataError('BatchExecutionError', (error as Error).message ?? 'Failed to execute request.');
      return {
        id: request.id,
        status,
        body,
      };
    }
  }

  private async executeViaFetch(request: BatchRequest): Promise<BatchResponseEntry> {
    const path = this.sanitizeUrl(request.url);
    if (!path) {
      return {id: request.id, status: 400, body: this.odataError('InvalidUrl', `Invalid request URL: ${request.url}`)};
    }
    const method = request.method?.toUpperCase();
    if (!method) {
      return {id: request.id, status: 400, body: this.odataError('InvalidMethod', 'Batch request method is required.')};
    }
    try {
      const target = new URL(path, this.serverUrl).toString();
      const headers: Record<string, string> = {...(request.headers ?? {})};
      let body: string | undefined;
      if (request.body !== undefined) {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        if (!headers['content-type'] && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
      const resp = await fetch(target, {method, headers, body} as any);
      const text = await resp.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      const outHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { outHeaders[k] = v; });
      return {id: request.id, status: resp.status, headers: outHeaders, body: parsed};
    } catch (err) {
      return {id: request.id, status: 500, body: this.odataError('BatchExecutionError', (err as Error).message ?? 'Failed to execute request.')};
    }
  }

  private async executeSingle(
    request: BatchRequest,
    context?: AtomicityGroupContext,
  ): Promise<BatchResponseEntry> {
    if (context) return this.executeWithHandler(request, context);
    return this.executeViaFetch(request);
  }

  private sanitizeUrl(rawUrl: string): string | undefined {
    if (!rawUrl) return undefined;
    if (/^https?:\/\//i.test(rawUrl)) {
      try {
        const parsed = new URL(rawUrl);
        return parsed.pathname + parsed.search;
      } catch {
        return undefined;
      }
    }
    if (!rawUrl.startsWith('/')) return undefined;
    return rawUrl;
  }

  private resolveErrorStatus(error: unknown, fallback: number): number {
    if (typeof error === 'object' && error !== null) {
      const withStatus = error as {statusCode?: number; status?: number};
      const status = withStatus.statusCode ?? withStatus.status;
      if (typeof status === 'number' && !Number.isNaN(status)) return status;
    }
    return fallback;
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

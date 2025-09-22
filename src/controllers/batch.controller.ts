import {inject} from '@loopback/core';
import {post, requestBody, Response, RestBindings, HttpErrors} from '@loopback/rest';
import {HttpHandler} from '@loopback/rest/dist/http-handler';
import {IncomingMessage, ServerResponse} from 'http';
import {PassThrough} from 'stream';

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

export class ODataBatchController {
  constructor(
    @inject(RestBindings.HANDLER)
    private readonly httpHandler: HttpHandler,
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
        const groupResponses = await this.executeGroup(group.requests);
        const failed = groupResponses.find(r => r.status >= 400);
        if (failed) {
          responses.push({
            atomicityGroup: group.atomicityGroup,
            id: failed.id,
            status: failed.status,
            body: failed.body,
          });
        } else {
          responses.push(
            ...groupResponses.map(entry => ({
              ...entry,
              atomicityGroup: group.atomicityGroup,
            })),
          );
        }
      } else {
        const entries = await this.executeGroup(group.requests);
        responses.push(...entries);
      }
    }

    response.contentType('application/json');
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

  private async executeGroup(requests: BatchRequest[]): Promise<BatchResponseEntry[]> {
    const entries: BatchResponseEntry[] = [];
    for (const request of requests) {
      const entry = await this.executeSingle(request);
      entries.push(entry);
      if (entry.status >= 400) break;
    }
    return entries;
  }

  private async executeSingle(request: BatchRequest): Promise<BatchResponseEntry> {
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
    const socket = new PassThrough();

    const req = new IncomingMessage(socket as any);
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

    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];

    const finishPromise = new Promise<BatchResponseEntry>((resolve, reject) => {
      res.on('finish', () => {
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

        resolve({
          id: request.id,
          status: res.statusCode,
          headers,
          body,
        });
      });

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

    const handlerPromise = this.httpHandler.handleRequest(req as any, res as any);

    socket.end(bodyBuffer.length ? bodyBuffer : undefined);

    try {
      await handlerPromise;
      return await finishPromise;
    } catch (error) {
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
    return rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
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

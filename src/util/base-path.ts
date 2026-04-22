import type { Request } from '@loopback/rest';

export type RequestLike =
  | Pick<Request, 'url' | 'originalUrl' | 'baseUrl'>
  | {
      url?: string;
      originalUrl?: string;
      baseUrl?: string;
    };

export interface ODataRootRouteLike {
  name?: string;
  exposeEntitySet?: boolean;
  singleton?: { name?: string };
  actions?: Array<{ name?: string; binding?: string }>;
  functions?: Array<{ name?: string; binding?: string }>;
}

const ROOT_SYSTEM_SEGMENTS = new Set(['$metadata', '$batch']);

export function normalizeBasePath(configured?: string): string {
  let basePath = configured?.trim() ?? '';
  if (!basePath) return '/odata';
  if (!basePath.startsWith('/')) basePath = `/${basePath}`;
  if (basePath.length > 1 && basePath.endsWith('/')) {
    basePath = basePath.slice(0, -1);
  }
  return basePath || '/';
}

export function pathMatches(path: string, base: string): boolean {
  if (!path || !base) return false;
  if (base === '/') {
    return path === '/' || path.startsWith('/?') || path.startsWith('/#');
  }
  if (path === base) return true;
  if (path.startsWith(`${base}/`)) return true;
  if (path.startsWith(`${base}?`)) return true;
  if (path.startsWith(`${base}#`)) return true;
  return false;
}

export function buildODataRootRouteNames(definitions: ReadonlyArray<ODataRootRouteLike>): Set<string> {
  const names = new Set<string>();

  for (const definition of definitions) {
    if (definition.exposeEntitySet !== false && definition.name) {
      names.add(definition.name);
    }
    if (definition.singleton?.name) {
      names.add(definition.singleton.name);
    }
    for (const operation of definition.actions ?? []) {
      if (operation.binding === 'unbound' && operation.name) {
        names.add(operation.name);
      }
    }
    for (const operation of definition.functions ?? []) {
      if (operation.binding === 'unbound' && operation.name) {
        names.add(operation.name);
      }
    }
  }

  return names;
}

export function matchesConfiguredODataPath(
  path: string,
  basePath: string,
  rootRouteNames?: ReadonlySet<string>,
): boolean {
  if (!path || !basePath) return false;
  if (basePath !== '/') {
    return pathMatches(path, basePath);
  }

  const normalized = normalizePathForMatching(path);
  if (!normalized.startsWith('/')) return false;
  if (normalized === '/') return true;

  const firstSegment = extractFirstPathSegment(normalized);
  if (!firstSegment) return true;
  if (ROOT_SYSTEM_SEGMENTS.has(firstSegment)) return true;

  const routeName = normalizeFirstSegment(firstSegment);
  return Boolean(routeName && rootRouteNames?.has(routeName));
}

export function gatherRequestUrls(req: RequestLike): string[] {
  const urls: string[] = [];
  const push = (value: string | undefined) => {
    if (!value || typeof value !== 'string') return;
    if (!value.startsWith('/')) {
      urls.push(`/${value}`);
    } else {
      urls.push(value);
    }
  };

  if (req.url) push(req.url);

  if (req.baseUrl && req.url) {
    let combined: string;
    const base = req.baseUrl.endsWith('/') ? req.baseUrl.slice(0, -1) : req.baseUrl;
    if (req.url === '/') {
      combined = base || '/';
    } else {
      combined = `${base}${req.url.startsWith('/') ? '' : '/'}${req.url}`;
    }
    push(combined);
  }

  if (req.originalUrl) push(req.originalUrl);

  return Array.from(new Set(urls));
}

export function findMatchingRequestUrl(
  req: RequestLike,
  basePath: string,
  rootRouteNames?: ReadonlySet<string>,
): string | undefined {
  if (!basePath) return undefined;
  const urls = gatherRequestUrls(req);
  for (const url of urls) {
    if (matchesConfiguredODataPath(url, basePath, rootRouteNames)) {
      return url;
    }
  }
  return undefined;
}

export function stripBasePath(url: string, basePath: string): string {
  if (basePath === '/') {
    const remainder = url.slice(1);
    if (!remainder) return '';
    if (remainder.startsWith('?') || remainder.startsWith('#')) {
      return remainder;
    }
    return `/${remainder}`;
  }
  const remainder = url.substring(basePath.length);
  return remainder || '/';
}

function normalizePathForMatching(path: string): string {
  const trimmed = path.trim();
  const hashIndex = trimmed.indexOf('#');
  const withoutHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const queryIndex = withoutHash.indexOf('?');
  return queryIndex >= 0 ? withoutHash.slice(0, queryIndex) || '/' : withoutHash || '/';
}

function extractFirstPathSegment(path: string): string | undefined {
  const normalized = normalizePathForMatching(path);
  if (!normalized.startsWith('/')) return undefined;
  const remainder = normalized.slice(1);
  if (!remainder) return '';
  return remainder.split('/')[0] ?? '';
}

function normalizeFirstSegment(segment: string): string {
  const openParen = segment.indexOf('(');
  return openParen > 0 ? segment.slice(0, openParen) : segment;
}

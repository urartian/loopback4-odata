import type { Request } from '@loopback/rest';

export type RequestLike =
  | Pick<Request, 'url' | 'originalUrl' | 'baseUrl'>
  | {
      url?: string;
      originalUrl?: string;
      baseUrl?: string;
    };

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
    return path.startsWith('/');
  }
  if (path === base) return true;
  if (path.startsWith(`${base}/`)) return true;
  if (path.startsWith(`${base}?`)) return true;
  if (path.startsWith(`${base}#`)) return true;
  return false;
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

export function findMatchingRequestUrl(req: RequestLike, basePath: string): string | undefined {
  if (!basePath) return undefined;
  const urls = gatherRequestUrls(req);
  for (const url of urls) {
    if (pathMatches(url, basePath)) {
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

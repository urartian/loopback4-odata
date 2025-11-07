import { Middleware, MiddlewareContext } from '@loopback/rest';

const KEY_PREFIX_REGEX = /^(?:[A-Za-z_][A-Za-z0-9_.]*)'/;
export const MAX_KEY_EXPRESSION_LENGTH = 4096;

export const odataPathRewriter: Middleware = (ctx: MiddlewareContext, next) => {
  const originalUrl = ctx.request.url ?? '';
  const normalizedUrl = rewriteUrl(originalUrl);
  ctx.request.url = normalizedUrl;
  return next();
};

function rewriteUrl(url: string): string {
  const { path, suffix } = splitUrl(url);
  const rewrittenPath = rewritePath(path);
  if (!suffix) return rewrittenPath;
  return rewrittenPath + suffix;
}

function splitUrl(url: string): { path: string; suffix: string } {
  const queryIndex = url.indexOf('?');
  const hashIndex = url.indexOf('#');
  let cut = -1;
  if (queryIndex !== -1 && hashIndex !== -1) {
    cut = Math.min(queryIndex, hashIndex);
  } else if (queryIndex !== -1) {
    cut = queryIndex;
  } else if (hashIndex !== -1) {
    cut = hashIndex;
  }
  if (cut === -1) {
    return { path: url, suffix: '' };
  }
  return {
    path: url.slice(0, cut),
    suffix: url.slice(cut),
  };
}

function rewritePath(path: string): string {
  if (!path.includes('(')) return path;

  let result = '';
  let index = 0;

  while (index < path.length) {
    const openIndex = path.indexOf('(', index);
    if (openIndex === -1) {
      result += path.slice(index);
      break;
    }

    const keySegment = extractKeySegment(path, openIndex);
    if (!keySegment) {
      result += path.slice(index, openIndex + 1);
      index = openIndex + 1;
      continue;
    }

    const { keyExpression, closeIndex } = keySegment;
    const normalizedKey = normalizeKeyExpression(keyExpression);

    // Slight guard: if normalization fails, keep original substring
    if (normalizedKey == null) {
      result += path.slice(index, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }

    const encodedKey = encodeURIComponent(normalizedKey).replace(/'/g, '%27');

    // Append everything up to the opening parenthesis, then the rewritten key.
    result += path.slice(index, openIndex);
    result += `/${encodedKey}`;
    index = closeIndex + 1;
  }

  return result;
}

interface KeySegmentParseResult {
  keyExpression: string;
  closeIndex: number;
}

function extractKeySegment(path: string, openIndex: number): KeySegmentParseResult | undefined {
  if (openIndex <= 0) return undefined;

  const preceding = path[openIndex - 1];
  if (preceding === '/') {
    // `(…)` immediately after a slash is expected for entity keys
  } else if (preceding === ')') {
    // Navigating from a previous key segment, allow continuation
  } else if (preceding && !isSegmentChar(preceding)) {
    return undefined;
  }

  let i = openIndex + 1;
  const start = i;
  let inString = false;

  while (i < path.length) {
    const ch = path[i];
    if (ch === "'") {
      if (inString) {
        if (i + 1 < path.length && path[i + 1] === "'") {
          i += 2;
          continue;
        }
        inString = false;
      } else {
        inString = true;
      }
    } else if (!inString && ch === ')') {
      if (i - start > MAX_KEY_EXPRESSION_LENGTH) {
        return undefined;
      }
      return {
        keyExpression: path.slice(openIndex + 1, i),
        closeIndex: i,
      };
    }
    if (!inString && i - start > MAX_KEY_EXPRESSION_LENGTH) {
      return undefined;
    }
    i++;
  }

  return undefined;
}

function isSegmentChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    ch === '_' ||
    ch === '.'
  );
}

function normalizeKeyExpression(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (!trimmed) return '';

  const parts = splitTopLevel(trimmed, ',');
  if (!parts.length) return '';

  const hasAssignments = parts.some((part) => findTopLevelEquals(part) !== -1);
  if (hasAssignments) {
    const normalizedPairs: string[] = [];
    for (const part of parts) {
      const eqIndex = findTopLevelEquals(part);
      if (eqIndex === -1) return undefined;
      const key = decodeComponent(part.slice(0, eqIndex).trim());
      const rawValue = part.slice(eqIndex + 1);
      const value = normalizeLiteral(rawValue);
      normalizedPairs.push(`${key}=${value}`);
    }
    return normalizedPairs.join(',');
  }

  const normalizedValues = parts.map((part) => normalizeLiteral(part));
  return normalizedValues.join(',');
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'") {
      current += ch;
      if (inString) {
        if (i + 1 < input.length && input[i + 1] === "'") {
          current += "'";
          i++;
          continue;
        }
        inString = false;
      } else {
        inString = true;
      }
      continue;
    }

    if (!inString && ch === delimiter) {
      result.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.length) {
    result.push(current.trim());
  }
  return result.filter(Boolean);
}

function findTopLevelEquals(segment: string): number {
  let inString = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "'") {
      if (inString) {
        if (i + 1 < segment.length && segment[i + 1] === "'") {
          i++;
          continue;
        }
        inString = false;
      } else {
        inString = true;
      }
      continue;
    }
    if (!inString && ch === '=') {
      return i;
    }
  }
  return -1;
}

function normalizeLiteral(raw: string): string {
  const decoded = decodeComponent(raw.trim());
  let literal = decoded.trim();

  const prefixMatch = literal.match(KEY_PREFIX_REGEX);
  const hadTypePrefix = Boolean(prefixMatch);
  if (prefixMatch) {
    literal = literal.slice(prefixMatch[0].length);
  }

  if (literal.startsWith("'") && literal.endsWith("'") && literal.length >= 2) {
    literal = literal.slice(1, -1);
  } else if (hadTypePrefix && literal.endsWith("'")) {
    literal = literal.slice(0, -1);
  }

  literal = literal.replace(/''/g, "'");
  return literal;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

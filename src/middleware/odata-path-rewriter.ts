export const MAX_KEY_EXPRESSION_LENGTH = 4096;

export interface RewriteOptions {
  namespace?: string;
  namespaceAlias?: string;
}

export function rewriteODataUrl(url: string, options?: RewriteOptions): string {
  const { path, query, hash } = splitUrl(url);
  const { path: rewrittenPath, extraQuery } = rewritePath(path, options);
  const mergedQuery = mergeQueryStrings(query, extraQuery);
  return rewrittenPath + buildSuffix(mergedQuery, hash);
}

function splitUrl(url: string): { path: string; query?: string; hash?: string } {
  let path = url;
  let query: string | undefined;
  let hash: string | undefined;

  const hashIndex = path.indexOf('#');
  if (hashIndex >= 0) {
    hash = path.slice(hashIndex + 1);
    path = path.slice(0, hashIndex);
  }

  const queryIndex = path.indexOf('?');
  if (queryIndex >= 0) {
    query = path.slice(queryIndex + 1);
    path = path.slice(0, queryIndex);
  }

  return { path, query, hash };
}

function buildSuffix(query?: string, hash?: string): string {
  let suffix = '';
  if (query && query.length) {
    suffix += `?${query}`;
  }
  if (hash && hash.length) {
    suffix += `#${hash}`;
  }
  return suffix;
}

function mergeQueryStrings(existing?: string, extra?: string): string | undefined {
  if (extra == null || extra === '') return existing;
  if (!existing || existing === '') return extra;
  return `${existing}&${extra}`;
}

function rewritePath(
  path: string,
  options?: RewriteOptions,
): { path: string; extraQuery?: string } {
  if (!path.includes('(')) return { path };

  let result = '';
  let index = 0;
  const queryFragments: string[] = [];

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
    const segmentStart = path.lastIndexOf('/', openIndex - 1) + 1;
    const segmentName = path.slice(segmentStart, openIndex);
    if (segmentName.includes('.')) {
      const query = canonicalParametersToQuery(keyExpression);
      if (query !== undefined) {
        if (query) queryFragments.push(query);
        const normalizedSegment = stripNamespace(segmentName, options);
        result += path.slice(index, segmentStart) + normalizedSegment;
        index = closeIndex + 1;
        continue;
      }
    }

    const normalizedKey = normalizeKeyExpression(keyExpression);
    if (normalizedKey == null) {
      result += path.slice(index, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }

    const encodedKey = encodeURIComponent(normalizedKey).replace(/'/g, '%27');
    result += path.slice(index, openIndex);
    result += `/${encodedKey}`;
    index = closeIndex + 1;
  }

  const extraQuery = queryFragments.length ? queryFragments.join('&') : undefined;
  return extraQuery ? { path: result, extraQuery } : { path: result };
}

interface KeySegmentParseResult {
  keyExpression: string;
  closeIndex: number;
}

function extractKeySegment(path: string, openIndex: number): KeySegmentParseResult | undefined {
  if (openIndex <= 0) return undefined;

  const preceding = path[openIndex - 1];
  if (preceding === '/') {
    // expected shape
  } else if (preceding === ')') {
    // navigating from previous key segment
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
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
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

function canonicalParametersToQuery(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (!trimmed) return '';
  const parts = splitTopLevel(trimmed, ',');
  if (!parts.length) return '';
  const queryParts: string[] = [];
  for (const part of parts) {
    const eqIndex = findTopLevelEquals(part);
    if (eqIndex === -1) return undefined;
    const rawName = part.slice(0, eqIndex).trim();
    const name = decodeComponent(rawName);
    if (!name) return undefined;
    const rawValue = part.slice(eqIndex + 1).trim();
    const encodedValue = encodeCanonicalLiteral(rawValue);
    queryParts.push(`${encodeURIComponent(name)}=${encodedValue}`);
  }
  return queryParts.join('&');
}

function encodeCanonicalLiteral(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  const typedMatch = /^([A-Za-z_][\w.]*)'(.*)'$/.exec(trimmed);
  if (typedMatch) {
    const [, type, literal] = typedMatch;
    const unescaped = literal.replace(/''/g, "'");
    return encodeLiteral(`${type}'${unescaped}'`);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const inner = trimmed.slice(1, -1).replace(/''/g, "'");
    return encodeLiteral(inner);
  }
  return encodeLiteral(trimmed);
}

function encodeLiteral(value: string): string {
  return encodeURIComponent(value).replace(/'/g, '%27');
}

function stripNamespace(segment: string, options?: RewriteOptions): string {
  const prefixes = [options?.namespace, options?.namespaceAlias]
    .filter((value): value is string => Boolean(value))
    .map((value) => `${value}.`);
  for (const prefix of prefixes) {
    if (prefix && segment.startsWith(prefix)) {
      return segment.slice(prefix.length);
    }
  }
  return segment;
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

function findTopLevelEquals(input: string): number {
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'") {
      if (inString) {
        if (i + 1 < input.length && input[i + 1] === "'") {
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

function decodeComponent(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
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

const KEY_PREFIX_REGEX = /^(?:[A-Za-z_][A-Za-z0-9_.]*)'/;

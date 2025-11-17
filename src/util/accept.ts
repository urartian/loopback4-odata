export interface MediaRange {
  type: string;
  subtype: string;
  q: number;
}

export interface MediaType {
  type: string;
  subtype: string;
}

function parseMediaType(value: string): MediaType | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const [typeRaw, subtypeRaw] = trimmed.split('/');
  if (!typeRaw || !subtypeRaw) return undefined;
  const type = typeRaw.trim().toLowerCase();
  const subtype = subtypeRaw.trim().toLowerCase();
  if (!type || !subtype) return undefined;
  return { type, subtype };
}

function parseMediaRange(segment: string): MediaRange | undefined {
  const trimmed = segment.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(';');
  const typeSegment = parts.shift();
  if (!typeSegment || !typeSegment.includes('/')) return undefined;
  const parsedType = parseMediaType(typeSegment);
  if (!parsedType) return undefined;
  let q = 1;
  for (const param of parts) {
    const [keyRaw, valueRaw] = param.split('=');
    if (!keyRaw || valueRaw === undefined) continue;
    const key = keyRaw.trim().toLowerCase();
    if (key !== 'q') continue;
    const value = valueRaw.trim().replace(/^"|"$/g, '');
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      q = Math.min(Math.max(parsed, 0), 1);
    }
  }
  return { ...parsedType, q };
}

export function parseAcceptHeader(header?: string): MediaRange[] {
  if (!header?.trim()) return [];
  return header
    .split(',')
    .map((segment) => parseMediaRange(segment))
    .filter((range): range is MediaRange => Boolean(range));
}

export function acceptsAnyMediaType(header: string | undefined, allowedTypes: string[]): boolean {
  if (!allowedTypes.length) return true;
  if (!header?.trim()) return true;
  const ranges = parseAcceptHeader(header);
  if (!ranges.length) return false;
  const allowed = allowedTypes
    .map((entry) => parseMediaType(entry))
    .filter((range): range is MediaType => Boolean(range));
  if (!allowed.length) return true;
  return ranges.some((range) => {
    if (range.q <= 0) return false;
    if (range.type === '*' && range.subtype === '*') return true;
    return allowed.some((target) => {
      const typeMatches = range.type === target.type || range.type === '*';
      if (!typeMatches) return false;
      return range.subtype === target.subtype || range.subtype === '*';
    });
  });
}

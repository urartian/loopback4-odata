export type ODataTypedLiteralKind = 'datetimeoffset' | 'date' | 'guid' | 'int64' | 'decimal';

export function unwrapODataTypedLiteral(
  token: string,
  kind: ODataTypedLiteralKind,
): string | undefined {
  const raw = String(token ?? '');
  if (!raw) return undefined;
  if (!raw.endsWith("'")) return undefined;
  const lower = raw.toLowerCase();
  const prefix = `${kind}'`;
  if (!lower.startsWith(prefix)) return undefined;
  const inner = raw.slice(prefix.length, -1);
  return inner.replace(/''/g, "'");
}

export function parseInt64StringLiteral(token: string): string | undefined {
  const raw = String(token ?? '').trim();
  if (!raw) return undefined;

  const typed = unwrapODataTypedLiteral(raw, 'int64');
  if (typed !== undefined) {
    const inner = typed.trim();
    if (!/^-?\d+$/.test(inner)) return undefined;
    return inner;
  }

  if (/^-?\d+[lL]$/.test(raw)) {
    const withoutSuffix = raw.slice(0, -1);
    if (!/^-?\d+$/.test(withoutSuffix)) return undefined;
    return withoutSuffix;
  }

  if (!/^-?\d+$/.test(raw)) return undefined;
  return raw;
}

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeGuidStringLiteral(token: string): string | undefined {
  let raw = String(token ?? '').trim();
  if (!raw) return undefined;

  const typed = unwrapODataTypedLiteral(raw, 'guid');
  if (typed !== undefined) raw = typed.trim();

  if (raw.startsWith('{') && raw.endsWith('}')) {
    raw = raw.slice(1, -1).trim();
  }

  if (!GUID_REGEX.test(raw)) return undefined;
  return raw.toLowerCase();
}

export function parseDateStringLiteral(token: string): string | undefined {
  let raw = String(token ?? '').trim();
  if (!raw) return undefined;

  const typed = unwrapODataTypedLiteral(raw, 'date');
  if (typed !== undefined) raw = typed.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return raw;
}

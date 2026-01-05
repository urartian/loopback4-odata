export function normalizeDateTimeOffsetString(raw: string): string | undefined {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return undefined;

  const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (canonical.test(trimmed)) return trimmed;

  const partial =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
  const match = partial.exec(trimmed);
  if (!match) return undefined;

  const [, date, time, fraction = '', offsetRaw = ''] = match;

  let offset = offsetRaw ?? '';
  if (!offset) {
    offset = 'Z';
  } else if (offset.toUpperCase() === 'Z') {
    offset = 'Z';
  } else {
    const sign = offset[0];
    let rest = offset.slice(1).replace(':', '');
    if (!/^[+-]$/.test(sign) || rest.length > 4) return undefined;
    if (!/^\d*$/.test(rest)) return undefined;
    if (rest.length === 0) rest = '0000';
    if (rest.length === 2) rest = `${rest}00`;
    if (rest.length !== 4) return undefined;
    const hours = rest.slice(0, 2);
    const minutes = rest.slice(2, 4);
    offset = `${sign}${hours}:${minutes}`;
    if (offset === '+00:00' || offset === '-00:00') {
      offset = 'Z';
    }
  }

  return `${date}T${time}${fraction ?? ''}${offset}`;
}

export function normalizeDecimalString(
  input: string,
  options: { maxExponentAbs?: number } = {},
): string | undefined {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return undefined;
  const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
  if (!numeric.test(trimmed)) return undefined;
  const sign = trimmed.startsWith('-') ? '-' : trimmed.startsWith('+') ? '' : '';
  const unsigned = trimmed.replace(/^[+-]/, '');
  if (!/e/i.test(unsigned)) {
    return normalizePlainDecimal(sign, unsigned);
  }
  return normalizeScientificDecimal(sign, unsigned, options.maxExponentAbs);
}

export function toPlainDecimalString(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const str = value.toString();
  if (!/e/i.test(str)) return str;
  const [mantissa, exponentRaw] = str.toLowerCase().split('e');
  const exponent = Number(exponentRaw);
  if (!Number.isFinite(exponent)) return str;
  const sign = mantissa.startsWith('-') ? '-' : '';
  const normalizedMantissa = mantissa.replace(/^[+-]/, '');
  const decimalIndex = normalizedMantissa.indexOf('.');
  const digits = normalizedMantissa.replace('.', '');
  const initialIndex = decimalIndex === -1 ? digits.length : decimalIndex;
  const targetIndex = initialIndex + exponent;

  if (targetIndex <= 0) {
    return `${sign}0.${'0'.repeat(-targetIndex)}${digits}`.replace(/\.$/, '');
  }
  if (targetIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(targetIndex - digits.length)}`;
  }
  const integerPart = digits.slice(0, targetIndex) || '0';
  const fractionalPart = digits.slice(targetIndex).replace(/0+$/, '');
  return fractionalPart ? `${sign}${integerPart}.${fractionalPart}` : `${sign}${integerPart}`;
}

function normalizePlainDecimal(sign: string, unsigned: string): string {
  const parts = unsigned.split('.');
  const integerPart = parts[0]?.length ? parts[0] : '0';
  const fractionPart = parts[1] ?? '';
  return combineDecimalParts(sign, integerPart, fractionPart);
}

function normalizeScientificDecimal(
  sign: string,
  unsigned: string,
  maxExponentAbs = 1000,
): string | undefined {
  const exponentIndex = unsigned.toLowerCase().lastIndexOf('e');
  if (exponentIndex < 0) return undefined;
  const mantissa = unsigned.slice(0, exponentIndex);
  const exponentRaw = unsigned.slice(exponentIndex + 1);
  if (!mantissa) return undefined;
  const exponent = Number(exponentRaw);
  if (!Number.isFinite(exponent) || !Number.isInteger(exponent)) return undefined;
  if (maxExponentAbs > 0 && Math.abs(exponent) > maxExponentAbs) {
    return undefined;
  }
  const normalizedMantissa = mantissa.replace(/^[+-]/, '');
  const mantissaParts = normalizedMantissa.split('.');
  const whole = mantissaParts[0] ?? '';
  const decimals = mantissaParts[1] ?? '';
  const digits = `${whole}${decimals}`;
  if (!digits) return `${sign}0`;
  const decimalIndex = whole.length;
  const targetIndex = decimalIndex + exponent;
  let integer: string;
  let fraction: string;

  if (targetIndex <= 0) {
    integer = '0';
    const zeros = '0'.repeat(Math.abs(targetIndex));
    fraction = `${zeros}${digits}`;
  } else if (targetIndex >= digits.length) {
    const zeros = '0'.repeat(targetIndex - digits.length);
    integer = `${digits}${zeros}`;
    fraction = '';
  } else {
    integer = digits.slice(0, targetIndex);
    fraction = digits.slice(targetIndex);
  }

  return combineDecimalParts(sign, integer, fraction);
}

function combineDecimalParts(sign: string, integer: string, fraction: string): string {
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  if (normalizedFraction) {
    return `${sign}${normalizedInteger}.${normalizedFraction}`;
  }
  return `${sign}${normalizedInteger}`;
}

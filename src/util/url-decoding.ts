export function safeDecodeURIComponent(input: string): string | undefined {
  try {
    return decodeURIComponent(input);
  } catch {
    return undefined;
  }
}

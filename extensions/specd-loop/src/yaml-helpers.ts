/** Narrow `unknown` to a plain record without an unsafe cast. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Coerce an unknown YAML value to a string, falling back when it's not one. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

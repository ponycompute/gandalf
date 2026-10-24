/** Plain JSON with object keys sorted at every level, so equal values serialize to equal bytes. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

import { readFileSync, writeFileSync } from "node:fs";

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The size the window last closed at, from `file` in userData. A missing or garbled file, or a
 * size under the window's minimum, gives `fallback`, so the window always opens usable.
 */
export function readWindowSize(
  file: string,
  minimum: WindowSize,
  fallback: WindowSize,
): WindowSize {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
  if (typeof saved !== "object" || saved === null) return fallback;
  const { width, height } = saved as Record<string, unknown>;
  if (typeof width !== "number" || typeof height !== "number") return fallback;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return fallback;
  if (width < minimum.width || height < minimum.height) return fallback;
  return { width, height };
}

/** Saves the size for the next launch. A failed write only costs the next launch its size. */
export function writeWindowSize(file: string, size: WindowSize): void {
  try {
    writeFileSync(file, `${JSON.stringify({ width: size.width, height: size.height })}\n`);
  } catch {
    // The next launch opens at the default size.
  }
}

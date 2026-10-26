import type { ScreenStorage } from "./lastScreen";

const KEY = "gandalf.appearance";

export const APPEARANCES = ["system", "light", "dark"] as const;

/** Light or dark, or System to follow the Mac's setting. */
export type Appearance = (typeof APPEARANCES)[number];

/** The appearance the user chose last; System on a first launch. */
export function savedAppearance(storage: ScreenStorage): Appearance {
  try {
    const saved = storage.getItem(KEY);
    return APPEARANCES.find((appearance) => appearance === saved) ?? "system";
  } catch {
    return "system";
  }
}

/** Remembers the appearance for the next launch. A storage that throws only costs it that. */
export function saveAppearance(storage: ScreenStorage, appearance: Appearance): void {
  try {
    storage.setItem(KEY, appearance);
  } catch {
    // The next launch follows the system.
  }
}

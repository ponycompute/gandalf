const KEY = "gandalf.screen";

/** What lastScreen needs of localStorage, which Chromium keeps in userData. */
export type ScreenStorage = Pick<Storage, "getItem" | "setItem">;

/** The screen the app showed when it last quit, or `screens[0]` on a first launch. */
export function lastScreen<S extends string>(
  storage: ScreenStorage,
  screens: readonly [S, ...S[]],
): S {
  try {
    const saved = storage.getItem(KEY);
    return screens.find((screen) => screen === saved) ?? screens[0];
  } catch {
    return screens[0];
  }
}

/** Remembers the screen for the next launch. A storage that throws only costs it that. */
export function saveScreen(storage: ScreenStorage, screen: string): void {
  try {
    storage.setItem(KEY, screen);
  } catch {
    // The next launch opens on the first screen.
  }
}

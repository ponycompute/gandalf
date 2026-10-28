const KEY = "gandalf.autoManage";

/** What the setting needs of localStorage, which Chromium keeps in userData. */
export type SettingStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Whether gandalf brings the skills it finds in agents' own folders into the library by itself.
 * Null until the user answers the first-run sheet that asks.
 */
export type AutoManage = boolean | null;

export function savedAutoManage(storage: SettingStorage): AutoManage {
  try {
    const saved = storage.getItem(KEY);
    return saved === "on" ? true : saved === "off" ? false : null;
  } catch {
    return null;
  }
}

/** Remembers the answer. A storage that throws only costs asking again on the next launch. */
export function saveAutoManage(storage: SettingStorage, on: boolean): void {
  try {
    storage.setItem(KEY, on ? "on" : "off");
  } catch {
    // The next launch asks again.
  }
}

import type { ScreenStorage } from "./lastScreen";

const KEY = "gandalf.sidebar";

/** Whether the sidebar showed when the app last quit; shown on a first launch. */
export function sidebarShown(storage: ScreenStorage): boolean {
  try {
    return storage.getItem(KEY) !== "hidden";
  } catch {
    return true;
  }
}

/** Remembers the sidebar for the next launch. A storage that throws only costs it that. */
export function saveSidebar(storage: ScreenStorage, shown: boolean): void {
  try {
    storage.setItem(KEY, shown ? "shown" : "hidden");
  } catch {
    // The next launch shows the sidebar.
  }
}

/** ⌃⌘S, the Mac's Show/Hide Sidebar. */
export function isSidebarShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return (
    event.metaKey &&
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "s"
  );
}

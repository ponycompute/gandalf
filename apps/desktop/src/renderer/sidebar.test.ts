import { describe, expect, it } from "vitest";
import { isSidebarShortcut, saveSidebar, sidebarShown } from "./sidebar";

function memory(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  } as Storage;
}

const broken = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("the sidebar's remembered state", () => {
  it("shows the sidebar on a first launch", () => {
    expect(sidebarShown(memory())).toBe(true);
  });

  it("comes back as the user left it", () => {
    const storage = memory();
    saveSidebar(storage, false);
    expect(sidebarShown(storage)).toBe(false);
    saveSidebar(storage, true);
    expect(sidebarShown(storage)).toBe(true);
  });

  it("shows the sidebar when storage throws", () => {
    expect(() => saveSidebar(broken, false)).not.toThrow();
    expect(sidebarShown(broken)).toBe(true);
  });
});

describe("the sidebar shortcut", () => {
  const press = (
    key: string,
    mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>,
  ) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("is Control-Command-S", () => {
    expect(isSidebarShortcut(press("s", { metaKey: true, ctrlKey: true }))).toBe(true);
  });

  it("leaves Command-S and other chords alone", () => {
    expect(isSidebarShortcut(press("s", { metaKey: true }))).toBe(false);
    expect(isSidebarShortcut(press("s", { ctrlKey: true }))).toBe(false);
    expect(isSidebarShortcut(press("S", { metaKey: true, ctrlKey: true, shiftKey: true }))).toBe(
      false,
    );
  });
});

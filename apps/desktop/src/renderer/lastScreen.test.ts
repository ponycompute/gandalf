import { describe, expect, it } from "vitest";
import { lastScreen, saveScreen, type ScreenStorage } from "./lastScreen";

const SCREENS = ["library", "agents", "discover", "install"] as const;

function memoryStorage(): ScreenStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

const throwing: ScreenStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("lastScreen", () => {
  it("opens on Library first, then on the screen saved last", () => {
    const storage = memoryStorage();
    expect(lastScreen(storage, SCREENS)).toBe("library");
    saveScreen(storage, "agents");
    expect(lastScreen(storage, SCREENS)).toBe("agents");
  });

  it("opens on Library for an unknown screen or a storage that throws", () => {
    const storage = memoryStorage();
    storage.setItem("gandalf.screen", "settings");
    expect(lastScreen(storage, SCREENS)).toBe("library");
    expect(lastScreen(throwing, SCREENS)).toBe("library");
    expect(() => saveScreen(throwing, "install")).not.toThrow();
  });
});

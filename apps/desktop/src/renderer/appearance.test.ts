import { describe, expect, it } from "vitest";
import { saveAppearance, savedAppearance } from "./appearance";

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

describe("the remembered appearance", () => {
  it("follows the system on a first launch", () => {
    expect(savedAppearance(memory())).toBe("system");
  });

  it("comes back as the user chose it", () => {
    const storage = memory();
    saveAppearance(storage, "dark");
    expect(savedAppearance(storage)).toBe("dark");
    saveAppearance(storage, "light");
    expect(savedAppearance(storage)).toBe("light");
  });

  it("follows the system for a value it does not know, or when storage throws", () => {
    const storage = memory();
    storage.setItem("gandalf.appearance", "sepia");
    expect(savedAppearance(storage)).toBe("system");
    expect(() => saveAppearance(broken, "dark")).not.toThrow();
    expect(savedAppearance(broken)).toBe("system");
  });
});

import { describe, expect, it } from "vitest";
import { saveAutoManage, savedAutoManage, type SettingStorage } from "./autoManage";

function memoryStorage(): SettingStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

const throwing: SettingStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("savedAutoManage", () => {
  it("is undecided until the user answers, then remembers the answer", () => {
    const storage = memoryStorage();
    expect(savedAutoManage(storage)).toBeNull();
    saveAutoManage(storage, true);
    expect(savedAutoManage(storage)).toBe(true);
    saveAutoManage(storage, false);
    expect(savedAutoManage(storage)).toBe(false);
  });

  it("is undecided for an unknown value or a storage that throws", () => {
    const storage = memoryStorage();
    storage.setItem("gandalf.autoManage", "maybe");
    expect(savedAutoManage(storage)).toBeNull();
    expect(savedAutoManage(throwing)).toBeNull();
    expect(() => saveAutoManage(throwing, true)).not.toThrow();
  });
});

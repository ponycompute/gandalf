import type { AdoptVariant } from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import { readKey, readsFor } from "./reads";

const variant = (hash: string, path: string) =>
  ({ hash, at: [{ path }] }) as unknown as AdoptVariant;

describe("readsFor", () => {
  it("shows the reads made for these variants", () => {
    const key = readKey([variant("sha256:a", "/h/a"), variant("sha256:b", "/h/b")]);
    const reads = [
      { kind: "read", text: "A" },
      { kind: "read", text: "B" },
    ] as const;
    expect(readsFor({ key, reads }, key, 2)).toBe(reads);
  });

  it("shows reads made before a rewrite as loading, though the paths are the same", () => {
    const before = readKey([variant("sha256:a", "/h/a"), variant("sha256:b", "/h/b")]);
    const after = readKey([variant("sha256:a", "/h/a"), variant("sha256:c", "/h/b")]);
    expect(after).not.toBe(before);
    const stored = { key: before, reads: [{ kind: "read", text: "old" }] as const };
    expect(readsFor(stored, after, 2)).toEqual([{ kind: "loading" }, { kind: "loading" }]);
    expect(readsFor(null, after, 1)).toEqual([{ kind: "loading" }]);
  });
});

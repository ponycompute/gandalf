import { describe, expect, it } from "vitest";
import { chosenFolder } from "./shell";

describe("chosenFolder", () => {
  it("returns the folder the user chose", () => {
    expect(chosenFolder({ canceled: false, filePaths: ["/Users/me/skills/pdf-tools"] })).toBe(
      "/Users/me/skills/pdf-tools",
    );
  });

  it("returns null when the user cancels, even if the panel still names a path", () => {
    expect(chosenFolder({ canceled: true, filePaths: [] })).toBeNull();
    expect(chosenFolder({ canceled: true, filePaths: ["/Users/me/skills"] })).toBeNull();
  });

  it("returns null for an answer with no path or a relative one", () => {
    expect(chosenFolder({ canceled: false, filePaths: [] })).toBeNull();
    expect(chosenFolder({ canceled: false, filePaths: ["skills"] })).toBeNull();
  });
});

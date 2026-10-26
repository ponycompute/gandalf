import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWindowSize, writeWindowSize } from "./windowSize";

const MINIMUM = { width: 640, height: 400 };
const FALLBACK = { width: 960, height: 640 };

async function sizeFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "gandalf-window-size-")), "window.json");
}

describe("window size", () => {
  it("reads back the size it wrote", async () => {
    const file = await sizeFile();
    writeWindowSize(file, { width: 1200, height: 800 });
    expect(readWindowSize(file, MINIMUM, FALLBACK)).toEqual({ width: 1200, height: 800 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ width: 1200, height: 800 });
  });

  it("falls back when the file is missing, garbled, or below the minimum", async () => {
    const file = await sizeFile();
    expect(readWindowSize(file, MINIMUM, FALLBACK)).toEqual(FALLBACK);
    for (const text of [
      "{",
      "null",
      '{"width":"1200","height":800}',
      '{"width":300,"height":800}',
    ]) {
      await writeFile(file, text);
      expect(readWindowSize(file, MINIMUM, FALLBACK)).toEqual(FALLBACK);
    }
  });

  it("does not throw when the folder cannot be written", () => {
    expect(() =>
      writeWindowSize(join(tmpdir(), "gandalf-missing-dir", "x", "window.json"), FALLBACK),
    ).not.toThrow();
  });
});

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildIcon, ICON_ICNS, ICONSET } from "./icon";

const run = promisify(execFile);

async function pixelSize(png: string): Promise<[number, number]> {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png]);
  const width = /pixelWidth: (\d+)/.exec(stdout)?.[1];
  const height = /pixelHeight: (\d+)/.exec(stdout)?.[1];
  return [Number(width), Number(height)];
}

describe.runIf(process.platform === "darwin")("icon.icns", () => {
  it("writes every iconset size from the logo, each at its pixel size", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "gandalf-icon-test-"));
    try {
      const iconset = await buildIcon(join(workDir, "icon.icns"), workDir);
      expect((await readdir(iconset)).sort()).toEqual(ICONSET.map((image) => image.name).sort());
      for (const image of ICONSET) {
        expect(await pixelSize(join(iconset, image.name))).toEqual([image.pixels, image.pixels]);
      }
      expect(await readdir(workDir)).toContain("icon.icns");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("holds every iconset size in the committed build/icon.icns", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "gandalf-icon-test-"));
    try {
      const iconset = join(workDir, "committed.iconset");
      await run("iconutil", ["-c", "iconset", ICON_ICNS, "-o", iconset]);
      expect((await readdir(iconset)).sort()).toEqual(ICONSET.map((image) => image.name).sort());
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

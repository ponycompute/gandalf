import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/** The app icon, an Icon Composer document electron-builder compiles with actool. */
const ICON = fileURLToPath(new URL("../build/icon.icon", import.meta.url));
const ICTOOL =
  "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool";

interface IconDocument {
  readonly groups: readonly {
    readonly layers: readonly {
      readonly "image-name": string;
      readonly "image-name-specializations"?: readonly { readonly value: string }[];
    }[];
  }[];
}

describe("build/icon.icon", () => {
  it("names only images its Assets folder holds", async () => {
    const document = JSON.parse(await readFile(join(ICON, "icon.json"), "utf8")) as IconDocument;
    const named = document.groups.flatMap((group) =>
      group.layers.flatMap((layer) => [
        layer["image-name"],
        ...(layer["image-name-specializations"] ?? []).map((special) => special.value),
      ]),
    );
    expect(named.sort()).toEqual((await readdir(join(ICON, "Assets"))).sort());
  });

  it.runIf(existsSync(ICTOOL))("renders in light and dark", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "gandalf-icon-test-"));
    try {
      for (const rendition of ["Default", "Dark"]) {
        const png = join(workDir, `${rendition}.png`);
        await run(ICTOOL, [
          ICON,
          "--export-image",
          "--output-file",
          png,
          "--platform",
          "macOS",
          "--rendition",
          rendition,
          "--width",
          "64",
          "--height",
          "64",
          "--scale",
          "1",
        ]);
        expect(existsSync(png)).toBe(true);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

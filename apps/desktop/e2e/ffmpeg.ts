import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const HOMEBREW_FFMPEG = "/opt/homebrew/bin/ffmpeg";

interface CoreBundle {
  readonly registry: {
    readonly registry: {
      findExecutable(name: "ffmpeg"): { executablePath(): string | undefined };
    };
  };
}

const CORE_BUNDLE = "playwright-core/lib/coreBundle";

/**
 * The ffmpeg Playwright spawns to record video, asked of Playwright's own registry, which fixes
 * its folder from PLAYWRIGHT_BROWSERS_PATH when Playwright first loads. The registry sits behind a
 * private subpath, so a Playwright upgrade can move it.
 */
export function playwrightFfmpeg(): string {
  const fromPlaywright = createRequire(createRequire(import.meta.url).resolve("playwright"));
  let findExecutable: CoreBundle["registry"]["registry"]["findExecutable"];
  try {
    const registry = (fromPlaywright(CORE_BUNDLE) as CoreBundle).registry.registry;
    findExecutable = registry.findExecutable.bind(registry);
  } catch (cause) {
    const { version } = fromPlaywright("playwright/package.json") as { version: string };
    throw new Error(
      `Playwright ${version} has no ffmpeg registry at ${CORE_BUNDLE}, so recordVideo cannot ` +
        "find or check its ffmpeg. Update e2e/ffmpeg.ts for this Playwright version.",
      { cause },
    );
  }
  const path = findExecutable("ffmpeg").executablePath();
  if (path === undefined) throw new Error("Playwright records no video on this platform");
  return path;
}

/** Without its ffmpeg, Playwright never finishes opening a recorded window and reports nothing. */
export async function requireFfmpeg(): Promise<void> {
  const path = playwrightFfmpeg();
  if (await executable(path)) return;
  throw new Error(
    `recordVideo needs Playwright's ffmpeg at ${path}, and there is none. Run the e2e suite ` +
      "through e2e/vitest.config.ts, which links Homebrew's ffmpeg there, or run " +
      "`pnpm exec playwright install ffmpeg`.",
  );
}

/**
 * Vitest global setup. When Playwright's ffmpeg is missing, points the test workers' Playwright at
 * a throwaway folder that links Homebrew's ffmpeg under the name Playwright looks for. Tests that
 * never record video must still run when Playwright's registry cannot be found, so that case
 * links nothing and leaves requireFfmpeg to fail the tests that do record.
 */
export default async function linkHomebrewFfmpeg(): Promise<(() => Promise<void>) | undefined> {
  let wanted: string;
  try {
    wanted = playwrightFfmpeg();
  } catch {
    return undefined;
  }
  if ((await executable(wanted)) || !(await executable(HOMEBREW_FFMPEG))) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "gandalf-ffmpeg-"));
  const removeDir = () => rm(dir, { recursive: true, force: true });
  try {
    const link = join(dir, basename(dirname(wanted)), basename(wanted));
    await mkdir(dirname(link));
    await symlink(HOMEBREW_FFMPEG, link);
  } catch (error) {
    await removeDir();
    throw error;
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
  return removeDir;
}

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

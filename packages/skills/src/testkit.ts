// Test helpers. Every test runs against a fresh temp HOME; nothing here can reach the real one.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import type { AbsPath } from "./types.js";

/** The caller removes it. Prefer tempHome() inside a test. */
export async function createTempHome(): Promise<AbsPath> {
  return (await realpath(await mkdtemp(join(tmpdir(), "gandalf-test-")))) as AbsPath;
}

/** A temp HOME removed when the current test finishes. */
export async function tempHome(): Promise<AbsPath> {
  const home = await createTempHome();
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  return home;
}

export function skillMd(name: string, description = `${name} skill`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

/** Writes `files` (relative path -> contents) under `base`, creating parents. */
export async function writeTree(
  base: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(base, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

export async function writeSkill(
  dir: string,
  name: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<void> {
  await writeTree(dir, { "SKILL.md": skillMd(name), ...extra });
}

export async function link(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
}

export function at(home: string, relative: string): AbsPath {
  return join(home, relative) as AbsPath;
}

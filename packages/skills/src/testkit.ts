// Test helpers. Every test runs against a fresh temp HOME; nothing here can reach the real one.

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import { layout, nodeFs, nodeGit, type Env, type Fs } from "./env.js";
import { openGandalf } from "./gandalf.js";
import { writeState, type DesiredState } from "./state.js";
import type { AbsPath, Intent, Plan, Revision } from "./types.js";

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

export class SimulatedCrash extends Error {
  constructor() {
    super("SimulatedCrash");
  }
}

const MUTATIONS = [
  "writeFileExclusive",
  "writeFile",
  "mkdir",
  "rename",
  "symlink",
  "unlink",
  "copyTree",
  "removeTree",
] as const satisfies readonly (keyof Fs)[];

export interface TestEnvOptions {
  /** The n-th mutation (1-based) and every one after it throw SimulatedCrash, like a dead process. */
  readonly crashAt?: number | null;
  readonly pid?: number;
  /** Counts mutations across calls, so a test can learn how many an uninterrupted run makes. */
  readonly counter?: { n: number };
  /** Replaces individual port methods, e.g. probeSymlink, to simulate a filesystem. */
  readonly fs?: Partial<Fs>;
  readonly now?: Date;
}

export const TEST_NOW = new Date("2026-10-24T09:00:00.000Z");

/** The real filesystem under a temp HOME, real git, a fixed clock, and only `pid` alive. */
export function testEnv(home: AbsPath, options: TestEnvOptions = {}): Env {
  const pid = options.pid ?? 1;
  const counter = options.counter ?? { n: 0 };
  const base: Fs = { ...nodeFs, ...options.fs };
  const fs: Record<string, unknown> = { ...base };
  for (const name of MUTATIONS) {
    const original = base[name] as (...args: unknown[]) => Promise<unknown>;
    fs[name] = async (...args: unknown[]) => {
      counter.n += 1;
      if (options.crashAt != null && counter.n >= options.crashAt) throw new SimulatedCrash();
      return original(...args);
    };
  }
  return {
    home,
    fs: fs as unknown as Fs,
    git: nodeGit(home),
    now: () => options.now ?? TEST_NOW,
    pid,
    isAlive: (candidate) => candidate === pid,
  };
}

/** Writes state.json the way gandalf does, from a partial DesiredState. */
export async function seedState(
  home: AbsPath,
  state: Partial<Omit<DesiredState, "revision">> & { readonly revision?: number },
): Promise<void> {
  await writeState(
    nodeFs,
    layout(home, () => TEST_NOW),
    {
      revision: (state.revision ?? 1) as Revision,
      skills: state.skills ?? {},
      agents: state.agents ?? {},
    },
  );
}

/** plan + apply; throws unless every step completed. */
export async function run(env: Env, intent: Intent): Promise<Plan> {
  const gandalf = openGandalf(env);
  const outcome = await gandalf.plan(intent);
  if (!outcome.ok) throw new Error(`plan failed: ${outcome.error.kind}`);
  const result = await gandalf.apply(outcome.plan);
  if (result.kind !== "applied") throw new Error(`apply was ${result.kind}`);
  const bad = result.results.filter((r) => r.status !== "done" && r.status !== "alreadyDone");
  if (bad.length > 0) throw new Error(`steps did not complete: ${JSON.stringify(bad)}`);
  return outcome.plan;
}

const NOT_STATE = [".gandalf/trash", ".gandalf/staging", ".gandalf/cache", ".gandalf/lock"];

/**
 * Agent dirs, library, and state.json as sorted "path kind content" lines with HOME written as ~.
 * Trash, staging, and the git cache are gandalf-private scratch space, and a lock left by a dead
 * process is recognized as stale by the next apply, so none of them count as state.
 */
export async function treeOf(home: string): Promise<string[]> {
  const lines: string[] = [];
  const tilde = (text: string) => text.split(home).join("~");
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (NOT_STATE.includes(relPath)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) lines.push(`${relPath} link ${tilde(await readlink(path))}`);
      else if (entry.isDirectory()) {
        lines.push(`${relPath} dir`);
        await walk(path, relPath);
      } else lines.push(`${relPath} file ${tilde(await readFile(path, "utf8"))}`);
    }
  };
  await walk(home, "");
  return lines.sort();
}

/**
 * Every entry under `home` (and `home` itself), scratch space included, as sorted lines of path,
 * kind, mode, size, mtime in nanoseconds, and a content hash or link target. Two equal listings mean
 * nothing was written, not even a file that was created and removed again.
 */
export async function rawTreeOf(home: string): Promise<string[]> {
  const lines: string[] = [];
  const describe = async (path: string, rel: string): Promise<void> => {
    const stats = await lstat(path, { bigint: true });
    const kind = stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : "file";
    const content =
      kind === "link"
        ? await readlink(path)
        : kind === "file"
          ? createHash("sha256")
              .update(await readFile(path))
              .digest("hex")
          : "";
    lines.push(
      `${rel} ${kind} ${stats.mode.toString(8)} ${stats.size} ${stats.mtimeNs} ${content}`,
    );
    if (kind !== "dir") return;
    for (const name of await readdir(path)) {
      await describe(join(path, name), rel === "." ? name : `${rel}/${name}`);
    }
  };
  await describe(home, ".");
  return lines.sort();
}

/** Runs git in `cwd` with an isolated config, for building fixture repos. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(
    "git",
    ["-c", "user.name=gandalf-test", "-c", "user.email=test@gandalf.invalid", ...args],
    { cwd, env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } },
  );
  return stdout.trim();
}

/**
 * A bare repo at `<dir>/remote.git` whose main branch holds `files`, built from a work tree at
 * `<dir>/work`. Returns the commit. commitTo() adds a later commit on the same branch.
 */
export async function gitRemote(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<{ readonly url: string; readonly commit: string }> {
  const work = join(dir, "work");
  await writeTree(work, files);
  await git(work, "init", "--quiet", "--initial-branch=main");
  await git(work, "add", ".");
  await git(work, "commit", "--quiet", "-m", "first");
  const url = join(dir, "remote.git");
  await git(dir, "clone", "--quiet", "--bare", work, url);
  return { url, commit: await git(work, "rev-parse", "HEAD") };
}

export async function commitTo(
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const work = join(dir, "work");
  await writeTree(work, files);
  await git(work, "add", ".");
  await git(work, "commit", "--quiet", "-m", "next");
  await git(work, "push", "--quiet", join(dir, "remote.git"), "main");
  return git(work, "rev-parse", "HEAD");
}

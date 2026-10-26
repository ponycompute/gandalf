// Injected dependencies and the ~/.gandalf layout.
//
// The Fs port is deliberately narrow. Inside agent dirs it can only create a symlink (fails on
// EEXIST), create a directory, or rename. Recursive delete and plain overwrite accept only paths
// under ~/.gandalf, enforced by the GandalfPath and StagingPath brands. "gandalf deletes a user's
// skill" is therefore not expressible against this interface, whatever a planner bug produces.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AbsPath } from "./types.js";

declare const underGandalf: unique symbol;
declare const underStaging: unique symbol;
/** A path under ~/.gandalf. Produced only by layout() and within(). */
export type GandalfPath = AbsPath & { readonly [underGandalf]: true };
/** A path under ~/.gandalf/staging. Everything here is gandalf-built and disposable. */
export type StagingPath = GandalfPath & { readonly [underStaging]: true };

export type StatKind = "file" | "dir" | "symlink" | "other";

export interface Fs {
  /** null on ENOENT. Does not follow symlinks. */
  lstat(path: AbsPath): Promise<StatKind | null>;
  /** null on ENOENT. Follows symlinks: how a link's `resolves` is decided. */
  stat(path: AbsPath): Promise<StatKind | null>;
  readlink(path: AbsPath): Promise<string>;
  realpath(path: AbsPath): Promise<AbsPath | null>;
  /** null on ENOENT. Throws on EACCES or ENOTDIR so the caller can record a read error. */
  readdir(path: AbsPath): Promise<readonly string[] | null>;
  /** null when there is no regular file at `path`. */
  readFile(path: AbsPath): Promise<Uint8Array | null>;

  // Mutations. Each is one syscall, so a crash lands between calls, never inside one.
  // copyTree is the exception and only ever writes into staging.

  /** false on EEXIST. Used for the apply lock. */
  writeFileExclusive(path: GandalfPath, data: string): Promise<boolean>;
  writeFile(path: StagingPath, data: string): Promise<void>;
  /** Creates missing parents too. No-op when the directory exists. */
  mkdir(path: AbsPath): Promise<void>;
  /** Throws EXDEV across volumes, ENOTEMPTY or ENOTDIR when the destination is occupied. */
  rename(from: AbsPath, to: AbsPath): Promise<void>;
  /** Throws EEXIST when anything exists at `path`. Never replaces. */
  symlink(target: AbsPath, path: AbsPath): Promise<void>;
  unlink(path: GandalfPath): Promise<void>;
  copyTree(from: AbsPath, to: StagingPath): Promise<void>;
  removeTree(path: StagingPath): Promise<void>;
  /**
   * Whether `dir` accepts symlinks: creates a uniquely named dot-symlink on the same filesystem (in
   * the temp dir when it shares the device, else in `dir`) and removes it. It can only remove the
   * name it just generated, so it adds no way to delete a user's entry.
   */
  probeSymlink(dir: AbsPath): Promise<boolean>;
}

/** A git command that exited non-zero. The message is its stderr. */
export class GitError extends Error {}

export const GIT_CANCELLED = "the plan was cancelled";

/** A git command, or a wait to run one, that its caller's signal aborted. */
export class GitCancelled extends GitError {
  constructor() {
    super(GIT_CANCELLED);
  }
}

/**
 * Runs `git <args>` and resolves stdout. Rejects with a GitError on a non-zero exit, and with a
 * GitCancelled once `signal` aborts. Only a fetch is ever given a signal: it is the one command that
 * waits on the network, and the others are local and quick, where a kill half way could leave the
 * cache unusable.
 */
export type GitRunner = (
  args: readonly string[],
  options: { readonly cwd: AbsPath; readonly signal?: AbortSignal },
) => Promise<string>;

export interface Env {
  readonly home: AbsPath;
  readonly fs: Fs;
  readonly git: GitRunner;
  readonly now: () => Date;
  readonly pid: number;
  /** Lock staleness evidence. Tests inject this to simulate a crashed holder. */
  readonly isAlive: (pid: number) => boolean;
}

export interface Layout {
  readonly gandalfDir: GandalfPath;
  readonly libraryDir: GandalfPath;
  readonly stateFile: GandalfPath;
  readonly lockFile: GandalfPath;
  readonly cacheDir: GandalfPath;
  readonly stagingDir: StagingPath;
  readonly trashDir: GandalfPath;
  librarySkill(name: string): GandalfPath;
  /** A fresh, unique staging path. */
  staging(label: string): StagingPath;
  /** A fresh, unique trash path. Trash is never emptied in Stage 1. */
  trash(label: string): GandalfPath;
}

/** A child of a gandalf-owned path keeps its brand. Segments come from gandalf, never from users. */
export function within<P extends GandalfPath>(base: P, ...segments: readonly string[]): P {
  if (segments.some((segment) => segment === ".." || segment.includes("/"))) {
    throw new Error(`invalid path segment under ${base}: ${segments.join("/")}`);
  }
  return join(base, ...segments) as P;
}

export function layout(home: AbsPath, now: () => Date): Layout {
  const gandalfDir = join(home, ".gandalf") as GandalfPath;
  const stagingDir = within(gandalfDir, "staging") as StagingPath;
  const trashDir = within(gandalfDir, "trash");
  const libraryDir = within(gandalfDir, "skills");
  const fresh = (label: string): string =>
    `${now().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${label}`;
  return {
    gandalfDir,
    libraryDir,
    stateFile: within(gandalfDir, "state.json"),
    lockFile: within(gandalfDir, "lock"),
    cacheDir: within(gandalfDir, "cache"),
    stagingDir,
    trashDir,
    librarySkill: (name) => within(libraryDir, name),
    staging: (label) => within(stagingDir, fresh(label)),
    trash: (label) => within(trashDir, fresh(label)),
  };
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "dir";
  return stats.isFile() ? "file" : "other";
}

async function orNull<T>(work: Promise<T>, codes: readonly string[]): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (codes.includes(errorCode(error) ?? "")) return null;
    throw error;
  }
}

const MISSING = ["ENOENT", "ENOTDIR"];
const NO_SYMLINKS = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"];

export const nodeFs: Fs = {
  lstat: async (path) => orNull(fsp.lstat(path).then(kindOf), MISSING),
  stat: async (path) => orNull(fsp.stat(path).then(kindOf), [...MISSING, "ELOOP"]),
  readlink: (path) => fsp.readlink(path),
  realpath: async (path) => orNull(fsp.realpath(path), MISSING) as Promise<AbsPath | null>,
  readdir: async (path) => orNull(fsp.readdir(path), ["ENOENT"]),
  readFile: async (path) => orNull(fsp.readFile(path), [...MISSING, "EISDIR"]),
  writeFileExclusive: async (path, data) => {
    try {
      await fsp.writeFile(path, data, { flag: "wx" });
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  },
  writeFile: (path, data) => fsp.writeFile(path, data),
  mkdir: async (path) => {
    await fsp.mkdir(path, { recursive: true });
  },
  rename: (from, to) => fsp.rename(from, to),
  symlink: (target, path) => fsp.symlink(target, path, "dir"),
  unlink: (path) => fsp.unlink(path),
  copyTree: (from, to) =>
    fsp.cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }),
  removeTree: (path) => fsp.rm(path, { recursive: true, force: true }),
  probeSymlink: async (dir) => {
    // Symlink support belongs to the filesystem, so the temp dir answers for `dir` when it is on the
    // same device, and a folder the user owns does not get its mtime bumped by a plan.
    const [here, scratch] = await Promise.all([fsp.stat(dir), fsp.stat(tmpdir())]);
    const probe = join(here.dev === scratch.dev ? tmpdir() : dir, `.gandalf-probe-${randomUUID()}`);
    try {
      await fsp.symlink(".", probe);
    } catch (error) {
      // Anything but "symlinks unsupported" (EACCES, EROFS) says nothing about symlinks; the
      // creation step will report that error itself.
      return !NO_SYMLINKS.includes(errorCode(error) ?? "");
    }
    await fsp.unlink(probe);
    return true;
  },
};

/** Output per stream past which git is killed, as execFile's maxBuffer. */
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Kills git with everything it started. git runs its transport, such as git-remote-https or
 * upload-pack, as a child that would run on past git's own death, so a git with a signal leads its
 * own process group and the whole group goes. Without a pid, or with the group gone, only git is
 * left to kill.
 */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid === undefined) throw new Error("git has no pid");
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * `git` from PATH with HOME pinned to the gandalf home, so injected homes isolate git config. git
 * always speaks C: callers tell a missing folder from a missing branch by git's English words, which
 * a localized git would translate. `command` is git, or a stand-in in tests.
 */
export function nodeGit(home: AbsPath, command = "git"): GitRunner {
  return (args, { cwd, signal }) => {
    if (signal?.aborted === true) return Promise.reject(new GitCancelled());
    return new Promise((done, fail) => {
      // spawn, not execFile, which drops `detached`.
      const child = spawn(command, ["-c", "protocol.ext.allow=never", ...args], {
        cwd,
        env: { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" },
        detached: signal !== undefined,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const kill = () => (signal === undefined ? child.kill("SIGKILL") : killGroup(child));
      let cancelled = false;
      const abort = () => {
        cancelled = true;
        kill();
      };
      signal?.addEventListener("abort", abort, { once: true });
      let overflow: string | null = null;
      const collect = (name: string, stream: NodeJS.ReadableStream) => {
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // Output this large means something is wrong, so git goes.
          if (size > MAX_OUTPUT) {
            overflow ??= name;
            kill();
          } else chunks.push(chunk);
        });
        return () => Buffer.concat(chunks).toString("utf8");
      };
      const stdout = collect("stdout", child.stdout);
      const stderr = collect("stderr", child.stderr);
      child.on("error", (error) => {
        signal?.removeEventListener("abort", abort);
        fail(new GitError(error.message));
      });
      child.on("close", (code, killed) => {
        signal?.removeEventListener("abort", abort);
        if (cancelled) return fail(new GitCancelled());
        if (overflow !== null) {
          return fail(new GitError(`git ${args.join(" ")} wrote more than 64 MB to ${overflow}`));
        }
        if (code === 0) return done(stdout());
        fail(new GitError(stderr().trim() || `git ${args.join(" ")} ended with ${code ?? killed}`));
      });
    });
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** Real filesystem, `git` from PATH, wall clock, process.pid, and kill(pid, 0) liveness. */
export function nodeEnv(options?: { readonly home?: string }): Env {
  const home = resolve(options?.home ?? homedir()) as AbsPath;
  return {
    home,
    fs: nodeFs,
    git: nodeGit(home),
    now: () => new Date(),
    pid: process.pid,
    isAlive,
  };
}

import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import {
  GitError,
  InputError,
  StateCorruptError,
  openGandalf,
  parseIntent,
  parsePlanToken,
  type ApplyOutcome,
  type Env,
  type Gandalf,
  type Intent,
  type PlanOutcome,
  type Snapshot,
} from "@gandalf/skills";
import type { AppError, Result } from "../shared/ipc";

/** Takes the renderer's payloads as unknown: they are parsed here, before they reach Gandalf. */
export interface GandalfService {
  snapshot(): Promise<Result<Snapshot>>;
  /** Once `signal` aborts, the plan's fetch is killed and it answers with a git error. */
  plan(intent: unknown, signal?: AbortSignal): Promise<Result<PlanOutcome>>;
  apply(token: unknown): Promise<Result<ApplyOutcome>>;
  readSkillFile(path: unknown): Promise<Result<string>>;
  /** The path back when it is a skill folder in the library of a fresh snapshot, for Finder. */
  revealable(path: unknown): Promise<Result<string>>;
}

/** The largest file readSkillFile serves. A SKILL.md is a page of text; this leaves ample room. */
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;

/**
 * Folders whose files the renderer may read: skill folders the snapshot shows. The library lists a
 * linked skill folder like any other, so readSkillFile refuses a folder that is a link itself.
 */
function readableDirs(snapshot: Snapshot): Set<string> {
  const dirs = new Set(snapshot.skills.map((skill) => skill.dir));
  for (const entry of snapshot.entries) {
    const kind = entry.observed.kind;
    if (kind === "skillDir" || kind === "modifiedCopy" || kind === "cleanCopy")
      dirs.add(entry.path);
  }
  return dirs;
}

function refuse(message: string): never {
  throw new InputError("path", message);
}

/**
 * Reads a file straight inside a skill folder of a fresh snapshot. The path must already be
 * normal, so `..` cannot climb out. Neither the folder nor the file may be a symlink, so neither
 * can point out of the folder gandalf shows. The open does not wait on a FIFO, and the read stops
 * one byte past the limit, so a file that grows after the size check still cannot pass it.
 */
async function readSkillFile(gandalf: Gandalf, path: unknown): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) {
    refuse("must be a normal absolute path");
  }
  const dir = dirname(path);
  if (!readableDirs(await gandalf.snapshot()).has(dir)) {
    refuse("is not in a skill folder gandalf shows");
  }
  const folder = await lstat(dir).catch(() => refuse("is in a folder that cannot be read"));
  if (!folder.isDirectory()) refuse("is in a skill folder that is a link");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => refuse("cannot be opened as a file"));
  try {
    if (!(await file.stat()).isFile()) refuse("is not a file");
    const buffer = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SKILL_FILE_BYTES) refuse("is larger than 1 MB");
    return buffer.toString("utf8", 0, length);
  } finally {
    await file.close();
  }
}

/**
 * Lets the renderer show only a library skill folder in Finder, never any other path: the folder
 * must be one the snapshot lists, straight inside the library.
 */
async function revealable(gandalf: Gandalf, path: unknown): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) {
    refuse("must be a normal absolute path");
  }
  const snapshot = await gandalf.snapshot();
  const skill = snapshot.skills.some((view) => view.dir === path);
  if (!skill || dirname(path) !== snapshot.libraryDir) {
    refuse("is not a skill folder in the library");
  }
  return path;
}

/** Starts every reason the app gives for a local install folder that is missing or not a folder. */
export const NOT_A_FOLDER = "no folder at ";

/**
 * The core reads a local source's SKILL.md and says only that there is none, also when the folder
 * itself is missing. Install should say which, so this checks the folder after such a refusal.
 */
async function withMissingFolder(intent: Intent, outcome: PlanOutcome): Promise<PlanOutcome> {
  if (intent.kind !== "install" || intent.source.kind !== "local") return outcome;
  if (outcome.ok || outcome.error.kind !== "badSource") return outcome;
  if (!outcome.error.reason.startsWith("no SKILL.md in ")) return outcome;
  const { path } = intent.source;
  const folder = await stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  return folder
    ? outcome
    : { ok: false, error: { kind: "badSource", reason: `${NOT_A_FOLDER}${path}` } };
}

export function openService(env: Env): GandalfService {
  const gandalf = openGandalf(env);
  return {
    snapshot: () => settle(() => gandalf.snapshot()),
    plan: (intent, signal) =>
      settle(async () => {
        const parsed = parseIntent(intent);
        return withMissingFolder(parsed, await gandalf.plan(parsed, { signal }));
      }),
    apply: (token) => settle(() => gandalf.apply(parsePlanToken(token))),
    readSkillFile: (path) => settle(() => readSkillFile(gandalf, path)),
    revealable: (path) => settle(() => revealable(gandalf, path)),
  };
}

export function toAppError(error: unknown): AppError {
  if (error instanceof StateCorruptError) {
    return { kind: "stateCorrupt", path: error.path, reason: error.reason };
  }
  if (error instanceof InputError) {
    return { kind: "badInput", field: error.field, message: error.message };
  }
  if (error instanceof GitError) return { kind: "git", message: error.message };
  return { kind: "internal", message: error instanceof Error ? error.message : String(error) };
}

export async function settle<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: toAppError(error) };
  }
}

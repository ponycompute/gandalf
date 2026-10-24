// apply: lock, re-derive, compare, execute.
//
// apply never executes the step list it is handed. Under the lock it re-derives the plan from
// token.intent against a fresh observation and runs only if the fingerprints match. A stale preview
// (a CLI ran in between, an fs event the UI has not shown yet) and a forged or corrupted IPC payload
// both reduce to "stale": nothing is written and the caller gets the fresh plan to show instead.

import { basename, join } from "node:path";
import {
  classify,
  cleanStaging,
  contentHash,
  grab,
  place,
  restore,
  stageCopy,
  type LibraryDirs,
} from "./disk.js";
import { errorCode, type Env, type Layout } from "./env.js";
import { materialize } from "./library.js";
import { applyChanges, isNoop, readState, writeState } from "./state.js";
import type {
  AbsPath,
  ApplyOutcome,
  ContentHash,
  IsoTime,
  LockHolder,
  Observed,
  PlanOutcome,
  PlanToken,
  Revision,
  SkillName,
  Step,
  StepResult,
} from "./types.js";

type Derive = (intent: PlanToken["intent"]) => Promise<PlanOutcome>;

const LOCK_MAX_AGE_MS = 10 * 60 * 1000;

export async function applyToken(
  env: Env,
  paths: Layout,
  token: PlanToken,
  derive: Derive,
): Promise<ApplyOutcome> {
  await env.fs.mkdir(paths.gandalfDir);
  const lock = await acquireLock(env, paths);
  if ("pid" in lock) return { kind: "busy", holder: lock };
  try {
    await cleanStaging(env.fs, paths);
    const fresh = await derive(token.intent);
    if (!fresh.ok || fresh.plan.fingerprint !== token.fingerprint) return { kind: "stale", fresh };
    const real = await env.fs.realpath(paths.libraryDir);
    const context: Context = {
      env,
      paths,
      library:
        real === null || real === paths.libraryDir ? [paths.libraryDir] : [paths.libraryDir, real],
    };
    const steps = fresh.plan.steps;
    const results: StepResult[] = [];
    for (const [index, step] of steps.entries()) {
      const blocker = results.findIndex(
        (result, j) => !completed(result) && blocks(steps[j]!, step, paths),
      );
      results.push(
        blocker >= 0
          ? { step, status: "skipped", after: blocker }
          : await execute(context, step, index),
      );
    }
    return { kind: "applied", results };
  } finally {
    await lock.release();
  }
}

interface Lock {
  readonly release: () => Promise<void>;
}

/**
 * writeFileExclusive(lockFile, { pid, since }). On EEXIST, read the holder; it is stale when
 * !isAlive(pid) or it is older than 10 minutes (apply never touches the network, so a live apply
 * finishes in seconds). A stale lock is replaced once, then contention is reported as busy.
 */
async function acquireLock(env: Env, paths: Layout): Promise<Lock | LockHolder> {
  const mine: LockHolder = { pid: env.pid, since: env.now().toISOString() as IsoTime };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await env.fs.writeFileExclusive(paths.lockFile, JSON.stringify(mine))) {
      return { release: () => env.fs.unlink(paths.lockFile) };
    }
    const holder = parseHolder(await env.fs.readFile(paths.lockFile));
    const stale =
      holder === null ||
      !env.isAlive(holder.pid) ||
      env.now().getTime() - Date.parse(holder.since) > LOCK_MAX_AGE_MS;
    if (!stale || attempt > 0) return holder ?? mine;
    try {
      await env.fs.unlink(paths.lockFile);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return mine;
}

function parseHolder(bytes: Uint8Array | null): LockHolder | null {
  if (bytes === null) return null;
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof raw !== "object" || raw === null) return null;
    const pid = "pid" in raw ? raw.pid : null;
    const since = "since" in raw ? raw.since : null;
    return typeof pid === "number" && typeof since === "string" && !Number.isNaN(Date.parse(since))
      ? { pid, since: since as IsoTime }
      : null;
  } catch {
    return null;
  }
}

function completed(result: StepResult): boolean {
  return result.status === "done" || result.status === "alreadyDone";
}

/** What a step writes: its slot, the skill whose library dir it needs, and the dir it writes into. */
function touches(
  step: Step,
  paths: Layout,
): { slot?: string; skill?: SkillName; dir?: string; library?: boolean } {
  switch (step.kind) {
    case "unlink":
    case "trashCopy":
      return { slot: join(step.slot.root, step.slot.name), dir: step.slot.root };
    case "link":
    case "copy":
      return { slot: join(step.slot.root, step.slot.name), skill: step.skill, dir: step.slot.root };
    case "adoptMove":
      return { slot: step.from.path, skill: step.skill, dir: paths.libraryDir, library: true };
    case "trashDuplicate":
      return { slot: step.from.path, skill: step.skill };
    case "libraryAdd":
    case "libraryReplace":
      return { skill: step.skill, dir: paths.libraryDir, library: true };
    case "libraryTrash":
      return { skill: step.skill, library: true };
    case "ensureDir":
      return { dir: step.dir };
    case "commitState":
      return {};
  }
}

/**
 * A failed commitState blocks everything after it: additions must not outrun the recorded intent.
 * Otherwise a failed or drifted step blocks only later steps on its own slot, steps that need the
 * library dir it was meant to produce, and steps writing into a dir it failed to create. A drifted
 * removal therefore never blocks commitState: the slot is no longer ours and the intent still holds.
 */
function blocks(failed: Step, later: Step, paths: Layout): boolean {
  if (failed.kind === "commitState") return true;
  if (later.kind === "commitState") return false;
  const a = touches(failed, paths);
  const b = touches(later, paths);
  if (a.slot !== undefined && a.slot === b.slot) return true;
  if (a.library === true && a.skill !== undefined && a.skill === b.skill) return true;
  return failed.kind === "ensureDir" && a.dir === b.dir;
}

interface Context {
  readonly env: Env;
  readonly paths: Layout;
  readonly library: LibraryDirs;
}

/**
 * One step, three-way: observe; post holds -> alreadyDone; pre holds -> act -> done; else drifted.
 * Destructive acts are grab (rename into trash), verify the grabbed entry, then keep or restore it.
 * Pre and post are checked with disk.ts classify() and contentHash(), the same functions the snapshot
 * used, so apply and scan cannot disagree about ownership. I/O errors become `failed`; anything
 * without an errno (a bug, or a simulated crash in tests) propagates.
 */
async function execute(context: Context, step: Step, index: number): Promise<StepResult> {
  try {
    return await act(context, step, index);
  } catch (error) {
    const code = errorCode(error);
    if (code === undefined) throw error;
    return {
      step,
      status: "failed",
      reason: code === "EXDEV" ? "crossDevice" : "io",
      error: error instanceof Error ? error.message : code,
    };
  }
}

async function act(context: Context, step: Step, index: number): Promise<StepResult> {
  const { env, paths, library } = context;
  const { fs } = env;
  const done = (status: "done" | "alreadyDone" = "done"): StepResult => ({ step, status });
  const drifted = (found: string): StepResult => ({ step, status: "drifted", found });
  const observe = (path: AbsPath) => classify(fs, library, path);
  const hashOf = async (path: AbsPath): Promise<ContentHash | null> =>
    (await fs.lstat(path)) === null ? null : contentHash(fs, path);

  /** grab, verify the grabbed entry is still what the step expects, then keep it or put it back. */
  const takeOwned = async (
    path: AbsPath,
    expected: (found: Observed) => boolean,
    keep: "trash" | "unlink",
  ): Promise<StepResult> => {
    const grabbed = await grab(fs, paths, path, `${index}-${basename(path)}`);
    if (grabbed === null) return done("alreadyDone");
    const found = await observe(grabbed);
    if (!expected(found)) {
      const back = await restore(fs, grabbed, path);
      return drifted(back ? describe(found) : `${describe(found)}; kept in ${grabbed}`);
    }
    if (keep === "unlink") await fs.unlink(grabbed);
    return done();
  };

  switch (step.kind) {
    case "link": {
      const path = join(step.slot.root, step.slot.name) as AbsPath;
      const found = await observe(path);
      if (found.kind === "link" && found.skill === step.skill) return done("alreadyDone");
      if (found.kind !== "absent") return drifted(describe(found));
      try {
        await fs.symlink(paths.librarySkill(step.skill), path);
      } catch (error) {
        if (errorCode(error) === "EEXIST") return drifted("something appeared at the slot");
        throw error;
      }
      return done();
    }
    case "copy": {
      const path = join(step.slot.root, step.slot.name) as AbsPath;
      const found = await observe(path);
      if (found.kind === "cleanCopy" && found.skill === step.skill && found.hash === step.hash) {
        return done("alreadyDone");
      }
      if (found.kind !== "absent") return drifted(describe(found));
      const { staged, hash } = await stageCopy(fs, paths, step.skill);
      if (hash !== step.hash) return drifted("the library dir changed since the plan");
      return (await place(fs, staged, path)) === "placed"
        ? done()
        : drifted("something appeared at the slot");
    }
    case "unlink": {
      const path = join(step.slot.root, step.slot.name) as AbsPath;
      const isOurs = (found: Observed) => found.kind === "link" && found.skill === step.skill;
      const found = await observe(path);
      if (found.kind === "absent") return done("alreadyDone");
      if (!isOurs(found)) return drifted(describe(found));
      return takeOwned(path, isOurs, "unlink");
    }
    case "trashCopy": {
      const path = join(step.slot.root, step.slot.name) as AbsPath;
      const isOurs = (found: Observed) => found.kind === "cleanCopy" && found.hash === step.hash;
      const found = await observe(path);
      if (found.kind === "absent") return done("alreadyDone");
      if (!isOurs(found)) return drifted(describe(found));
      return takeOwned(path, isOurs, "trash");
    }
    case "trashDuplicate": {
      const isDuplicate = (found: Observed) =>
        found.kind === "skillDir" && found.hash === step.hash;
      const found = await observe(step.from.path);
      if (found.kind === "absent") return done("alreadyDone");
      if (!isDuplicate(found)) return drifted(describe(found));
      return takeOwned(step.from.path, isDuplicate, "trash");
    }
    case "adoptMove": {
      const into = paths.librarySkill(step.skill);
      const inLibrary = await hashOf(into);
      const found = await observe(step.from.path);
      if (inLibrary === step.hash && found.kind === "absent") return done("alreadyDone");
      if (inLibrary !== null) return drifted("the library already has a dir of that name");
      if (found.kind !== "skillDir" || found.hash !== step.hash) return drifted(describe(found));
      await fs.rename(step.from.path, into);
      if ((await contentHash(fs, into)) === step.hash) return done();
      const back = await restore(fs, into, step.from.path);
      return drifted(
        back ? "edited while moving; put back" : `edited while moving; left at ${into}`,
      );
    }
    case "libraryAdd": {
      const into = paths.librarySkill(step.skill);
      const inLibrary = await hashOf(into);
      if (inLibrary === step.hash) return done("alreadyDone");
      if (inLibrary !== null) return drifted("the library has a different dir of that name");
      await fs.mkdir(paths.stagingDir);
      const staged = paths.staging(step.skill);
      await materialize(env, paths, step.from, staged);
      if ((await contentHash(fs, staged)) !== step.hash) {
        return drifted("the source changed since the plan");
      }
      return (await place(fs, staged, into)) === "placed"
        ? done()
        : drifted("a library dir appeared");
    }
    case "libraryReplace": {
      const into = paths.librarySkill(step.skill);
      const current = await hashOf(into);
      if (current === step.hash) return done("alreadyDone");
      if (current !== null && current !== step.expect) return drifted("the library dir was edited");
      await fs.mkdir(paths.stagingDir);
      const staged = paths.staging(step.skill);
      await materialize(env, paths, step.from, staged);
      if ((await contentHash(fs, staged)) !== step.hash) {
        return drifted("the source changed since the plan");
      }
      if (current !== null) {
        const grabbed = await grab(fs, paths, into, step.skill);
        if (grabbed !== null && (await contentHash(fs, grabbed)) !== step.expect) {
          await restore(fs, grabbed, into);
          return drifted("the library dir was edited");
        }
      }
      return (await place(fs, staged, into)) === "placed"
        ? done()
        : drifted("a library dir appeared");
    }
    case "libraryTrash": {
      const from = paths.librarySkill(step.skill);
      const current = await hashOf(from);
      if (current === null) return done("alreadyDone");
      if (current !== step.expect) return drifted("the library dir was edited");
      const grabbed = await grab(fs, paths, from, step.skill);
      if (grabbed === null) return done("alreadyDone");
      if ((await contentHash(fs, grabbed)) === step.expect) return done();
      await restore(fs, grabbed, from);
      return drifted("the library dir was edited");
    }
    case "ensureDir": {
      if ((await fs.stat(step.dir)) === "dir") return done("alreadyDone");
      if ((await fs.lstat(step.dir)) !== null) return drifted("a file is in the way");
      await fs.mkdir(step.dir);
      return done();
    }
    case "commitState": {
      const state = await readState(fs, paths);
      if (isNoop(state, step.changes)) return done("alreadyDone");
      if (state.revision !== step.from) {
        return drifted(`state.json moved to revision ${state.revision}`);
      }
      const next = applyChanges(state, step.changes, env.now().toISOString() as IsoTime);
      await writeState(fs, paths, { ...next, revision: (step.from + 1) as Revision });
      return done();
    }
  }
}

function describe(found: Observed): string {
  switch (found.kind) {
    case "absent":
      return "nothing";
    case "link":
      return `a link to ${found.skill}`;
    case "cleanCopy":
      return `a copy of ${found.skill}`;
    case "modifiedCopy":
      return `an edited copy of ${found.skill}`;
    case "skillDir":
      return "a skill dir that is not gandalf's";
    case "foreignLink":
      return `a link to ${found.target}`;
    case "other":
      return "a file or dir without SKILL.md";
  }
}

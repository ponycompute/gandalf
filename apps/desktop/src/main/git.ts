import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { GitError, type GitRunner, type Intent } from "@gandalf/skills";

/** One plan in main: the fetches it has running, and whether the renderer cancelled it. */
interface PlanRun {
  cancelled: boolean;
  readonly fetches: Set<ChildProcess>;
}

export interface PlanGit {
  /** The core's git, for plans and applies alike. */
  readonly git: GitRunner;
  /**
   * Runs the plan for `intent`. One that may fetch starts once every such plan before it has
   * settled, so no two fetch into the cache at once; any other runs at once, never behind a fetch.
   */
  plan<T>(intent: unknown, work: () => Promise<T>): Promise<T>;
  /**
   * Cancels every plan started so far: their running fetches are killed, and a fetch they start
   * later fails at once. Other git commands still run, since they are local and quick, and killing
   * one half way could leave the cache unusable. An apply is never touched.
   */
  cancel(): void;
}

export const CANCELLED = "the plan was cancelled";

/** Output past which git is killed, as nodeGit's maxBuffer. */
const MAX_OUTPUT = 64 * 1024 * 1024;

/** Options git takes before its subcommand that have a separate value, as in `-c key=value`. */
const VALUED = new Set(["-c", "-C", "--config-env", "--exec-path", "--git-dir", "--work-tree"]);

/** The subcommand in `args`, past any options git takes before it. */
export function subcommand(args: readonly string[]): string | null {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    if (!arg.startsWith("-")) return arg;
    if (VALUED.has(arg)) at++;
  }
  return null;
}

/** Whether a plan for each intent may fetch; a new intent has to say. An install may, from git. */
const FETCHES: Readonly<Record<Intent["kind"], boolean>> = {
  sync: false,
  setEnabled: false,
  adopt: false,
  install: true,
  update: true,
  remove: false,
  configureAgent: false,
};

/**
 * Whether a plan for `intent` may fetch, so it has to wait its turn. A payload of a shape the core
 * does not know counts as one that may, so a fetch never runs outside the queue; the core refuses
 * it anyway.
 */
export function mayFetch(intent: unknown): boolean {
  if (typeof intent !== "object" || intent === null || !("kind" in intent)) return true;
  const { kind } = intent;
  if (typeof kind !== "string" || !Object.hasOwn(FETCHES, kind)) return true;
  if (kind !== "install") return FETCHES[kind as Intent["kind"]];
  const source = "source" in intent ? intent.source : null;
  return !(
    typeof source === "object" &&
    source !== null &&
    "kind" in source &&
    source.kind === "local"
  );
}

/**
 * Kills a plan's fetch with everything it started. git runs its transport, such as
 * git-remote-https or upload-pack, as a child that would run on past git's own death, so the fetch
 * leads its own process group and the whole group goes. Without a pid, or with the group gone,
 * only git is left to kill.
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
 * The core's git (nodeGit in packages/skills/src/env.ts, same flags and environment), with plans
 * that can be cancelled. The core has no timeout and gives no handle on the child, so a fetch that
 * hangs would hold the plan forever. git always speaks C: main tells a missing folder from a
 * missing branch by git's English words, which a localized git would translate. `command` is git,
 * or a stand-in in tests.
 */
export function planGit(home: string, command = "git"): PlanGit {
  const storage = new AsyncLocalStorage<PlanRun>();
  const runs = new Set<PlanRun>();
  let tail: Promise<unknown> = Promise.resolve();

  const git: GitRunner = (args, { cwd }) => {
    // A fetch a plan runs, which cancel may kill; null for any other git command.
    const run = subcommand(args) === "fetch" ? (storage.getStore() ?? null) : null;
    if (run?.cancelled === true) return Promise.reject(new GitError(CANCELLED));
    return new Promise((done, fail) => {
      // spawn, not execFile, which drops `detached`. A plan's fetch leads its own process group,
      // so cancel can kill its transport with it; Node still reaps it as any child.
      const child = spawn(command, ["-c", "protocol.ext.allow=never", ...args], {
        cwd,
        env: { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" },
        detached: run !== null,
        stdio: ["ignore", "pipe", "pipe"],
      });
      run?.fetches.add(child);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        // As execFile's maxBuffer: output this large means something is wrong, so git goes.
        if (size > MAX_OUTPUT) {
          if (run === null) child.kill("SIGKILL");
          else killGroup(child);
        } else into.push(chunk);
      };
      child.stdout.on("data", collect(out));
      child.stderr.on("data", collect(err));
      child.on("error", (error) => {
        run?.fetches.delete(child);
        fail(new GitError(error.message));
      });
      child.on("close", (code, signal) => {
        run?.fetches.delete(child);
        if (code === 0) return done(Buffer.concat(out).toString("utf8"));
        const stderr = Buffer.concat(err).toString("utf8").trim();
        fail(new GitError(stderr || `git ${args.join(" ")} ended with ${code ?? signal}`));
      });
    });
  };

  return {
    git,
    plan: (intent, work) => {
      if (!mayFetch(intent)) return work();
      const run: PlanRun = { cancelled: false, fetches: new Set() };
      runs.add(run);
      const result = tail.then(() => storage.run(run, work));
      tail = result.then(
        () => runs.delete(run),
        () => runs.delete(run),
      );
      return result;
    },
    cancel: () => {
      for (const run of runs) {
        run.cancelled = true;
        for (const child of run.fetches) killGroup(child);
      }
    },
  };
}

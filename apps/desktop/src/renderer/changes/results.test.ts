import { chmod, mkdir, rename } from "node:fs/promises";
import {
  openGandalf,
  type AbsPath,
  type Fs,
  type Intent,
  type SkillName,
  type Snapshot,
  type StepResult,
} from "@gandalf/skills";
import { describe, expect, it, onTestFinished } from "vitest";
import { run, tempHome, testEnv, writeSkill } from "../../../../../packages/skills/src/testkit";
import { namesOf } from "../vocabulary";
import { unfinished } from "./results";

const DEMO = "demo" as SkillName;

const fake = <T>(value: unknown) => value as T;

function errno(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** Cursor and Claude Code installed, demo in the library and on for Claude Code. */
async function demoHome() {
  const home = (await tempHome()) as AbsPath;
  await mkdir(`${home}/.cursor`, { recursive: true });
  await mkdir(`${home}/.claude`, { recursive: true });
  await writeSkill(`${home}/src/demo`, "demo");
  await run(testEnv(home), {
    kind: "install",
    source: { kind: "local", path: `${home}/src/demo` as AbsPath },
    agents: ["claude_code"],
  });
  const names = namesOf(await openGandalf(testEnv(home)).snapshot(), home);
  /** Plans and applies `intent` against a filesystem with `fs` swapped in, as core reports it. */
  const apply = async (intent: Intent, fs: Partial<Fs> = {}) => {
    const gandalf = openGandalf(testEnv(home, { fs }));
    const outcome = await gandalf.plan(intent);
    if (!outcome.ok) throw new Error(`plan refused: ${outcome.error.kind}`);
    const applied = await gandalf.apply(outcome.plan);
    if (applied.kind !== "applied") throw new Error(`apply was ${applied.kind}`);
    return applied.results;
  };
  return { home, names, apply };
}

const ON_FOR_CURSOR: Intent = {
  kind: "setEnabled",
  skill: DEMO,
  enabled: true,
  agents: ["cursor"],
};
const OFF_FOR_CLAUDE: Intent = {
  kind: "setEnabled",
  skill: DEMO,
  enabled: false,
  agents: ["claude_code"],
};

describe("unfinished", () => {
  it("names a step that could not write to the agent folder, and the step that waited on it", async () => {
    const { home, names, apply } = await demoHome();
    await chmod(`${home}/.cursor`, 0o555);
    onTestFinished(() => chmod(`${home}/.cursor`, 0o755));
    const results = await apply(ON_FOR_CURSOR);
    expect(results.map((result) => result.status)).toEqual(["done", "failed", "skipped"]);
    expect(unfinished(results, names)).toEqual([
      {
        step: "Create the skills folder for Cursor",
        text: "did not finish. gandalf has no permission to write to ~/.cursor/skills. Check its permissions in Finder, then click Sync.",
      },
      {
        step: "Link demo into Cursor",
        text: "did not happen, because “Create the skills folder for Cursor” did not finish. Click Sync to see what is left.",
      },
    ]);
  });

  it("says the place changed when something appeared there mid-apply", async () => {
    const { names, apply } = await demoHome();
    const results = await apply(ON_FOR_CURSOR, {
      symlink: () => Promise.reject(errno("EEXIST", "file already exists")),
    });
    expect(results.map((result) => result.status)).toEqual(["done", "done", "drifted"]);
    expect(unfinished(results, names)).toEqual([
      {
        step: "Link demo into Cursor",
        text: "did not happen. ~/.cursor/skills/demo changed while gandalf was applying, so gandalf left it alone. Click Sync to see what is left.",
      },
    ]);
  });

  it("says a move across disks is not possible, and a full disk, in user words", async () => {
    const { names, apply } = await demoHome();
    const across = await apply(OFF_FOR_CLAUDE, {
      rename: (from, to) =>
        from.endsWith("/.claude/skills/demo")
          ? Promise.reject(errno("EXDEV", "cross-device link not permitted"))
          : rename(from, to),
    });
    expect(across.map((result) => result.status)).toEqual(["failed", "done"]);
    expect(unfinished(across, names)).toEqual([
      {
        step: "Remove demo from Claude Code",
        text: "did not finish. ~/.claude/skills/demo is on a different disk from ~/.gandalf, and gandalf moves skills only within one disk. Move it onto the same disk, then click Sync.",
      },
    ]);
    const full = await apply(ON_FOR_CURSOR, {
      mkdir: async (path) => {
        if (path.endsWith("/.cursor/skills")) throw errno("ENOSPC", "no space left on device");
        await mkdir(path, { recursive: true });
      },
    });
    expect(unfinished(full, names)[0]).toEqual({
      step: "Create the skills folder for Cursor",
      text: "did not finish. The disk is full. Free up space, then click Sync.",
    });
  });

  it("never shows the CLI's status labels, core's reasons, or apply-order step numbers", async () => {
    const { home, names, apply } = await demoHome();
    await chmod(`${home}/.cursor`, 0o555);
    onTestFinished(() => chmod(`${home}/.cursor`, 0o755));
    const results = await apply(ON_FOR_CURSOR);
    const said = unfinished(results, names)
      .map((line) => `${line.step} ${line.text}`)
      .join("\n");
    for (const word of ["Failed:", "Skipped:", "Drifted:", "io:", "EACCES", "mkdir", "step 2"]) {
      expect(said).not.toContain(word);
    }
  });

  it("has words for every status and failure reason core reports", () => {
    const step = { kind: "ensureDir", dir: "/h/.cursor/skills" as AbsPath } as const;
    const failed = { step, status: "failed", reason: "io", error: "EIO: i/o error" } as const;
    const statuses = {
      done: { step, status: "done" },
      alreadyDone: { step, status: "alreadyDone" },
      drifted: { step, status: "drifted", found: "a file is in the way" },
      failed,
      skipped: { step, status: "skipped", after: 0 },
    } as const satisfies Record<StepResult["status"], StepResult>;
    const reasons = {
      io: failed,
      crossDevice: { ...failed, reason: "crossDevice" },
    } as const satisfies Record<Extract<StepResult, { status: "failed" }>["reason"], StepResult>;
    const names = namesOf(
      fake<Snapshot>({ libraryDir: "/h/.gandalf/skills", agents: [], roots: [] }),
      "/h",
    );
    const said = (result: StepResult) => unfinished([result], names).map((line) => line.text);
    expect(Object.values(statuses).map(said)).toEqual([
      [],
      [],
      [
        "did not happen. ~/.cursor/skills changed while gandalf was applying, so gandalf left it alone. Click Sync to see what is left.",
      ],
      ["did not finish. gandalf could not write to ~/.cursor/skills. Click Sync to try again."],
      [
        "did not happen, because “Create the skills folder for ~/.cursor/skills” did not finish. Click Sync to see what is left.",
      ],
    ]);
    expect(Object.values(reasons).map(said)).toEqual([
      ["did not finish. gandalf could not write to ~/.cursor/skills. Click Sync to try again."],
      [
        "did not finish. ~/.cursor/skills is on a different disk from ~/.gandalf, and gandalf moves skills only within one disk. Move it onto the same disk, then click Sync.",
      ],
    ]);
  });
});

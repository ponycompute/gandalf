import { mkdir, rm } from "node:fs/promises";
import type {
  AbsPath,
  ApplyOutcome,
  Entry,
  Intent,
  NotDone,
  Observed,
  Plan,
  PlanError,
  SkillName,
  Snapshot,
  Step,
  StepResult,
} from "@gandalf/skills";
import { openGandalf } from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import { textRender, type Render } from "../../../../packages/cli/src/render";
import { run, tempHome, testEnv, writeSkill } from "../../../../packages/skills/src/testkit";
import {
  GLYPH,
  cannotAdoptReason,
  NOT_DONE,
  STEP_WORD,
  busyText,
  intentTitle,
  namesOf,
  notDoneReason,
  planRefusal,
  stepSentence,
  summaryLine,
  tilde,
  tildeAll,
  type Names,
} from "./vocabulary";

const HOME = "/h";
const HASH = `sha256:${"c".repeat(64)}`;
const COMMIT = "d".repeat(40);

function cli(run: (render: Render) => void): string[] {
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  run(textRender(print, print, HOME));
  return lines;
}

const fake = <T>(value: unknown) => value as T;

const slot = { root: "/h/.cursor/skills", name: "demo" };
const local = { kind: "local", path: "/h/src/demo" };
const at = {
  root: "/h/.codex/skills",
  role: "target",
  readers: ["codex"],
  name: "demo",
  path: "/h/.codex/skills/demo",
};

const STEPS = fake<readonly Step[]>([
  { kind: "unlink", slot, skill: "demo" },
  { kind: "trashCopy", slot, hash: HASH },
  { kind: "trashProjectCopy", slot, hash: HASH },
  { kind: "libraryReplace", skill: "demo", expect: HASH, from: local, hash: HASH },
  { kind: "commitState", from: 3, changes: [] },
  { kind: "ensureDir", dir: "/h/.cursor/skills" },
  {
    kind: "libraryAdd",
    skill: "demo",
    from: { kind: "git", url: "https://x/y.git", commit: COMMIT, subpath: null },
    hash: HASH,
  },
  { kind: "adoptMove", skill: "demo", from: at, hash: HASH },
  { kind: "trashDuplicate", skill: "demo", from: at, hash: HASH },
  { kind: "link", slot, skill: "demo" },
  { kind: "copy", slot, skill: "demo", hash: HASH },
  { kind: "projectCopy", slot, skill: "demo", hash: HASH },
  { kind: "libraryTrash", skill: "demo", expect: HASH },
]);

function planWith(steps: readonly Step[], notDone: readonly NotDone[] = []): Plan {
  return fake<Plan>({ intent: { kind: "sync", skills: "all" }, steps, notDone, fingerprint: HASH });
}

function conflictWith(observed: Observed): NotDone {
  const entry = fake<Entry>({ ...at, verdict: "conflict", observed, desired: null });
  return { kind: "conflict", entry };
}

const NOT_DONE_ITEMS = fake<readonly Exclude<NotDone, { kind: "needsChoice" }>[]>([
  conflictWith(fake<Observed>({ kind: "skillDir", hash: HASH, declaredName: null })),
  { kind: "libraryMissing", skill: "demo" },
  { kind: "differsFromLibrary", name: "demo", at },
  { kind: "locallyModified", skill: "demo" },
  { kind: "rootUnreadable", root: "/h/.roo/skills", error: "EACCES: permission denied" },
]);

describe("the app's vocabulary matches what the CLI prints", () => {
  it("uses the CLI's glyph for every verdict, in the CLI's order", () => {
    const snapshot = fake<Snapshot>({ agents: [], skills: [{ name: "demo", cells: [] }] });
    const legend = cli((render) => render.matrix(snapshot, null)).at(-1) ?? "";
    const printed = legend.split("  ").map((pair) => pair.split(" ").reverse());
    expect(Object.entries(GLYPH)).toEqual(printed);
    expect(GLYPH.extra).toBe("−");
  });

  it("pairs each step's user word with the verb the CLI prints for it", () => {
    expect(STEPS.map((step) => step.kind)).toEqual(Object.keys(STEP_WORD));
    const printed = cli((render) => render.plan(planWith(STEPS), false));
    expect(printed.map((line) => line.trim().split(/\s+/)[0])).toEqual(
      STEPS.map((step) => STEP_WORD[step.kind].cli),
    );
  });

  it("prints the CLI's summary line for an apply", () => {
    const [link] = STEPS.filter((step) => step.kind === "link");
    const results = fake<readonly StepResult[]>([
      { step: link, status: "done" },
      { step: link, status: "alreadyDone" },
      { step: link, status: "drifted", found: "a skill dir that is not gandalf's" },
      { step: link, status: "failed", reason: "io", error: "EACCES" },
      { step: link, status: "skipped", after: 2 },
      { step: link, status: "done" },
    ]);
    const outcome: ApplyOutcome = { kind: "applied", results };
    const printed = cli((render) => render.applied(planWith([]), outcome));
    expect(printed[results.length]).toBe(summaryLine(results));
    expect(summaryLine(results)).toBe("2 done, 1 already done, 1 drifted, 1 failed, 1 skipped");
  });

  it("knows every reason kind the CLI labels, under the CLI's label", () => {
    const kinds = Object.keys(NOT_DONE).filter((kind) => kind !== "needsChoice");
    expect(NOT_DONE_ITEMS.map((item) => item.kind)).toEqual(kinds);
    const printed = cli((render) => render.plan(planWith([], NOT_DONE_ITEMS), false));
    expect(printed[0]).toBe("not doing");
    expect(printed.slice(1).map((line) => line.trim().split(/\s+/)[0])).toEqual(
      NOT_DONE_ITEMS.map((item) => NOT_DONE[item.kind].cli),
    );
  });
});

describe("tilde", () => {
  it("writes the home directory and paths under it with ~", () => {
    expect(tilde("/h", HOME)).toBe("~");
    expect(tilde("/h/.cursor/skills", HOME)).toBe("~/.cursor/skills");
  });

  it("keeps a path outside the home directory whole, even one that shares its prefix", () => {
    expect(tilde("/hx/state.json", HOME)).toBe("/hx/state.json");
    expect(tilde("/elsewhere", HOME)).toBe("/elsewhere");
  });

  it("writes ~ in the path of a file:// URL, and leaves other URLs whole", () => {
    expect(tilde("file:///h/review.git", HOME)).toBe("file://~/review.git");
    expect(tilde("file:///hx/review.git", HOME)).toBe("file:///hx/review.git");
    expect(tilde("https://example.invalid/h/x.git", HOME)).toBe("https://example.invalid/h/x.git");
  });

  it("writes ~ for a home reached through a symlink, either way", () => {
    const homes = { home: "/var/t/h", realHome: "/private/var/t/h" };
    expect(tilde("/var/t/h/src/a", homes)).toBe("~/src/a");
    expect(tilde("/private/var/t/h/src/a", homes)).toBe("~/src/a");
    expect(tilde("/private/var/t/hx", homes)).toBe("/private/var/t/hx");
  });
});

describe("tildeAll", () => {
  const homes = { home: "/var/t/h", realHome: "/private/var/t/h" };

  it("writes ~ for every home path in git's message, as either spelling", () => {
    expect(
      tildeAll(
        "fatal: '/var/t/h/nowhere.git' does not appear to be a git repository; see /private/var/t/h",
        homes,
      ),
    ).toBe("fatal: '~/nowhere.git' does not appear to be a git repository; see ~");
  });

  it("leaves a path that only contains the home path, or extends its last name, alone", () => {
    expect(tildeAll("/x/var/t/h/a and /var/t/hx", homes)).toBe("/x/var/t/h/a and /var/t/hx");
  });
});

const NAMES: Names = namesOf(
  fake<Snapshot>({
    libraryDir: "/h/.gandalf/skills",
    agents: [
      { id: "cursor", displayName: "Cursor", installed: true, readError: null },
      { id: "codex", displayName: "Codex", installed: true, readError: null },
      { id: "github_copilot", displayName: "GitHub Copilot", installed: true, readError: null },
    ],
    roots: [
      { path: "/h/.cursor/skills", targets: ["cursor"] },
      { path: "/h/.agents/skills", targets: ["codex", "github_copilot"] },
    ],
  }),
  HOME,
);

describe("stepSentence on fixed steps", () => {
  it("leads every step with its user word, never the CLI verb", () => {
    expect(STEPS.map((step) => stepSentence(step, NAMES))).toEqual([
      "Remove demo from Cursor",
      "Move gandalf's copy of demo in Cursor to the Trash",
      "Move gandalf's copy of demo in Cursor to the Trash",
      "Update demo in the library from ~/src/demo",
      "Save",
      "Create the skills folder for Cursor",
      `Add demo to the library from https://x/y.git@${COMMIT.slice(0, 12)}`,
      "Move demo from ~/.codex/skills into the library",
      "Move the copy of demo in ~/.codex/skills that matches the library to the Trash",
      "Link demo into Cursor",
      "Copy demo into Cursor",
      "Copy demo into Cursor",
      "Move demo in the library to the Trash",
    ]);
    for (const step of STEPS) {
      const words = STEP_WORD[step.kind].app.split(" ");
      expect(stepSentence(step, NAMES)).toMatch(new RegExp(`^${words.join(" (?:.* )?")}\\b`));
    }
  });

  it("names the agents whose folder a step writes", () => {
    const shared = { root: "/h/.agents/skills", name: "demo" };
    expect(stepSentence(fake<Step>({ kind: "unlink", slot: shared, skill: "demo" }), NAMES)).toBe(
      "Remove demo from Codex and GitHub Copilot",
    );
    expect(stepSentence(fake<Step>({ kind: "trashCopy", slot, hash: HASH }), NAMES)).toBe(
      "Move gandalf's copy of demo in Cursor to the Trash",
    );
  });

  it("names a folder no agent targets by its path", () => {
    const loose = { root: "/h/.loose/skills", name: "demo" };
    expect(stepSentence(fake<Step>({ kind: "copy", slot: loose, skill: "demo" }), NAMES)).toBe(
      "Copy demo into ~/.loose/skills",
    );
  });
});

describe("the reasons a plan leaves something undone", () => {
  it("says what happened and what you can do, under Conflict, Blocked or Not managed", () => {
    const reasons = NOT_DONE_ITEMS.map((item) => [
      NOT_DONE[item.kind].verdict,
      notDoneReason(item, NAMES),
    ]);
    expect(reasons).toEqual([
      [
        "conflict",
        "A skill you placed there uses this name. gandalf never replaces it. Rename or move it, then Sync.",
      ],
      [
        "blocked",
        "The library folder for demo is missing. Reinstall demo or remove it from gandalf.",
      ],
      [
        "unmanaged",
        "~/.codex/skills keeps its own version of demo. gandalf does not replace a skill you placed. To use the library's version there, remove this copy, then Sync.",
      ],
      [
        "conflict",
        "You edited demo in the library. gandalf never updates over your edits. Copy your edits elsewhere, then update demo again.",
      ],
      [
        "blocked",
        "gandalf cannot read this folder (EACCES: permission denied). Check its permissions, then Sync.",
      ],
    ]);
  });

  it("tells your edits in gandalf's copy from a link you made", () => {
    const edited = conflictWith(
      fake<Observed>({ kind: "modifiedCopy", skill: "demo", recorded: HASH, actual: HASH }),
    );
    expect(notDoneReason(edited, NAMES)).toBe(
      "You edited gandalf's copy here. gandalf leaves it alone. Move your edits into the library, then Sync.",
    );
    const broken = conflictWith(
      fake<Observed>({ kind: "foreignLink", target: "/h/elsewhere/demo", resolves: false }),
    );
    expect(notDoneReason(broken, NAMES)).toBe(
      "A broken link you made there points to ~/elsewhere/demo. gandalf never replaces it. Remove the link, then Sync.",
    );
  });
});

describe("what Discover and the sheet say about copies adopt leaves in place", () => {
  it("shows a waiting choice and an unpicked copy as Not managed, with why", () => {
    const variants = [HASH, HASH].map((hash) => ({ hash, at: [at] }));
    const waiting = fake<NotDone>({ kind: "needsChoice", name: "review", variants });
    expect([NOT_DONE.needsChoice.verdict, notDoneReason(waiting, NAMES)]).toEqual([
      "unmanaged",
      "The 2 versions of review differ, so this change leaves its copies where they are.",
    ]);
    const unpicked = fake<NotDone>({ kind: "differsFromLibrary", name: "review", at });
    expect([NOT_DONE.differsFromLibrary.verdict, notDoneReason(unpicked, NAMES)]).toEqual([
      "unmanaged",
      "~/.codex/skills keeps its own version of review. gandalf does not replace a skill you placed. To use the library's version there, remove this copy, then Sync.",
    ]);
  });

  it("names a file and a folder without SKILL.md alike, since the core does not tell them apart", () => {
    expect(cannotAdoptReason(fake<Observed>({ kind: "other" }), NAMES)).toBe(
      "It is a file, or a folder with no SKILL.md, so it is not a skill. gandalf leaves it alone.",
    );
  });
});

describe("planRefusal", () => {
  it("uses user words and agent display names, and says what to do next", () => {
    const refusals = fake<readonly PlanError[]>([
      { kind: "agentNotInstalled", agent: "github_copilot" },
      { kind: "nothingToAdopt", name: "demo" },
    ]).map((error) => planRefusal(error, NAMES));
    expect(refusals).toEqual([
      {
        what: "GitHub Copilot is not installed.",
        next: "Install GitHub Copilot, then try again.",
      },
      {
        what: "gandalf found no skill you placed named demo.",
        next: "Place the skill's folder in an agent's skills folder, then try again.",
      },
    ]);
  });

  it("says an update's branch or tag is gone, not to choose a folder", () => {
    const update = fake<Intent>({ kind: "update", skills: ["review"], pins: [] });
    const gone = planRefusal(
      { kind: "badSource", reason: "fatal: couldn't find remote ref release" },
      NAMES,
      update,
    );
    expect(gone).toEqual({
      what: "The branch or tag this skill follows is gone from its repository.",
      next: "Install the skill again from a branch or tag that exists, or remove it.",
    });
    const unreachable = planRefusal(
      {
        kind: "badSource",
        reason: "fatal: '/h/review.git' does not appear to be a git repository",
      },
      NAMES,
      update,
    );
    expect(unreachable.what).toBe(
      "gandalf could not fetch the update (fatal: '~/review.git' does not appear to be a git repository).",
    );
    expect(`${gone.what} ${unreachable.next}`).not.toContain("SKILL.md");
  });
});

describe("busyText", () => {
  it("names the holder's process and when it started, without repeating the banner title", () => {
    const since = "2026-10-24T09:00:00.000Z";
    const time = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" });
    const text = busyText(fake({ pid: 4242, since }));
    expect(text).toBe(`Process 4242 has been applying since ${time.format(new Date(since))}.`);
    expect(text).not.toContain("Another gandalf");
  });
});

const DEMO = "demo" as SkillName;

/** A temp HOME with Cursor and Claude Code installed and demo in the library, on for Claude Code. */
async function demoHome() {
  const home = (await tempHome()) as AbsPath;
  await mkdir(`${home}/.cursor`, { recursive: true });
  await mkdir(`${home}/.claude`, { recursive: true });
  await writeSkill(`${home}/src/demo`, "demo");
  const env = testEnv(home);
  await run(env, {
    kind: "install",
    source: { kind: "local", path: `${home}/src/demo` as AbsPath },
    agents: ["claude_code"],
  });
  const gandalf = openGandalf(env);
  const names = namesOf(await gandalf.snapshot(), home);
  const plan = async (intent: Intent) => {
    const outcome = await gandalf.plan(intent);
    if (!outcome.ok) throw new Error(`plan refused: ${outcome.error.kind}`);
    return outcome.plan;
  };
  const sentences = async (intent: Intent) =>
    (await plan(intent)).steps.map((step) => stepSentence(step, names));
  return { home, env, gandalf, names, plan, sentences };
}

describe("sentences for real plans", () => {
  it("turns demo on for Cursor", async () => {
    const { names, plan, sentences } = await demoHome();
    const intent: Intent = { kind: "setEnabled", skill: DEMO, enabled: true, agents: ["cursor"] };
    expect(intentTitle((await plan(intent)).intent, names)).toBe("Turn on demo for Cursor");
    expect(await sentences(intent)).toEqual([
      "Save demo as on for Cursor and Claude Code",
      "Create the skills folder for Cursor",
      "Link demo into Cursor",
    ]);
  });

  it("turns demo off for the only agent it is on for", async () => {
    const { sentences } = await demoHome();
    expect(
      await sentences({
        kind: "setEnabled",
        skill: DEMO,
        enabled: false,
        agents: ["claude_code"],
      }),
    ).toEqual(["Remove demo from Claude Code", "Save demo as off for all agents"]);
  });

  it("says only when demo is on for some of the installed agents", async () => {
    const { env, sentences } = await demoHome();
    await run(env, { kind: "setEnabled", skill: DEMO, enabled: true, agents: "all" });
    expect(
      await sentences({ kind: "setEnabled", skill: DEMO, enabled: false, agents: ["cursor"] }),
    ).toEqual(["Remove demo from Cursor", "Save demo as on for Claude Code only"]);
  });

  it("turns demo on for all agents and names the sync", async () => {
    const { home, names, plan, sentences } = await demoHome();
    expect(
      await sentences({ kind: "setEnabled", skill: DEMO, enabled: true, agents: "all" }),
    ).toEqual([
      "Save demo as on for all agents",
      "Create the skills folder for Cursor",
      "Link demo into Cursor",
    ]);
    await rm(`${home}/.claude/skills/demo`);
    const sync = await plan({ kind: "sync", skills: "all" });
    expect(intentTitle(sync.intent, names)).toBe("Sync all skills");
    expect(sync.steps.map((step) => stepSentence(step, names))).toEqual([
      "Link demo into Claude Code",
    ]);
  });
});

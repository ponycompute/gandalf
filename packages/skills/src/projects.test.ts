import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { COPY_MARKER, contentHash, serializeMarker } from "./disk.js";
import { nodeFs } from "./env.js";
import { openGandalf } from "./gandalf.js";
import {
  at,
  recordedState,
  run,
  seedState,
  tempHome,
  testEnv,
  treeOf,
  writeSkill,
  writeTree,
} from "./testkit.js";
import type { AbsPath, AgentId, Intent, IsoTime, Plan, SkillName, Step } from "./types.js";

const pdf = "pdf" as SkillName;
const kinds = (steps: readonly Step[]) => steps.map((step) => step.kind);

/**
 * Claude Code and Codex are installed. pdf is in the library, tracked and off for every agent, so
 * only projects get it. The project is <home>/work/api.
 */
async function seedHome(): Promise<{ home: AbsPath; project: AbsPath }> {
  const home = await tempHome();
  await writeTree(home, { ".claude/settings.json": "{}", ".codex/config.toml": "" });
  await writeSkill(at(home, ".gandalf/skills/pdf"), "pdf", { "tool.sh": "echo pdf\n" });
  await seedState(home, {
    skills: {
      [pdf]: {
        source: { kind: "local", path: null, hash: null },
        installedAt: "2026-10-01T00:00:00.000Z" as IsoTime,
        enabled: { default: false, except: [] },
      },
    },
  });
  const project = at(home, "work/api");
  await writeTree(project, { "README.md": "api\n" });
  return { home, project };
}

async function planOf(home: AbsPath, intent: Intent): Promise<Plan> {
  const outcome = await openGandalf(testEnv(home)).plan(intent);
  if (!outcome.ok) throw new Error(outcome.error.kind);
  return outcome.plan;
}

async function stateOf(home: AbsPath) {
  return recordedState(home);
}

const register = (project: AbsPath, agents: readonly AgentId[]): Intent => ({
  kind: "configureProject",
  path: project,
  agents,
});
const turn = (project: AbsPath, enabled: boolean): Intent => ({
  kind: "setProjectSkills",
  project,
  skills: [pdf],
  enabled,
});

describe("projects", () => {
  it("copies a project's skills into each agent's project dir, once per shared dir, unmarked", async () => {
    const { home, project } = await seedHome();
    // Goose is not installed here: a project's copies are for whoever opens it.
    await run(testEnv(home), register(project, ["claude_code", "codex", "goose"]));
    const plan = await planOf(home, turn(project, true));
    expect(kinds(plan.steps)).toEqual([
      "commitState",
      "ensureDir",
      "ensureDir",
      "projectCopy",
      "projectCopy",
    ]);
    await run(testEnv(home), plan.intent);

    const library = await contentHash(nodeFs, at(home, ".gandalf/skills/pdf"));
    for (const dir of [".claude/skills", ".agents/skills"]) {
      expect(await readdir(at(project, `${dir}/pdf`))).toEqual(["SKILL.md", "tool.sh"]);
      expect(await contentHash(nodeFs, at(project, `${dir}/pdf`))).toBe(library);
    }
    expect((await stateOf(home)).projects[project]).toEqual({
      agents: ["claude_code", "codex", "goose"],
      skills: ["pdf"],
      copies: {
        [at(project, ".agents/skills/pdf")]: { skill: "pdf", hash: library },
        [at(project, ".claude/skills/pdf")]: { skill: "pdf", hash: library },
      },
    });
    await expect(readdir(at(home, ".claude/skills"))).rejects.toThrow();

    const snapshot = await openGandalf(testEnv(home)).snapshot();
    expect(snapshot.projects).toEqual([
      {
        path: project,
        agents: ["claude_code", "codex", "goose"],
        skills: ["pdf"],
        readError: null,
      },
    ]);
    expect(
      snapshot.entries
        .filter((entry) => entry.project === project)
        .map((entry) => [entry.path, entry.verdict, entry.observed.kind]),
    ).toEqual([
      [at(project, ".agents/skills/pdf"), "ok", "cleanCopy"],
      [at(project, ".claude/skills/pdf"), "ok", "cleanCopy"],
    ]);
    expect(snapshot.problems).toEqual([]);
    expect((await planOf(home, { kind: "sync", skills: "all" })).steps).toEqual([]);
  });

  it("carries a library edit into the project's copies", async () => {
    const { home, project } = await seedHome();
    await run(testEnv(home), register(project, ["claude_code"]));
    await run(testEnv(home), turn(project, true));
    await writeFile(at(home, ".gandalf/skills/pdf/tool.sh"), "echo pdf v2\n");
    const plan = await planOf(home, { kind: "sync", skills: "all" });
    expect(kinds(plan.steps)).toEqual(["trashProjectCopy", "commitState", "projectCopy"]);
    await run(testEnv(home), plan.intent);
    expect(await readFile(at(project, ".claude/skills/pdf/tool.sh"), "utf8")).toBe("echo pdf v2\n");
    expect(
      (await stateOf(home)).projects[project].copies[at(project, ".claude/skills/pdf")],
    ).toEqual({ skill: "pdf", hash: await contentHash(nodeFs, at(home, ".gandalf/skills/pdf")) });
  });

  it("never claims a teammate's dir, a dir carrying a marker, or a copy edited since", async () => {
    const { home, project } = await seedHome();
    const library = await contentHash(nodeFs, at(home, ".gandalf/skills/pdf"));
    // Committed by a teammate: the same bytes, but no record of gandalf placing it here.
    await writeSkill(at(project, ".claude/skills/pdf"), "pdf", { "tool.sh": "echo pdf\n" });
    // A marker means nothing in a project.
    await writeSkill(at(project, ".claude/skills/marked"), "marked");
    const marked = await contentHash(nodeFs, at(project, ".claude/skills/marked"));
    await writeFile(
      at(project, `.claude/skills/marked/${COPY_MARKER}`),
      serializeMarker({ skill: "marked" as SkillName, hash: marked }),
    );
    await run(testEnv(home), register(project, ["claude_code", "codex"]));
    const plan = await planOf(home, turn(project, true));
    expect(kinds(plan.steps)).toEqual(["commitState", "ensureDir", "projectCopy"]);
    expect(plan.notDone).toMatchObject([
      {
        kind: "conflict",
        entry: {
          path: at(project, ".claude/skills/pdf"),
          observed: { kind: "skillDir", hash: library },
        },
      },
    ]);
    await run(testEnv(home), plan.intent);

    await writeFile(at(project, ".agents/skills/pdf/tool.sh"), "echo edited\n");
    const off = await planOf(home, turn(project, false));
    expect(kinds(off.steps)).toEqual(["commitState"]);
    await run(testEnv(home), off.intent);
    expect(await readFile(at(project, ".agents/skills/pdf/tool.sh"), "utf8")).toBe("echo edited\n");
    expect(await readdir(at(project, ".claude/skills"))).toEqual(["marked", "pdf"]);
    const snapshot = await openGandalf(testEnv(home)).snapshot();
    expect(snapshot.problems.map((problem) => problem.kind)).toEqual(["modifiedCopy"]);
  });

  it("trashes a copy turned off or an agent dropped, and keeps the copies of a forgotten project", async () => {
    const { home, project } = await seedHome();
    await run(testEnv(home), register(project, ["claude_code", "codex"]));
    await run(testEnv(home), turn(project, true));

    const drop = await planOf(home, register(project, ["claude_code"]));
    expect(kinds(drop.steps)).toEqual(["trashProjectCopy", "commitState"]);
    await run(testEnv(home), drop.intent);
    expect(await readdir(at(project, ".agents/skills"))).toEqual([]);
    expect(Object.keys((await stateOf(home)).projects[project].copies)).toEqual([
      at(project, ".claude/skills/pdf"),
    ]);

    const forget = await planOf(home, { kind: "removeProject", path: project });
    expect(kinds(forget.steps)).toEqual(["commitState"]);
    await run(testEnv(home), forget.intent);
    expect(await readdir(at(project, ".claude/skills"))).toEqual(["pdf"]);
    expect((await stateOf(home)).projects).toBeUndefined();
    const snapshot = await openGandalf(testEnv(home)).snapshot();
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.entries.filter((entry) => entry.path.startsWith(project))).toEqual([]);
  });

  it("turning a skill off trashes its copies and forgets them", async () => {
    const { home, project } = await seedHome();
    await run(testEnv(home), register(project, ["claude_code"]));
    await run(testEnv(home), turn(project, true));
    const plan = await planOf(home, turn(project, false));
    expect(kinds(plan.steps)).toEqual(["trashProjectCopy", "commitState"]);
    await run(testEnv(home), plan.intent);
    expect(await readdir(at(project, ".claude/skills"))).toEqual([]);
    expect((await stateOf(home)).projects[project]).toEqual({
      agents: ["claude_code"],
      skills: [],
      copies: {},
    });
  });

  it("takes a removed skill out of every project", async () => {
    const { home, project } = await seedHome();
    await run(testEnv(home), register(project, ["claude_code"]));
    await run(testEnv(home), turn(project, true));
    await run(testEnv(home), { kind: "remove", skill: pdf });
    expect(await readdir(at(project, ".claude/skills"))).toEqual([]);
    expect((await stateOf(home)).projects[project].skills).toEqual([]);
  });

  it("tracks a library skill nothing tracked yet, off for every agent", async () => {
    const { home, project } = await seedHome();
    await writeSkill(at(home, ".gandalf/skills/notes"), "notes");
    await run(testEnv(home), register(project, ["claude_code"]));
    await run(testEnv(home), {
      kind: "setProjectSkills",
      project,
      skills: ["notes" as SkillName],
      enabled: true,
    });
    expect((await stateOf(home)).skills.notes).toMatchObject({
      source: { kind: "local", path: null, hash: null },
      enabled: { default: false, except: [] },
    });
    expect(await readdir(at(project, ".claude/skills"))).toEqual(["notes"]);
  });

  it("refuses HOME as a project, an agent without a project dir, and unknown projects and skills", async () => {
    const { home, project } = await seedHome();
    const gandalf = openGandalf(testEnv(home));
    expect(await gandalf.plan(register(home, ["claude_code"]))).toEqual({
      ok: false,
      error: {
        kind: "projectOverlaps",
        path: home,
        agent: "claude_code",
        dir: at(home, ".claude/skills"),
      },
    });
    expect(await gandalf.plan(register(project, ["kilo_code"]))).toEqual({
      ok: false,
      error: { kind: "noProjectDir", agent: "kilo_code" },
    });
    expect(await gandalf.plan({ kind: "removeProject", path: project })).toEqual({
      ok: false,
      error: { kind: "unknownProject", path: project },
    });
    await run(testEnv(home), register(project, ["claude_code"]));
    expect(
      await gandalf.plan({
        kind: "setProjectSkills",
        project,
        skills: ["nope" as SkillName],
        enabled: true,
      }),
    ).toEqual({ ok: false, error: { kind: "unknownSkill", skill: "nope" } });
  });

  it("does not recreate a project folder that is gone", async () => {
    const { home, project } = await seedHome();
    await run(testEnv(home), register(project, ["claude_code"]));
    await run(testEnv(home), turn(project, true));
    await rm(project, { recursive: true });
    const plan = await planOf(home, { kind: "sync", skills: "all" });
    expect(plan.steps).toEqual([]);
    expect(plan.notDone).toEqual([
      {
        kind: "rootUnreadable",
        root: at(project, ".claude/skills"),
        error: "the project folder is missing",
      },
    ]);
    const snapshot = await openGandalf(testEnv(home)).snapshot();
    expect(snapshot.projects[0]?.readError).toBe("the project folder is missing");
  });
});

describe("project plans converge after a crash at any mutation", () => {
  /** The project is registered for Claude Code and Codex, and pdf is already copied into both. */
  async function seedCopied(): Promise<{ home: AbsPath; project: AbsPath }> {
    const seeded = await seedHome();
    await run(testEnv(seeded.home), register(seeded.project, ["claude_code", "codex"]));
    await run(testEnv(seeded.home), turn(seeded.project, true));
    return seeded;
  }

  const scenarios: Record<
    string,
    {
      readonly seed: () => Promise<{ home: AbsPath; project: AbsPath }>;
      readonly intent: (project: AbsPath) => Intent;
    }
  > = {
    "turn pdf on": {
      seed: async () => {
        const seeded = await seedHome();
        await run(testEnv(seeded.home), register(seeded.project, ["claude_code", "codex"]));
        return seeded;
      },
      intent: (project) => turn(project, true),
    },
    "turn pdf off": { seed: seedCopied, intent: (project) => turn(project, false) },
    "drop codex": { seed: seedCopied, intent: (project) => register(project, ["claude_code"]) },
  };

  it.each(Object.entries(scenarios))("%s", async (_name, scenario) => {
    const reference = await scenario.seed();
    const counter = { n: 0 };
    await run(testEnv(reference.home, { counter }), scenario.intent(reference.project));
    const expected = await treeOf(reference.home);
    expect(counter.n).toBeGreaterThan(2);

    for (let n = 1; n <= counter.n; n += 1) {
      const { home, project } = await scenario.seed();
      const intent = scenario.intent(project);
      await expect(run(testEnv(home, { crashAt: n, pid: 1 }), intent)).rejects.toThrow(
        "SimulatedCrash",
      );
      // pid 1 is dead from here on, so the lock it left behind is stale.
      await run(testEnv(home, { pid: 2 }), intent);
      expect(await treeOf(home), `crash before mutation ${n}`).toEqual(expected);
    }
  });
});

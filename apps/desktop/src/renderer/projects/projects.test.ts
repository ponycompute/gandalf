import {
  openGandalf,
  type AbsPath,
  type IsoTime,
  type SkillName,
  type Snapshot,
} from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import {
  at,
  run,
  seedState,
  tempHome,
  testEnv,
  writeSkill,
  writeTree,
} from "../../../../../packages/skills/src/testkit";
import { namesOf } from "../vocabulary";
import { defaultAgents, projectAgents, projectModels, toggleAgent } from "./model";

const pdf = "pdf" as SkillName;
const csv = "csv" as SkillName;

/** Claude Code and Codex are installed; pdf and csv are in the library; work/api is a project. */
async function seedHome(): Promise<{ home: AbsPath; project: AbsPath }> {
  const home = await tempHome();
  await writeTree(home, { ".claude/settings.json": "{}", ".codex/config.toml": "" });
  const tracked = {
    source: { kind: "local", path: null },
    installedAt: "2026-10-01T00:00:00.000Z" as IsoTime,
    enabled: { default: false, except: [] },
  } as const;
  for (const name of [pdf, csv]) await writeSkill(at(home, `.gandalf/skills/${name}`), name);
  await seedState(home, { skills: { [pdf]: tracked, [csv]: tracked } });
  const project = at(home, "work/api");
  await writeTree(project, { "README.md": "api\n" });
  return { home, project };
}

const snapshotOf = (home: AbsPath): Promise<Snapshot> => openGandalf(testEnv(home)).snapshot();

describe("projectModels", () => {
  it("shows a shared project folder once, with a copied mark per skill", async () => {
    // Columns follow the roots' order, which is by path: .agents/skills before .claude/skills.
    const { home, project } = await seedHome();
    await run(testEnv(home), {
      kind: "configureProject",
      path: project,
      agents: ["claude_code", "codex", "goose"],
    });
    await run(testEnv(home), {
      kind: "setProjectSkills",
      project,
      skills: [pdf],
      enabled: true,
    });
    const snapshot = await snapshotOf(home);
    const [model] = projectModels(snapshot);
    expect(model?.columns.map((column) => column.agents)).toEqual([
      ["codex", "goose"],
      ["claude_code"],
    ]);
    expect(model?.rows).toEqual([
      {
        skill: pdf,
        cells: model?.columns.map((column) => ({ root: column.root, verdict: "ok" })),
      },
    ]);
    expect(model?.addable).toEqual([csv]);
    const names = namesOf(snapshot, home);
    expect(names.folder(model?.columns[0]?.root ?? "")).toBe("Codex and Goose in api");
  });

  it("offers every agent with a project folder, and starts a project with the installed ones", async () => {
    const { home } = await seedHome();
    const snapshot = await snapshotOf(home);
    expect(projectAgents(snapshot).map((agent) => agent.id)).not.toContain("kilo_code");
    expect(defaultAgents(snapshot)).toEqual(["claude_code", "codex"]);
  });

  it("turns one agent on or off and keeps the rest in registry order", async () => {
    const { home, project } = await seedHome();
    await run(testEnv(home), { kind: "configureProject", path: project, agents: ["codex"] });
    const snapshot = await snapshotOf(home);
    const view = snapshot.projects[0];
    if (view === undefined) throw new Error("no project");
    expect(toggleAgent(snapshot, view, "claude_code", true)).toEqual({
      kind: "configureProject",
      path: project,
      agents: ["claude_code", "codex"],
    });
    expect(toggleAgent(snapshot, view, "codex", false)).toEqual({
      kind: "configureProject",
      path: project,
      agents: [],
    });
  });
});

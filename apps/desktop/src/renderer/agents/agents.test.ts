import { mkdir } from "node:fs/promises";
import { openGandalf, type AbsPath, type AgentId, type Snapshot } from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import { run, tempHome, testEnv } from "../../../../../packages/skills/src/testkit";
import { agentReadError, namesOf } from "../vocabulary";
import { agentRows, configure, insideGandalf, readersLine, skillsOn, type AgentRow } from "./model";

async function homeWith(...dirs: readonly string[]): Promise<AbsPath> {
  const home = (await tempHome()) as AbsPath;
  for (const dir of dirs) await mkdir(`${home}/${dir}`, { recursive: true });
  return home;
}

const snapshotOf = (home: AbsPath): Promise<Snapshot> => openGandalf(testEnv(home)).snapshot();

function rowOf(rows: readonly AgentRow[], id: AgentId): AgentRow {
  const row = rows.find((candidate) => candidate.agent.id === id);
  if (row === undefined) throw new Error(`no row for ${id}`);
  return row;
}

describe("agentRows", () => {
  it("lists every agent in registry order, installed or not", async () => {
    const home = await homeWith(".cursor", ".claude");
    const snapshot = await snapshotOf(home);
    const rows = agentRows(snapshot);
    expect(rows.map((row) => row.agent.id)).toEqual(snapshot.agents.map((agent) => agent.id));
    expect(rows).toHaveLength(14);
    expect(rowOf(rows, "cursor").actionable).toBe(true);
  });

  it("names Codex and GitHub Copilot as the readers of ~/.agents/skills", async () => {
    const home = await homeWith(".codex", ".copilot", ".agents/skills");
    const snapshot = await snapshotOf(home);
    const names = namesOf(snapshot, home);
    const codex = rowOf(agentRows(snapshot), "codex");
    const shared = codex.scanFolders.find((folder) => folder.path.endsWith("/.agents/skills"));
    expect(shared).toBeDefined();
    expect(readersLine(shared ?? { path: "", readers: [] }, names)).toBe(
      "Read by Codex and GitHub Copilot",
    );
    expect(readersLine(codex.skillsFolder, names)).toBeNull();
  });

  it("offers no actions for an agent that is not installed", async () => {
    const home = await homeWith(".cursor");
    const goose = rowOf(agentRows(await snapshotOf(home)), "goose");
    expect(goose.actionable).toBe(false);
    expect(goose.skillsFolder.readers).toEqual([]);
  });

  it("names both agents pointed at one folder as its readers", async () => {
    const home = await homeWith(".cursor", ".claude", "shared");
    await run(
      testEnv(home),
      configure(rowOf(agentRows(await snapshotOf(home)), "cursor").agent, {
        skillsDir: `${home}/shared`,
      }),
    );
    await run(
      testEnv(home),
      configure(rowOf(agentRows(await snapshotOf(home)), "claude_code").agent, {
        skillsDir: `${home}/shared`,
      }),
    );
    const snapshot = await snapshotOf(home);
    const names = namesOf(snapshot, home);
    const rows = agentRows(snapshot);
    for (const id of ["cursor", "claude_code"] as const) {
      expect(readersLine(rowOf(rows, id).skillsFolder, names)).toBe(
        "Read by Cursor and Claude Code",
      );
    }
  });
});

describe("configure", () => {
  it("keeps the mode when the folder changes, and the folder when the mode changes", async () => {
    const home = await homeWith(".cursor", "elsewhere");
    const cursor = () => snapshotOf(home).then((s) => rowOf(agentRows(s), "cursor").agent);
    await run(testEnv(home), configure(await cursor(), { mode: "copy" }));
    expect(configure(await cursor(), { skillsDir: `${home}/elsewhere` })).toEqual({
      kind: "configureAgent",
      agent: "cursor",
      skillsDir: `${home}/elsewhere`,
      mode: "copy",
    });
    await run(testEnv(home), configure(await cursor(), { skillsDir: `${home}/elsewhere` }));
    expect(configure(await cursor(), { mode: "auto" })).toEqual({
      kind: "configureAgent",
      agent: "cursor",
      skillsDir: `${home}/elsewhere`,
      mode: null,
    });
    expect(configure(await cursor(), "reset")).toEqual({
      kind: "configureAgent",
      agent: "cursor",
      skillsDir: null,
      mode: null,
    });
  });

  it("leaves the built-in folder unset when only the mode is overridden", async () => {
    const home = await homeWith(".cursor");
    const cursor = rowOf(agentRows(await snapshotOf(home)), "cursor").agent;
    expect(configure(cursor, { mode: "link" })).toMatchObject({ skillsDir: null, mode: "link" });
  });
});

describe("insideGandalf", () => {
  it("is true for gandalf's folder and anything in it, and false for a sibling", () => {
    expect(insideGandalf("/h/.gandalf", "/h/.gandalf")).toBe(true);
    expect(insideGandalf("/h/.gandalf/skills", "/h/.gandalf")).toBe(true);
    expect(insideGandalf("/h/.gandalf-other", "/h/.gandalf")).toBe(false);
  });
});

describe("agentReadError", () => {
  it("says what stops gandalf reading a folder, in words, and what to do", async () => {
    const home = await homeWith(".cursor");
    const names = namesOf(await snapshotOf(home), home);
    expect(agentReadError("EACCES", names)).toBe(
      "gandalf is not allowed to read this folder. Allow reading it in Finder, or choose another folder.",
    );
    expect(agentReadError("skills dir is inside ~/.gandalf", names)).toBe(
      "This folder is inside ~/.gandalf, where gandalf keeps the library. Choose a folder outside it.",
    );
    expect(agentReadError("EIO", names)).toBe(
      "gandalf cannot read this folder (EIO). Choose another folder.",
    );
  });
});

describe("skillsOn", () => {
  it("counts the library skills an agent has on", async () => {
    const home = await homeWith(".cursor", ".claude");
    const snapshot = await snapshotOf(home);
    const cell = (agent: AgentId, enabled: boolean) => ({ agent, enabled, verdict: "ok" as const });
    const skills = [
      {
        ...snapshot.skills[0],
        name: "a",
        cells: [cell("cursor", true), cell("claude_code", false)],
      },
      {
        ...snapshot.skills[0],
        name: "b",
        cells: [cell("cursor", true), cell("claude_code", true)],
      },
    ] as unknown as Snapshot["skills"];
    const withSkills = { ...snapshot, skills };
    expect(skillsOn(withSkills, "cursor")).toBe(2);
    expect(skillsOn(withSkills, "claude_code")).toBe(1);
    expect(skillsOn(withSkills, "goose")).toBe(0);
  });
});

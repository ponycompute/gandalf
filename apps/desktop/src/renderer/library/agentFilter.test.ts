import { rm } from "node:fs/promises";
import { nodeEnv, openGandalf, type AgentId, type Snapshot } from "@gandalf/skills";
import { afterEach, describe, expect, it } from "vitest";
import { seedHome, type Fixture } from "../../../e2e/homes";
import { currentFilter, filterChoices, ownFolder, skillsIn, unmanagedIn } from "./agentFilter";

let home = "";

afterEach(async () => {
  if (home !== "") await rm(home, { recursive: true, force: true });
  home = "";
});

async function snapshotOf(fixture: Fixture): Promise<Snapshot> {
  home = await seedHome(fixture);
  return openGandalf(nodeEnv({ home })).snapshot();
}

const claude = "claude_code" as AgentId;
const cursor = "cursor" as AgentId;

describe("the Library's agent filter", () => {
  it("counts each agent's skills and keeps only the ones turned on for it", async () => {
    const snapshot = await snapshotOf("twoAgents");
    // Registry order, as the rest of the app lists agents.
    expect(filterChoices(snapshot)).toEqual([
      { agent: cursor, count: 0 },
      { agent: claude, count: 1 },
    ]);
    expect(skillsIn(snapshot, claude).map((skill) => skill.name)).toEqual(["demo"]);
    expect(skillsIn(snapshot, cursor)).toEqual([]);
    expect(ownFolder(snapshot, cursor)).toBe(`${home}/.cursor/skills`);
  });

  it("forgets an agent the Library can no longer be filtered to", async () => {
    const snapshot = await snapshotOf("twoAgents");
    expect(currentFilter(snapshot, cursor)).toBe(cursor);
    expect(currentFilter(snapshot, "goose" as AgentId)).toBeNull();
    expect(currentFilter(snapshot, null)).toBeNull();
  });

  it("lists the skills you placed in the agent's own folders, less those whose copies differ", async () => {
    const snapshot = await snapshotOf("adoptChoice");
    const listed = (agent: AgentId) =>
      unmanagedIn(snapshot, agent).map(({ name, entry }) => [name, entry.path.slice(home.length)]);
    // review differs between the two, so the list shows it with Two versions instead.
    expect(listed(cursor)).toEqual([]);
    expect(listed(claude)).toEqual([["notes", "/.claude/skills/notes"]]);
  });
});

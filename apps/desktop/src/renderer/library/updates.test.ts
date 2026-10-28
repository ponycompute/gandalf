import { mkdir, writeFile } from "node:fs/promises";
import { openGandalf, type AbsPath, type Intent, type SkillName } from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import { run, tempHome, testEnv, writeSkill } from "../../../../../packages/skills/src/testkit";
import { updateFacts, updateTitle } from "../changes/UpdateSummary";
import { foundAfter, pendingUpdates, UPDATE_ALL, updatedBy, updateOne } from "./updates";

const demo = "demo" as SkillName;
const notes = "notes" as SkillName;

/** Cursor installed, with demo and notes installed from folders under ~/src and on for it. */
async function folderHome() {
  const home = (await tempHome()) as AbsPath;
  await mkdir(`${home}/.cursor`, { recursive: true });
  const env = testEnv(home);
  for (const name of [demo, notes]) {
    await writeSkill(`${home}/src/${name}`, name);
    await run(env, {
      kind: "install",
      source: { kind: "local", path: `${home}/src/${name}` as AbsPath },
      agents: "all",
    });
  }
  const gandalf = () => openGandalf(env);
  const plan = async (intent: Intent) => {
    const outcome = await gandalf().plan(intent);
    if (!outcome.ok) throw new Error(outcome.error.kind);
    return outcome.plan;
  };
  const change = (name: string) => writeFile(`${home}/src/${name}/SKILL.md`, `${name} v2\n`);
  return { home, env, gandalf, plan, change };
}

describe("updatedBy", () => {
  it("names the skills whose folder changed, and none on a home that is up to date", async () => {
    const { plan, change } = await folderHome();
    expect(updatedBy(await plan(UPDATE_ALL))).toEqual([]);
    await change(demo);
    expect(updatedBy(await plan(UPDATE_ALL))).toEqual([demo]);
  });
});

describe("foundAfter and pendingUpdates", () => {
  it("keeps a found skill pending until it is updated", async () => {
    const { env, gandalf, plan, change } = await folderHome();
    await change(demo);
    const found = foundAfter([], await plan(UPDATE_ALL), await gandalf().snapshot());
    expect(pendingUpdates(found, await gandalf().snapshot())).toEqual([demo]);
    await run(env, updateOne(demo));
    expect(pendingUpdates(found, await gandalf().snapshot())).toEqual([]);
  });

  it("lets a one-skill check answer for that skill alone", async () => {
    const { home, gandalf, plan, change } = await folderHome();
    await change(demo);
    await change(notes);
    const snapshot = await gandalf().snapshot();
    const both = foundAfter([], await plan(UPDATE_ALL), snapshot);
    expect(pendingUpdates(both, snapshot)).toEqual([demo, notes]);
    // notes' folder goes back to what the library took.
    await writeSkill(`${home}/src/notes`, notes);
    const after = foundAfter(both, await plan(updateOne(notes)), snapshot);
    expect(pendingUpdates(after, snapshot)).toEqual([demo]);
  });

  it("drops what an earlier check found once a full check finds nothing", async () => {
    const { home, gandalf, plan, change } = await folderHome();
    await change(demo);
    const snapshot = await gandalf().snapshot();
    const found = foundAfter([], await plan(UPDATE_ALL), snapshot);
    await writeSkill(`${home}/src/demo`, demo);
    expect(foundAfter(found, await plan(UPDATE_ALL), snapshot)).toEqual([]);
    expect(foundAfter(found, await plan({ kind: "sync", skills: "all" }), snapshot)).toBe(found);
  });
});

describe("updateFacts", () => {
  it("says what changed in each folder, and titles the sheet by the skills it updates", async () => {
    const { gandalf, plan, change } = await folderHome();
    await change(demo);
    await change(notes);
    const facts = updateFacts(await plan(UPDATE_ALL), await gandalf().snapshot());
    expect(facts).toMatchObject({ all: true, kept: [], agents: ["cursor"], copies: false });
    expect(facts?.skills.map((skill) => [skill.name, skill.after.kind])).toEqual([
      [demo, "local"],
      [notes, "local"],
    ]);
    expect(facts === null ? null : updateTitle(facts)).toBe("Update 2 skills?");
    const one = updateFacts(await plan(updateOne(demo)), await gandalf().snapshot());
    expect(one === null ? null : updateTitle(one)).toBe("Update demo?");
  });

  it("keeps a library copy the user edited, and answers when nothing is newer", async () => {
    const { gandalf, plan, change } = await folderHome();
    const snapshot = await gandalf().snapshot();
    const upToDate = updateFacts(await plan(UPDATE_ALL), snapshot);
    expect(upToDate === null ? null : updateTitle(upToDate)).toBe("Every skill is up to date");
    expect(upToDate?.checked).toEqual([demo, notes]);
    const one = updateFacts(await plan(updateOne(notes)), snapshot);
    expect(one === null ? null : updateTitle(one)).toBe("notes is up to date");
    await change(demo);
    await writeFile(`${snapshot.libraryDir}/demo/SKILL.md`, "edited in the library\n");
    const kept = updateFacts(await plan(UPDATE_ALL), await gandalf().snapshot());
    expect(kept).toMatchObject({ skills: [], kept: [demo] });
    expect(kept === null ? null : updateTitle(kept)).toBe("Nothing to update");
  });
});

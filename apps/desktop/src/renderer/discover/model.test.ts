import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeEnv, openGandalf, parseIntent, type Snapshot } from "@gandalf/skills";
import { afterEach, describe, expect, it } from "vitest";
import { seedHome, type Fixture } from "../../../e2e/homes";
import { adoptAllNames, discoverModel, intakeName } from "./model";

let home = "";

afterEach(async () => {
  if (home !== "") await rm(home, { recursive: true, force: true });
  home = "";
});

async function enableDemoEverywhere(h: string): Promise<void> {
  const plan = await openGandalf(nodeEnv({ home: h })).plan(
    parseIntent({ kind: "setEnabled", skill: "demo", enabled: true, agents: "all" }),
  );
  if (!plan.ok) throw new Error("expected a plan");
  await openGandalf(nodeEnv({ home: h })).apply(plan.plan);
}

async function adoptPlan(h: string, name: string) {
  const plan = await openGandalf(nodeEnv({ home: h })).plan(
    parseIntent({ kind: "adopt", names: [name], pick: [] }),
  );
  if (!plan.ok) throw new Error("expected a plan");
  return plan.plan;
}

async function snapshotOf(fixture: Fixture, change?: (home: string) => Promise<void>) {
  home = await seedHome(fixture);
  await change?.(home);
  return openGandalf(nodeEnv({ home })).snapshot();
}

const paths = (snapshot: Snapshot, list: readonly { readonly path: string }[]) =>
  list.map((entry) => entry.path.slice(snapshot.libraryDir.length - "/.gandalf/skills".length));

describe("discoverModel", () => {
  it("groups the copies of each name you placed and tells whether they agree", async () => {
    const snapshot = await snapshotOf("adoptChoice");
    const model = discoverModel(snapshot);
    expect(
      model.notManaged.map(({ name, copies, agree }) => [name, paths(snapshot, copies), agree]),
    ).toEqual([
      ["notes", ["/.claude/skills/notes", "/.codex/skills/notes"], true],
      ["review", ["/.claude/skills/review", "/.cursor/skills/review"], false],
    ]);
    expect(adoptAllNames(model)).toEqual(["notes"]);
    expect(model.conflicts).toEqual([]);
  });

  it("puts a skill you placed where gandalf wants a library skill under Conflict", async () => {
    const snapshot = await snapshotOf("conflict", enableDemoEverywhere);
    const model = discoverModel(snapshot);
    expect(paths(snapshot, model.conflicts)).toEqual(["/.cursor/skills/demo"]);
    expect(model.notManaged).toEqual([]);
    expect(model.cannotAdopt).toEqual([]);
  });

  it("lists a copy that differs from the library's version as one Adopt leaves alone", async () => {
    const snapshot = await snapshotOf("conflict");
    const model = discoverModel(snapshot);
    expect(
      model.cannotAdopt.map((item) => [
        item.kind,
        item.kind === "ownVersion" ? item.name : null,
        paths(snapshot, [item.entry])[0],
      ]),
    ).toEqual([["ownVersion", "demo", "/.cursor/skills/demo"]]);
    expect(model.conflicts).toEqual([]);
    expect(model.notManaged).toEqual([]);
    expect(adoptAllNames(model)).toEqual([]);
  });

  it("names a copy that keeps its own version by its SKILL.md name, not its folder", async () => {
    const snapshot = await snapshotOf("twoAgents", async (h) => {
      await mkdir(join(h, ".cursor/skills/my-demo"), { recursive: true });
      await writeFile(
        join(h, ".cursor/skills/my-demo/SKILL.md"),
        "---\nname: demo\ndescription: Mine\n---\n",
      );
    });
    const [item] = discoverModel(snapshot).cannotAdopt;
    expect(item?.kind === "ownVersion" ? item.name : null).toBe("demo");
  });

  it("offers Adopt for a copy in gandalf's slot that matches the library, as the core plans", async () => {
    const snapshot = await snapshotOf("twoAgents", async (h) => {
      await cp(join(h, ".gandalf/skills/demo"), join(h, ".cursor/skills/demo"), {
        recursive: true,
      });
      await enableDemoEverywhere(h);
    });
    const [entry] = snapshot.entries.filter((e) => e.path.endsWith(".cursor/skills/demo"));
    expect(entry?.verdict).toBe("conflict");
    const model = discoverModel(snapshot);
    expect(
      model.notManaged.map(({ name, copies, agree, inLibrary }) => [
        name,
        paths(snapshot, copies),
        agree,
        inLibrary,
      ]),
    ).toEqual([["demo", ["/.cursor/skills/demo"], true, true]]);
    expect(model.conflicts).toEqual([]);
    expect(adoptAllNames(model)).toEqual(["demo"]);
    const plan = await adoptPlan(home, "demo");
    expect(plan.steps.map((step) => step.kind)).toEqual(["trashDuplicate", "link"]);
    expect(plan.notDone).toEqual([]);
  });

  it("counts a conflicting copy with the same name when telling whether copies agree", async () => {
    const snapshot = await snapshotOf("twoAgents", async (h) => {
      await enableDemoEverywhere(h);
      await rm(join(h, ".cursor/skills/demo"));
      await rm(join(h, ".gandalf/skills/demo"), { recursive: true });
      await mkdir(join(h, ".cursor/skills/demo"));
      await writeFile(
        join(h, ".cursor/skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: X\n---\n",
      );
      await mkdir(join(h, ".claude/skills/demo-copy"));
      await writeFile(
        join(h, ".claude/skills/demo-copy/SKILL.md"),
        "---\nname: demo\ndescription: Y\n---\n",
      );
    });
    const model = discoverModel(snapshot);
    expect(
      model.notManaged.map(({ name, copies, agree }) => [name, paths(snapshot, copies), agree]),
    ).toEqual([["demo", ["/.claude/skills/demo-copy", "/.cursor/skills/demo"], false]]);
    expect(model.conflicts).toEqual([]);
    expect(adoptAllNames(model)).toEqual([]);
    const plan = await adoptPlan(home, "demo");
    const [choice] = plan.notDone;
    expect(choice?.kind).toBe("needsChoice");
    expect(
      choice?.kind === "needsChoice"
        ? paths(
            snapshot,
            choice.variants.flatMap((variant) => variant.at),
          ).sort()
        : [],
    ).toEqual(paths(snapshot, model.notManaged[0]?.copies ?? []));
  });

  it("offers Adopt for a conflict whose library folder is gone, the one copy adopt takes", async () => {
    const snapshot = await snapshotOf("twoAgents", async (h) => {
      await enableDemoEverywhere(h);
      await rm(join(h, ".cursor/skills/demo"));
      await rm(join(h, ".claude/skills/demo"));
      await rm(join(h, ".gandalf/skills/demo"), { recursive: true });
      await mkdir(join(h, ".cursor/skills/demo"));
      await writeFile(
        join(h, ".cursor/skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: X\n---\n",
      );
    });
    const [entry] = snapshot.entries.filter((e) => e.path.endsWith(".cursor/skills/demo"));
    expect(entry?.verdict).toBe("conflict");
    const model = discoverModel(snapshot);
    expect(
      model.notManaged.map(({ name, copies, agree }) => [name, paths(snapshot, copies), agree]),
    ).toEqual([["demo", ["/.cursor/skills/demo"], true]]);
    expect(model.conflicts).toEqual([]);
    expect(adoptAllNames(model)).toEqual(["demo"]);
    const plan = await adoptPlan(home, "demo");
    const moves = plan.steps.filter((step) => step.kind === "adoptMove");
    expect(moves.map((step) => paths(snapshot, [step.from])[0])).toEqual(["/.cursor/skills/demo"]);
    expect(plan.notDone).toEqual([]);
  });

  it("lists folders without SKILL.md and links you made as entries it cannot adopt", async () => {
    const snapshot = await snapshotOf("twoAgents", async (h) => {
      await mkdir(join(h, ".cursor/skills/tool"), { recursive: true });
      await writeFile(join(h, ".cursor/skills/tool/README.md"), "not a skill");
      await symlink(join(h, "nowhere"), join(h, ".cursor/skills/gone"));
    });
    const model = discoverModel(snapshot);
    expect(
      paths(
        snapshot,
        model.cannotAdopt.map((item) => item.entry),
      ),
    ).toEqual(["/.cursor/skills/gone", "/.cursor/skills/tool"]);
    expect(model.notManaged).toEqual([]);
  });
});

describe("intakeName", () => {
  it("takes the SKILL.md name, else the folder name, else none", () => {
    expect(intakeName("review", "folder")).toBe("review");
    expect(intakeName("not a name", "folder")).toBe("folder");
    expect(intakeName(null, "has space")).toBeNull();
    expect(intakeName(null, "a..b")).toBeNull();
  });
});

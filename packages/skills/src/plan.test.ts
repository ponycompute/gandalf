import { readFile, symlink, unlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { classify } from "./disk.js";
import { nodeFs } from "./env.js";
import { openGandalf } from "./gandalf.js";
import {
  at,
  link,
  rawTreeOf,
  recordedState,
  run,
  seedState,
  tempHome,
  testEnv,
  treeOf,
  writeSkill,
  writeTree,
} from "./testkit.js";
import type { AbsPath, Intent, IsoTime, ModeSetting, Plan, SkillName, Step } from "./types.js";

const pdf = "pdf" as SkillName;
const installedAt = "2026-10-01T00:00:00.000Z" as IsoTime;

/** cursor and claude_code installed, library has pdf and notes; pdf enabled for cursor only. */
async function home(
  options: { modes?: Partial<Record<"cursor" | "claude_code", ModeSetting>> } = {},
) {
  const home = await tempHome();
  await writeTree(home, { ".cursor/settings.json": "{}", ".claude/settings.json": "{}" });
  await writeSkill(at(home, ".gandalf/skills/pdf"), "pdf");
  await writeSkill(at(home, ".gandalf/skills/notes"), "notes");
  await seedState(home, {
    skills: {
      [pdf]: {
        source: { kind: "local", path: null },
        installedAt,
        enabled: { default: false, except: ["cursor"] },
      },
    },
    agents: Object.fromEntries(
      Object.entries(options.modes ?? {}).map(([agent, mode]) => [
        agent,
        { skillsDir: null, mode },
      ]),
    ),
  });
  return home;
}

async function planOf(home: AbsPath, intent: Intent, env = testEnv(home)): Promise<Plan> {
  const outcome = await openGandalf(env).plan(intent);
  if (!outcome.ok) throw new Error(outcome.error.kind);
  return outcome.plan;
}

const kinds = (steps: readonly Step[]) => steps.map((step) => step.kind);
/** root -> "link" | "copy" for every creation in a plan. */
const creations = (steps: readonly Step[]) =>
  Object.fromEntries(
    steps.flatMap((s) => (s.kind === "link" || s.kind === "copy" ? [[s.slot.root, s.kind]] : [])),
  );
const enable = (agents: Intent & { kind: "setEnabled" } extends { agents: infer A } ? A : never) =>
  ({ kind: "setEnabled", skill: pdf, enabled: true, agents }) as const;

describe("snapshot", () => {
  it("reports agents, shared roots, the matrix and entries without writing", async () => {
    const h = await home();
    await writeTree(h, { ".codex/config.toml": "", ".copilot/x": "" });
    await writeSkill(at(h, ".agents/skills/shared"), "shared");
    await writeSkill(at(h, ".claude/skills/mine"), "mine");
    const before = await treeOf(h);
    const snapshot = await openGandalf(testEnv(h)).snapshot();
    expect(await treeOf(h)).toEqual(before);

    expect(snapshot.agents.filter((a) => a.installed).map((a) => a.id)).toEqual([
      "cursor",
      "claude_code",
      "codex",
      "github_copilot",
    ]);
    expect(snapshot.roots.find((r) => r.path === at(h, ".agents/skills"))).toMatchObject({
      role: "scan",
      readers: ["codex", "github_copilot"],
    });
    const pdfRow = snapshot.skills.find((s) => s.name === "pdf");
    expect(pdfRow?.cells.map((c) => [c.agent, c.enabled, c.verdict])).toEqual([
      ["cursor", true, "missing"],
      ["claude_code", false, "off"],
      ["codex", false, "off"],
      ["github_copilot", false, "off"],
    ]);
    expect(snapshot.skills.find((s) => s.name === "notes")?.issues).toEqual([
      { kind: "untracked" },
    ]);
    expect(snapshot.entries.find((e) => e.name === "mine")).toMatchObject({ verdict: "unmanaged" });
    expect(snapshot.entries.find((e) => e.name === "shared")).toMatchObject({
      verdict: "unmanaged",
      role: "scan",
      readers: ["codex", "github_copilot"],
    });
    expect(snapshot.problems.map((p) => p.kind)).toEqual(["drift"]);
    expect(snapshot.watchPaths).toContain(at(h, ".gandalf/skills"));
  });

  it("reports broken links and modified copies as problems", async () => {
    const h = await home();
    await link(at(h, ".gandalf/skills/gone"), at(h, ".claude/skills/gone"));
    const snapshot = await openGandalf(testEnv(h)).snapshot();
    expect(snapshot.problems.map((p) => p.kind)).toContain("brokenLink");
  });
});

describe("setEnabled", () => {
  it("previews without writing, then applies exactly the preview", async () => {
    const h = await home();
    const before = await treeOf(h);
    const plan = await planOf(h, enable(["claude_code"]));
    expect(await treeOf(h)).toEqual(before);
    expect(kinds(plan.steps)).toEqual(["commitState", "ensureDir", "ensureDir", "link", "link"]);

    const result = await openGandalf(testEnv(h)).apply(plan);
    expect(result.kind).toBe("applied");
    expect(await classify(nodeFs, [at(h, ".gandalf/skills")], at(h, ".claude/skills/pdf"))).toEqual(
      {
        kind: "link",
        skill: "pdf",
        resolves: true,
      },
    );
    expect((await planOf(h, enable(["claude_code"]))).steps).toEqual([]);
  });

  it("tracks an untracked library dir as a local skill with no path", async () => {
    const h = await home();
    await run(testEnv(h), {
      kind: "setEnabled",
      skill: "notes" as SkillName,
      enabled: true,
      agents: ["claude_code"],
    });
    const state = await recordedState(h);
    expect(state.skills.notes).toMatchObject({
      source: { kind: "local", path: null },
      enabled: { default: false, except: ["claude_code"] },
    });
  });

  it("refuses unknown skills and agents that are not installed", async () => {
    const h = await home();
    const gandalf = openGandalf(testEnv(h));
    expect(await gandalf.plan({ ...enable("all"), skill: "nope" as SkillName })).toEqual({
      ok: false,
      error: { kind: "unknownSkill", skill: "nope" },
    });
    expect(await gandalf.plan(enable(["grok"]))).toEqual({
      ok: false,
      error: { kind: "agentNotInstalled", agent: "grok" },
    });
  });

  it("reports a user's skill in the way as a conflict and never touches it", async () => {
    const h = await home();
    await writeSkill(at(h, ".claude/skills/pdf"), "pdf", { "mine.txt": "mine" });
    const plan = await planOf(h, enable("all"));
    expect(plan.notDone).toMatchObject([{ kind: "conflict", entry: { name: "pdf" } }]);
    expect(plan.steps.some((s) => "slot" in s && s.slot.root === at(h, ".claude/skills"))).toBe(
      false,
    );
  });
});

describe("sync", () => {
  it("restores deleted links, removes disabled ones and repairs wrong ones", async () => {
    const h = await home();
    await run(testEnv(h), enable("all"));
    await unlink(at(h, ".cursor/skills/pdf"));
    await unlink(at(h, ".claude/skills/pdf"));
    await symlink(at(h, ".gandalf/skills/notes"), at(h, ".claude/skills/pdf"));
    await link(at(h, ".gandalf/skills/pdf"), at(h, ".claude/skills/leftover"));

    const plan = await planOf(h, { kind: "sync", skills: "all" });
    expect(plan.steps).toEqual([
      { kind: "unlink", slot: { root: at(h, ".claude/skills"), name: "leftover" }, skill: "pdf" },
      { kind: "unlink", slot: { root: at(h, ".claude/skills"), name: "pdf" }, skill: "notes" },
      { kind: "link", slot: { root: at(h, ".claude/skills"), name: "pdf" }, skill: "pdf" },
      { kind: "link", slot: { root: at(h, ".cursor/skills"), name: "pdf" }, skill: "pdf" },
    ]);
    await run(testEnv(h), { kind: "sync", skills: "all" });
    expect((await openGandalf(testEnv(h)).snapshot()).problems).toEqual([]);
  });

  it("leaves links to untracked library skills alone", async () => {
    const h = await home();
    await link(at(h, ".gandalf/skills/notes"), at(h, ".cursor/skills/notes"));
    const plan = await planOf(h, { kind: "sync", skills: ["notes" as SkillName] });
    expect(plan.steps).toEqual([]);
  });
});

describe("retired skills dirs", () => {
  it("moves gandalf's links to the new dir and leaves the user's skills where they are", async () => {
    const h = await tempHome();
    await writeTree(h, { ".config/kilo/kilo.json": "{}" });
    await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf");
    await writeSkill(at(h, ".kilocode/skills/mine"), "mine");
    await link(at(h, ".gandalf/skills/pdf"), at(h, ".kilocode/skills/pdf"));
    await seedState(h, {
      skills: {
        [pdf]: {
          source: { kind: "local", path: null },
          installedAt,
          enabled: { default: true, except: [] },
        },
      },
    });

    const plan = await planOf(h, { kind: "sync", skills: "all" });
    expect(plan.steps).toEqual([
      { kind: "unlink", slot: { root: at(h, ".kilocode/skills"), name: "pdf" }, skill: "pdf" },
      { kind: "ensureDir", dir: at(h, ".kilo/skills") },
      { kind: "link", slot: { root: at(h, ".kilo/skills"), name: "pdf" }, skill: "pdf" },
    ]);
    await run(testEnv(h), { kind: "sync", skills: "all" });
    const tree = await treeOf(h);
    expect(tree).toContain(".kilocode/skills/mine dir");
    expect(tree).toContain(".kilo/skills/pdf link ~/.gandalf/skills/pdf");
    expect(tree.filter((line) => line.startsWith(".kilocode/skills/pdf"))).toEqual([]);
    expect((await openGandalf(testEnv(h)).snapshot()).problems).toEqual([]);
  });
});

describe("copy fallback", () => {
  const noSymlinksIn = (root: string) => ({
    probeSymlink: async (dir: AbsPath) => !dir.startsWith(root) && nodeFs.probeSymlink(dir),
  });

  it("copies into roots that refuse symlinks and links elsewhere", async () => {
    const h = await home();
    const env = testEnv(h, { fs: noSymlinksIn(at(h, ".claude")) });
    const plan = await planOf(h, enable("all"), env);
    expect(creations(plan.steps)).toEqual({
      [at(h, ".claude/skills")]: "copy",
      [at(h, ".cursor/skills")]: "link",
    });
    const result = await openGandalf(env).apply(plan);
    expect(result.kind === "applied" && result.results.every((r) => r.status === "done")).toBe(
      true,
    );
    expect(
      await classify(nodeFs, [at(h, ".gandalf/skills")], at(h, ".claude/skills/pdf")),
    ).toMatchObject({
      kind: "cleanCopy",
      skill: "pdf",
    });
    expect((await planOf(h, { kind: "sync", skills: "all" }, env)).steps).toEqual([]);
  });

  it("lets an explicit mode win over the probe", async () => {
    const h = await home({ modes: { claude_code: "link", cursor: "copy" } });
    const plan = await planOf(h, enable("all"), testEnv(h, { fs: noSymlinksIn(at(h, ".claude")) }));
    expect(creations(plan.steps)).toEqual({
      [at(h, ".claude/skills")]: "link",
      [at(h, ".cursor/skills")]: "copy",
    });
  });

  it("probes symlink support without touching the agent's folder", async () => {
    const h = await home();
    const probed: string[] = [];
    const env = testEnv(h, {
      fs: { probeSymlink: async (dir) => (probed.push(dir), nodeFs.probeSymlink(dir)) },
    });
    const before = await rawTreeOf(h);
    await planOf(h, enable(["claude_code"]), env);
    expect(probed).toContain(at(h, ".claude"));
    expect(await rawTreeOf(h)).toEqual(before);
  });

  it("probes only roots that are about to receive a creation", async () => {
    const h = await home();
    const probed: string[] = [];
    const env = testEnv(h, {
      fs: { probeSymlink: async (dir) => (probed.push(dir), nodeFs.probeSymlink(dir)) },
    });
    await openGandalf(env).snapshot();
    await planOf(h, { kind: "sync", skills: ["notes" as SkillName] }, env);
    expect(probed).toEqual([]);
    await planOf(h, enable(["claude_code"]), env);
    expect(probed).toEqual([at(h, ".claude"), at(h, ".cursor")]);
  });

  it("re-copies a stale copy after the library changes", async () => {
    const h = await home({ modes: { cursor: "copy" } });
    await run(testEnv(h), { kind: "sync", skills: "all" });
    await writeTree(at(h, ".gandalf/skills/pdf"), { "new.txt": "v2" });
    const plan = await planOf(h, { kind: "sync", skills: "all" });
    expect(kinds(plan.steps)).toEqual(["trashCopy", "copy"]);
    await run(testEnv(h), { kind: "sync", skills: "all" });
    expect(await readFile(at(h, ".cursor/skills/pdf/new.txt"), "utf8")).toBe("v2");
  });

  it("leaves a copy the user edited alone", async () => {
    const h = await home({ modes: { cursor: "copy" } });
    await run(testEnv(h), { kind: "sync", skills: "all" });
    await writeTree(at(h, ".cursor/skills/pdf"), { "SKILL.md": "my edits" });
    await run(testEnv(h), enable("all"));
    const snapshot = await openGandalf(testEnv(h)).snapshot();
    expect(snapshot.problems.map((p) => p.kind)).toContain("modifiedCopy");
    expect(await readFile(at(h, ".cursor/skills/pdf/SKILL.md"), "utf8")).toBe("my edits");
  });
});

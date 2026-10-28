import { readdir, readFile, readlink, rm, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { classify, contentHash } from "./disk.js";
import { nodeFs } from "./env.js";
import { openGandalf } from "./gandalf.js";
import {
  at,
  commitTo,
  gitRemote,
  link,
  recordedState,
  run,
  seedState,
  skillMd,
  tempHome,
  testEnv,
  treeOf,
  writeSkill,
  writeTree,
} from "./testkit.js";
import type { AbsPath, Intent, IsoTime, Plan, SkillName, Step } from "./types.js";

const name = (raw: string) => raw as SkillName;
const kinds = (steps: readonly Step[]) => steps.map((step) => step.kind);

async function agents(...dirs: string[]): Promise<AbsPath> {
  const h = await tempHome();
  for (const dir of dirs) await writeTree(h, { [`${dir}/settings.json`]: "{}" });
  return h;
}

async function planOf(h: AbsPath, intent: Intent): Promise<Plan> {
  const outcome = await openGandalf(testEnv(h)).plan(intent);
  if (!outcome.ok) throw new Error(outcome.error.kind);
  return outcome.plan;
}

async function stateOf(h: AbsPath) {
  return recordedState(h);
}

async function observed(h: AbsPath, relative: string) {
  return classify(nodeFs, [at(h, ".gandalf/skills")], at(h, relative));
}

describe("adopt", () => {
  it("moves one copy into the library, trashes identical copies, and links every holder", async () => {
    const h = await agents(".cursor", ".claude");
    for (const agent of [".cursor", ".claude"]) {
      await writeSkill(at(h, `${agent}/skills/notes`), "notes", { "a.md": "same" });
    }
    const plan = await planOf(h, { kind: "adopt", names: [name("notes")], pick: [] });
    expect(kinds(plan.steps)).toEqual([
      "commitState",
      "ensureDir",
      "adoptMove",
      "trashDuplicate",
      "link",
      "link",
    ]);
    await run(testEnv(h), plan.intent);
    expect(await observed(h, ".cursor/skills/notes")).toMatchObject({
      kind: "link",
      skill: "notes",
    });
    expect(await observed(h, ".claude/skills/notes")).toMatchObject({
      kind: "link",
      skill: "notes",
    });
    expect(await readFile(at(h, ".gandalf/skills/notes/a.md"), "utf8")).toBe("same");
    expect((await stateOf(h)).skills.notes.source).toEqual({
      kind: "adopted",
      from: "claude_code",
    });
    expect(await readdir(at(h, ".gandalf/trash"))).toHaveLength(1);
  });

  it("asks for a choice when copies differ, offering each variant with its holders", async () => {
    const h = await agents(".cursor", ".claude");
    await writeSkill(at(h, ".cursor/skills/notes"), "notes", { "a.md": "cursor" });
    await writeSkill(at(h, ".claude/skills/notes"), "notes", { "a.md": "claude" });
    const plan = await planOf(h, { kind: "adopt", names: [name("notes")], pick: [] });
    expect(plan.steps).toEqual([]);
    expect(plan.notDone).toMatchObject([
      { kind: "needsChoice", name: "notes", variants: [{ at: [{}] }, { at: [{}] }] },
    ]);
    const picked = await planOf(h, {
      kind: "adopt",
      names: [name("notes")],
      pick: [{ name: name("notes"), kind: "agent", agent: "cursor" }],
    });
    expect(picked.steps.find((s) => s.kind === "adoptMove")).toMatchObject({
      from: { path: at(h, ".cursor/skills/notes") },
    });
    expect(picked.notDone).toMatchObject([
      { kind: "differsFromLibrary", at: { path: at(h, ".claude/skills/notes") } },
    ]);
  });

  it("adopts from a shared scan dir and enables every agent that read it", async () => {
    const h = await agents(".codex", ".copilot");
    await writeSkill(at(h, ".agents/skills/shared"), "shared");
    await run(testEnv(h), { kind: "adopt", names: "all", pick: [] });
    expect(await observed(h, ".codex/skills/shared")).toMatchObject({ kind: "link" });
    expect(await observed(h, ".copilot/skills/shared")).toMatchObject({ kind: "link" });
    expect((await stateOf(h)).skills.shared.source).toEqual({ kind: "adopted", from: null });
  });

  it("leaves a library link in the shared scan dir, so links the user made there still resolve", async () => {
    const h = await agents(".codex", ".claude");
    await writeSkill(at(h, ".agents/skills/shared"), "shared");
    await link(at(h, ".agents/skills/shared"), at(h, ".claude/skills/shared"));
    const plan = await planOf(h, { kind: "adopt", names: [name("shared")], pick: [] });
    expect(plan.steps).toContainEqual({
      kind: "link",
      slot: { root: at(h, ".agents/skills"), name: "shared" },
      skill: "shared",
    });
    await run(testEnv(h), plan.intent);
    expect(await observed(h, ".agents/skills/shared")).toMatchObject({
      kind: "link",
      skill: "shared",
    });
    expect(await readFile(at(h, ".claude/skills/shared/SKILL.md"), "utf8")).toContain("shared");
    expect((await planOf(h, { kind: "sync", skills: "all" })).steps).toEqual([]);
  });

  it("adopts under the frontmatter name and refuses names with nothing to adopt", async () => {
    const h = await agents(".cursor");
    await writeTree(at(h, ".cursor/skills/Folder Name"), { "SKILL.md": skillMd("real-name") });
    const plan = await planOf(h, { kind: "adopt", names: "all", pick: [] });
    expect(plan.steps.find((s) => s.kind === "link")).toMatchObject({
      slot: { name: "real-name" },
    });
    expect(
      await openGandalf(testEnv(h)).plan({ kind: "adopt", names: [name("nope")], pick: [] }),
    ).toEqual({ ok: false, error: { kind: "nothingToAdopt", name: "nope" } });
  });

  it("fails a move across volumes loudly and leaves the user's dir in place", async () => {
    const h = await agents(".cursor");
    await writeSkill(at(h, ".cursor/skills/notes"), "notes");
    const exdev = Object.assign(new Error("EXDEV: cross-device link not permitted"), {
      code: "EXDEV",
    });
    const env = testEnv(h, {
      fs: {
        rename: async (from, to) => {
          if (from === at(h, ".cursor/skills/notes")) throw exdev;
          return nodeFs.rename(from, to);
        },
      },
    });
    const gandalf = openGandalf(env);
    const outcome = await gandalf.plan({ kind: "adopt", names: [name("notes")], pick: [] });
    if (!outcome.ok) throw new Error(outcome.error.kind);
    const result = await gandalf.apply(outcome.plan);
    expect(
      result.kind === "applied" && result.results.find((r) => r.step.kind === "adoptMove"),
    ).toMatchObject({ status: "failed", reason: "crossDevice" });
    expect(
      result.kind === "applied" && result.results.find((r) => r.step.kind === "link"),
    ).toMatchObject({ status: "skipped" });
    expect(await observed(h, ".cursor/skills/notes")).toMatchObject({ kind: "skillDir" });
  });
});

describe("keep", () => {
  it("adopts the kept version and trades every other copy for a link to it", async () => {
    const h = await agents(".cursor", ".claude");
    await writeSkill(at(h, ".cursor/skills/notes"), "notes", { "a.md": "cursor" });
    await writeSkill(at(h, ".claude/skills/notes"), "notes", { "a.md": "claude" });
    const hash = await contentHash(nodeFs, at(h, ".cursor/skills/notes"));
    if (hash === null) throw new Error("no hash");
    const plan = await planOf(h, { kind: "keep", name: name("notes"), hash });
    expect(kinds(plan.steps)).toEqual([
      "commitState",
      "ensureDir",
      "adoptMove",
      "trashDuplicate",
      "link",
      "link",
    ]);
    expect(plan.notDone).toEqual([]);
    await run(testEnv(h), plan.intent);
    for (const agent of [".cursor", ".claude"]) {
      expect(await observed(h, `${agent}/skills/notes`)).toMatchObject({
        kind: "link",
        skill: "notes",
      });
    }
    expect(await readFile(at(h, ".gandalf/skills/notes/a.md"), "utf8")).toBe("cursor");
    expect(await readdir(at(h, ".gandalf/trash"))).toHaveLength(1);
    expect((await planOf(h, { kind: "sync", skills: "all" })).steps).toEqual([]);
  });

  it("refuses a version other than the one the library holds", async () => {
    const h = await agents(".cursor", ".claude");
    await writeSkill(at(h, ".claude/skills/notes"), "notes", { "a.md": "claude" });
    await run(testEnv(h), { kind: "adopt", names: "all", pick: [] });
    await writeSkill(at(h, ".cursor/skills/notes"), "notes", { "a.md": "cursor" });
    const hash = await contentHash(nodeFs, at(h, ".cursor/skills/notes"));
    if (hash === null) throw new Error("no hash");
    expect(await openGandalf(testEnv(h)).plan({ kind: "keep", name: name("notes"), hash })).toEqual(
      { ok: false, error: { kind: "nameTaken", skill: "notes" } },
    );
  });
});

describe("replace", () => {
  it("trades a skill folder in the library skill's slot for a link, and leaves your links", async () => {
    const h = await agents(".cursor", ".claude", ".codex");
    await writeSkill(at(h, ".claude/skills/notes"), "notes", { "a.md": "claude" });
    await run(testEnv(h), { kind: "adopt", names: "all", pick: [] });
    await writeSkill(at(h, ".cursor/skills/notes"), "notes", { "a.md": "cursor" });
    await writeSkill(at(h, "elsewhere/notes"), "notes");
    await link(at(h, "elsewhere/notes"), at(h, ".codex/skills/notes"));
    await run(testEnv(h), {
      kind: "setEnabled",
      skill: name("notes"),
      enabled: true,
      agents: ["cursor", "codex"],
    });
    const plan = await planOf(h, { kind: "replace", skill: name("notes") });
    expect(kinds(plan.steps)).toEqual(["trashDuplicate", "link"]);
    await run(testEnv(h), plan.intent);
    expect(await observed(h, ".cursor/skills/notes")).toMatchObject({
      kind: "link",
      skill: "notes",
    });
    expect(await observed(h, ".codex/skills/notes")).toMatchObject({ kind: "foreignLink" });
    expect(await readFile(at(h, ".gandalf/skills/notes/a.md"), "utf8")).toBe("claude");
  });

  it("refuses a skill the library does not hold", async () => {
    const h = await agents(".cursor");
    expect(await openGandalf(testEnv(h)).plan({ kind: "replace", skill: name("nope") })).toEqual({
      ok: false,
      error: { kind: "unknownSkill", skill: "nope" },
    });
  });
});

describe("install", () => {
  it("installs a local dir and enables it for every installed agent; re-running is a no-op", async () => {
    const h = await agents(".cursor", ".claude");
    await writeSkill(at(h, "src/pdf"), "pdf", { "tool.sh": "x" });
    const intent: Intent = {
      kind: "install",
      source: { kind: "local", path: at(h, "src/pdf") },
      agents: "all",
    };
    await run(testEnv(h), intent);
    expect(await observed(h, ".cursor/skills/pdf")).toMatchObject({ kind: "link", skill: "pdf" });
    expect(await observed(h, ".claude/skills/pdf")).toMatchObject({ kind: "link", skill: "pdf" });
    expect((await stateOf(h)).skills.pdf).toMatchObject({
      source: { kind: "local", path: at(h, "src/pdf") },
      enabled: { default: true, except: [] },
    });
    expect((await planOf(h, intent)).steps).toEqual([]);
  });

  it("refuses a name the library already uses for different content", async () => {
    const h = await agents(".cursor");
    await writeSkill(at(h, "src/pdf"), "pdf", { "tool.sh": "new" });
    await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf", { "tool.sh": "old" });
    const outcome = await openGandalf(testEnv(h)).plan({
      kind: "install",
      source: { kind: "local", path: at(h, "src/pdf") },
      agents: "all",
    });
    expect(outcome).toEqual({ ok: false, error: { kind: "nameTaken", skill: "pdf" } });
  });

  it("installs from git at the commit the plan pinned, even if the remote moves before apply", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), {
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/pdf/tool.sh": "v1",
      "README.md": "repo",
    });
    const gandalf = openGandalf(testEnv(h));
    const outcome = await gandalf.plan({
      kind: "install",
      source: {
        kind: "git",
        url: remote.url,
        ref: null,
        subpath: "skills/pdf",
        skill: null,
        commit: null,
      },
      agents: ["cursor"],
    });
    if (!outcome.ok) throw new Error(outcome.error.kind);
    expect(outcome.plan.intent).toMatchObject({ source: { commit: remote.commit } });
    await commitTo(at(h, "repo"), { "skills/pdf/tool.sh": "v2" });

    expect((await gandalf.apply(outcome.plan)).kind).toBe("applied");
    expect(await readFile(at(h, ".gandalf/skills/pdf/tool.sh"), "utf8")).toBe("v1");
    expect(await readdir(at(h, ".gandalf/skills/pdf"))).toEqual(["SKILL.md", "tool.sh"]);
    expect((await stateOf(h)).skills.pdf.source).toEqual({
      kind: "git",
      url: remote.url,
      ref: null,
      subpath: "skills/pdf",
      commit: remote.commit,
    });
    expect(await readlink(at(h, ".cursor/skills/pdf"))).toBe(at(h, ".gandalf/skills/pdf"));
  });

  it("counts a source spelled through a symlink, as /var for /private/var, as the same", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), { "skills/pdf/SKILL.md": skillMd("pdf") });
    await writeSkill(at(h, "src/notes"), "notes");
    await link(h, at(h, "alias"));
    const git = (url: string): Intent => ({
      kind: "install",
      source: { kind: "git", url, ref: null, subpath: "skills/pdf", skill: null, commit: null },
      agents: "all",
    });
    const local = (path: AbsPath): Intent => ({
      kind: "install",
      source: { kind: "local", path },
      agents: "all",
    });
    await run(testEnv(h), git(remote.url));
    await run(testEnv(h), local(at(h, "src/notes")));
    const aliased = at(h, "alias/repo/remote.git");
    for (const intent of [
      git(aliased),
      git(pathToFileURL(aliased).href),
      local(at(h, "alias/src/notes")),
    ]) {
      const plan = await planOf(h, intent);
      expect(plan.steps).toEqual([]);
      expect(plan.intent.kind === "install" && plan.intent.source).toMatchObject(
        intent.kind === "install" && intent.source.kind === "git"
          ? { url: remote.url }
          : { path: at(h, "src/notes") },
      );
    }
    expect((await stateOf(h)).skills.pdf.source.url).toBe(remote.url);
  });

  it("reports a git source without SKILL.md as a bad source", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), { "README.md": "no skill" });
    const outcome = await openGandalf(testEnv(h)).plan({
      kind: "install",
      source: { kind: "git", url: remote.url, ref: null, subpath: null, skill: null, commit: null },
      agents: "all",
    });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "badSource" } });
  });
});

describe("install by skill name", () => {
  const byName = (url: string, skill: string): Intent => ({
    kind: "install",
    source: { kind: "git", url, ref: null, subpath: null, skill: name(skill), commit: null },
    agents: "all",
  });

  it("finds the skill's folder in the repository and records it as the subpath", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), {
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/pdf/tool.sh": "v1",
      "skills/docx/SKILL.md": skillMd("docx"),
    });
    const plan = await planOf(h, byName(remote.url, "pdf"));
    expect(plan.intent).toMatchObject({
      source: { subpath: "skills/pdf", skill: null, commit: remote.commit },
    });
    await run(testEnv(h), byName(remote.url, "pdf"));
    expect(await readdir(at(h, ".gandalf/skills/pdf"))).toEqual(["SKILL.md", "tool.sh"]);
    expect((await stateOf(h)).skills.pdf.source).toMatchObject({ subpath: "skills/pdf" });
  });

  it("takes the shallowest of several folders named as the skill", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), {
      "archive/old/pdf/SKILL.md": skillMd("pdf"),
      "skills/pdf/SKILL.md": skillMd("pdf"),
    });
    const plan = await planOf(h, byName(remote.url, "pdf"));
    expect(plan.intent).toMatchObject({ source: { subpath: "skills/pdf" } });
  });

  it("falls back to the name SKILL.md declares when no folder is named as the skill", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), {
      "tools/pdf-v2/SKILL.md": skillMd("pdf"),
      "pdf-draft/SKILL.md": skillMd("pdf-draft"),
    });
    const plan = await planOf(h, byName(remote.url, "pdf"));
    expect(plan.intent).toMatchObject({ source: { subpath: "tools/pdf-v2" } });
  });

  it("does not take a folder named as the skill whose SKILL.md names another", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), {
      "pdf/SKILL.md": skillMd("pdf-legacy"),
      "skills/pdf/SKILL.md": skillMd("pdf"),
    });
    const plan = await planOf(h, byName(remote.url, "pdf"));
    expect(plan.intent).toMatchObject({ source: { subpath: "skills/pdf" } });
  });

  it("reports a repository without the skill as a bad source", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), { "skills/docx/SKILL.md": skillMd("docx") });
    const outcome = await openGandalf(testEnv(h)).plan(byName(remote.url, "pdf"));
    expect(outcome).toEqual({
      ok: false,
      error: { kind: "badSource", reason: `no skill named pdf in ${remote.url}` },
    });
  });
});

describe("install several skills of one repository", () => {
  const git = (url: string, subpath: string | null) => ({
    kind: "git" as const,
    url,
    ref: null,
    subpath,
    skill: null,
    commit: null,
  });

  it("lists the repository's skills, shallowest first, once each", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), {
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/docx/SKILL.md": "---\nname: docx\ndescription: Edit Word files\n---\n",
      "archive/deep/pdf/SKILL.md": skillMd("pdf"),
      "notes/README.md": "not a skill",
    });
    expect(await openGandalf(testEnv(h)).repoSkills(remote.url, null)).toEqual({
      ok: true,
      commit: remote.commit,
      skills: [
        { name: "docx", subpath: "skills/docx", description: "Edit Word files" },
        { name: "pdf", subpath: "skills/pdf", description: expect.anything() },
      ],
    });
  });

  it("reports a repository it cannot fetch as a bad source", async () => {
    const h = await agents(".cursor");
    const outcome = await openGandalf(testEnv(h)).repoSkills(at(h, "missing"), null);
    expect(outcome).toMatchObject({ ok: false, error: { kind: "badSource" } });
  });

  it("installs every chosen skill in one plan, pinned to one commit", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), {
      "skills/pdf/SKILL.md": skillMd("pdf"),
      "skills/docx/SKILL.md": skillMd("docx"),
    });
    const intent: Intent = {
      kind: "install",
      source: git(remote.url, "skills/pdf"),
      agents: "all",
      also: [git(remote.url, "skills/docx")],
    };
    const plan = await planOf(h, intent);
    expect(plan.intent).toMatchObject({
      source: { commit: remote.commit },
      also: [{ subpath: "skills/docx", commit: remote.commit }],
    });
    await run(testEnv(h), intent);
    expect((await readdir(at(h, ".gandalf/skills"))).sort()).toEqual(["docx", "pdf"]);
    expect(Object.keys((await stateOf(h)).skills).sort()).toEqual(["docx", "pdf"]);
  });

  it("refuses two sources that name the same skill", async () => {
    const h = await agents(".cursor");
    const remote = await gitRemote(at(h, "repo"), {
      "a/pdf/SKILL.md": skillMd("pdf"),
      "b/pdf/SKILL.md": skillMd("pdf"),
    });
    const outcome = await openGandalf(testEnv(h)).plan({
      kind: "install",
      source: git(remote.url, "a/pdf"),
      agents: "all",
      also: [git(remote.url, "b/pdf")],
    });
    expect(outcome).toEqual({ ok: false, error: { kind: "nameTaken", skill: "pdf" } });
  });
});

describe("update", () => {
  async function installed(options: { copy?: boolean } = {}) {
    const h = await agents(".cursor", ".claude");
    const remote = await gitRemote(at(h, "repo"), { "SKILL.md": skillMd("pdf"), "tool.sh": "v1" });
    if (options.copy === true) {
      await seedState(h, { agents: { claude_code: { skillsDir: null, mode: "copy" } } });
    }
    await run(testEnv(h), {
      kind: "install",
      source: { kind: "git", url: remote.url, ref: null, subpath: null, skill: null, commit: null },
      agents: "all",
    });
    return { h, remote };
  }
  const updateAll: Intent = { kind: "update", skills: "all", pins: [] };

  it("replaces the library dir with the new commit and refreshes copies; links stay", async () => {
    const { h } = await installed({ copy: true });
    const next = await commitTo(at(h, "repo"), { "tool.sh": "v2" });
    const plan = await planOf(h, updateAll);
    expect(kinds(plan.steps)).toEqual(["trashCopy", "libraryReplace", "commitState", "copy"]);
    expect(plan.intent).toMatchObject({ pins: [{ skill: "pdf", commit: next }] });
    await run(testEnv(h), plan.intent);
    expect(await readFile(at(h, ".gandalf/skills/pdf/tool.sh"), "utf8")).toBe("v2");
    expect(await readFile(at(h, ".claude/skills/pdf/tool.sh"), "utf8")).toBe("v2");
    expect(await observed(h, ".cursor/skills/pdf")).toMatchObject({ kind: "link" });
    expect((await stateOf(h)).skills.pdf.source.commit).toBe(next);
    expect((await planOf(h, updateAll)).steps).toEqual([]);
  });

  it("keeps a library dir the user edited and reports it", async () => {
    const { h } = await installed();
    await commitTo(at(h, "repo"), { "tool.sh": "v2" });
    await writeTree(at(h, ".gandalf/skills/pdf"), { "tool.sh": "my edit" });
    const plan = await planOf(h, updateAll);
    expect(plan.steps).toEqual([]);
    expect(plan.notDone).toEqual([{ kind: "locallyModified", skill: "pdf" }]);
  });

  it("refuses to update a skill with no folder or repository to update from", async () => {
    const h = await agents(".cursor");
    await writeSkill(at(h, ".gandalf/skills/notes"), "notes");
    await run(testEnv(h), {
      kind: "setEnabled",
      skill: name("notes"),
      enabled: true,
      agents: "all",
    });
    expect(
      await openGandalf(testEnv(h)).plan({ kind: "update", skills: [name("notes")], pins: [] }),
    ).toEqual({ ok: false, error: { kind: "noSource", skill: "notes" } });
  });
});

describe("update from a local folder", () => {
  async function installed(options: { copy?: boolean } = {}) {
    const h = await agents(".cursor", ".claude");
    const folder = at(h, "src/pdf");
    await writeSkill(folder, "pdf", { "tool.sh": "v1" });
    if (options.copy === true) {
      await seedState(h, { agents: { claude_code: { skillsDir: null, mode: "copy" } } });
    }
    await run(testEnv(h), {
      kind: "install",
      source: { kind: "local", path: folder },
      agents: "all",
    });
    return { h, folder };
  }
  const updateAll: Intent = { kind: "update", skills: "all", pins: [] };

  it("takes the folder's changes into the library and its copies, and records what it took", async () => {
    const { h, folder } = await installed({ copy: true });
    const first = (await stateOf(h)).skills.pdf.source.hash;
    expect(first).toMatch(/^sha256:/);
    await writeTree(folder, { "tool.sh": "v2" });
    const plan = await planOf(h, updateAll);
    expect(kinds(plan.steps)).toEqual(["trashCopy", "libraryReplace", "commitState", "copy"]);
    await run(testEnv(h), plan.intent);
    expect(await readFile(at(h, ".gandalf/skills/pdf/tool.sh"), "utf8")).toBe("v2");
    expect(await readFile(at(h, ".claude/skills/pdf/tool.sh"), "utf8")).toBe("v2");
    const source = (await stateOf(h)).skills.pdf.source;
    expect(source).toMatchObject({ kind: "local", path: folder });
    expect(source.hash).not.toBe(first);
    expect((await planOf(h, updateAll)).steps).toEqual([]);
  });

  it("keeps a library dir the user edited and reports it", async () => {
    const { h, folder } = await installed();
    await writeTree(folder, { "tool.sh": "v2" });
    await writeTree(at(h, ".gandalf/skills/pdf"), { "tool.sh": "my edit" });
    const plan = await planOf(h, updateAll);
    expect(plan.steps).toEqual([]);
    expect(plan.notDone).toEqual([{ kind: "locallyModified", skill: "pdf" }]);
  });

  it("leaves a library dir edited while the folder stayed as it was", async () => {
    const { h } = await installed();
    await writeTree(at(h, ".gandalf/skills/pdf"), { "tool.sh": "my edit" });
    const plan = await planOf(h, updateAll);
    expect(plan.steps).toEqual([]);
    expect(plan.notDone).toEqual([]);
  });

  it("replaces a skill recorded before gandalf kept the hash, sending the old dir to the trash", async () => {
    const h = await agents(".cursor");
    const folder = at(h, "src/pdf");
    await writeSkill(folder, "pdf", { "tool.sh": "v2" });
    await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf", { "tool.sh": "v1" });
    await seedState(h, {
      skills: {
        [name("pdf")]: {
          source: { kind: "local", path: folder, hash: null },
          installedAt: "2026-10-24T09:00:00.000Z" as IsoTime,
          enabled: { default: true, except: [] },
        },
      },
    });
    await run(testEnv(h), updateAll);
    expect(await readFile(at(h, ".gandalf/skills/pdf/tool.sh"), "utf8")).toBe("v2");
    expect((await stateOf(h)).skills.pdf.source.hash).toMatch(/^sha256:/);
    const [trashed = ""] = await readdir(at(h, ".gandalf/trash"));
    expect(await readFile(at(h, `.gandalf/trash/${trashed}/tool.sh`), "utf8")).toBe("v1");
  });

  it("refuses when the folder is gone", async () => {
    const { h, folder } = await installed();
    await rm(folder, { recursive: true });
    expect(await openGandalf(testEnv(h)).plan(updateAll)).toMatchObject({
      ok: false,
      error: { kind: "badSource" },
    });
  });

  it("keeps the recorded hash on a re-install that leaves the library as it is", async () => {
    const { h, folder } = await installed();
    const first = (await stateOf(h)).skills.pdf.source.hash;
    await writeTree(folder, { "tool.sh": "v2" });
    await run(testEnv(h), {
      kind: "install",
      source: { kind: "local", path: folder },
      agents: "all",
    });
    expect((await stateOf(h)).skills.pdf.source.hash).toBe(first);
    expect(kinds((await planOf(h, updateAll)).steps)).toContain("libraryReplace");
  });
});

describe("remove", () => {
  it("removes the library dir and every link or clean copy, never the user's entries", async () => {
    const h = await agents(".cursor", ".claude", ".codex");
    await seedState(h, { agents: { codex: { skillsDir: null, mode: "copy" } } });
    await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf");
    await run(testEnv(h), { kind: "setEnabled", skill: name("pdf"), enabled: true, agents: "all" });
    await run(testEnv(h), {
      kind: "setEnabled",
      skill: name("pdf"),
      enabled: false,
      agents: ["claude_code"],
    });
    await writeSkill(at(h, ".claude/skills/pdf"), "pdf", { "mine.txt": "the user's" });

    const plan = await planOf(h, { kind: "remove", skill: name("pdf") });
    expect(kinds(plan.steps)).toEqual(["unlink", "trashCopy", "commitState", "libraryTrash"]);
    await run(testEnv(h), plan.intent);
    const tree = await treeOf(h);
    expect(tree.filter((line) => line.includes("skills/pdf"))).toEqual([
      ".claude/skills/pdf dir",
      ".claude/skills/pdf/SKILL.md file " + skillMd("pdf"),
      ".claude/skills/pdf/mine.txt file the user's",
    ]);
    expect((await stateOf(h)).skills).toEqual({});
  });
});

describe("configureAgent", () => {
  it("moves an agent to a new dir: links leave the old dir and appear in the new one", async () => {
    const h = await agents(".cursor");
    await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf");
    await writeSkill(at(h, ".cursor/skills/mine"), "mine");
    await run(testEnv(h), { kind: "setEnabled", skill: name("pdf"), enabled: true, agents: "all" });
    const moved: Intent = {
      kind: "configureAgent",
      agent: "cursor",
      skillsDir: at(h, "work/cursor-skills"),
      mode: null,
    };
    const plan = await planOf(h, moved);
    expect(kinds(plan.steps)).toEqual(["unlink", "commitState", "ensureDir", "link"]);
    await run(testEnv(h), moved);
    expect(await observed(h, ".cursor/skills/pdf")).toEqual({ kind: "absent" });
    expect(await observed(h, ".cursor/skills/mine")).toMatchObject({ kind: "skillDir" });
    expect(await observed(h, "work/cursor-skills/pdf")).toMatchObject({ kind: "link" });
    const snapshot = await openGandalf(testEnv(h)).snapshot();
    expect(snapshot.agents.find((a) => a.id === "cursor")).toMatchObject({
      skillsDir: at(h, "work/cursor-skills"),
      builtInSkillsDir: at(h, ".cursor/skills"),
      overridden: true,
    });
    expect(snapshot.problems).toEqual([]);
  });

  it("brings the links back to the built-in dir on a reset", async () => {
    const h = await agents(".cursor");
    await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf");
    await run(testEnv(h), { kind: "setEnabled", skill: name("pdf"), enabled: true, agents: "all" });
    const dir = at(h, "work/cursor-skills");
    await run(testEnv(h), { kind: "configureAgent", agent: "cursor", skillsDir: dir, mode: null });
    const reset: Intent = { kind: "configureAgent", agent: "cursor", skillsDir: null, mode: null };
    expect(kinds((await planOf(h, reset)).steps)).toEqual(["unlink", "commitState", "link"]);
    await run(testEnv(h), reset);
    expect(await observed(h, "work/cursor-skills/pdf")).toEqual({ kind: "absent" });
    expect(await observed(h, ".cursor/skills/pdf")).toMatchObject({ kind: "link" });
    expect((await openGandalf(testEnv(h)).snapshot()).problems).toEqual([]);
  });

  it("switches an agent to copies and back to the default", async () => {
    const h = await agents(".cursor");
    await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf");
    await run(testEnv(h), { kind: "setEnabled", skill: name("pdf"), enabled: true, agents: "all" });
    const toCopy: Intent = {
      kind: "configureAgent",
      agent: "cursor",
      skillsDir: null,
      mode: "copy",
    };
    expect(kinds((await planOf(h, toCopy)).steps)).toEqual(["unlink", "commitState", "copy"]);
    await run(testEnv(h), toCopy);
    expect(await observed(h, ".cursor/skills/pdf")).toMatchObject({ kind: "cleanCopy" });
    const reset: Intent = { kind: "configureAgent", agent: "cursor", skillsDir: null, mode: null };
    expect(kinds((await planOf(h, reset)).steps)).toEqual(["commitState"]);
    await run(testEnv(h), reset);
    expect((await stateOf(h)).agents).toEqual({});
  });

  it("leaves drift in other agents' dirs to sync", async () => {
    const h = await agents(".cursor", ".claude");
    await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf");
    await run(testEnv(h), { kind: "setEnabled", skill: name("pdf"), enabled: true, agents: "all" });
    await unlink(at(h, ".claude/skills/pdf"));
    const toCopy: Intent = {
      kind: "configureAgent",
      agent: "cursor",
      skillsDir: null,
      mode: "copy",
    };
    const plan = await planOf(h, toCopy);
    expect(plan.steps.map((step) => ("slot" in step ? step.slot.root : step.kind))).toEqual([
      at(h, ".cursor/skills"),
      "commitState",
      at(h, ".cursor/skills"),
    ]);
  });
});

describe("install re-run", () => {
  it("keeps installedAt and the library bytes", async () => {
    const h = await agents(".cursor");
    await writeSkill(at(h, "src/pdf"), "pdf");
    const intent: Intent = {
      kind: "install",
      source: { kind: "local", path: at(h, "src/pdf") },
      agents: "all",
    };
    await run(testEnv(h), intent);
    const first = (await stateOf(h)).skills.pdf.installedAt as IsoTime;
    await run(testEnv(h, { now: new Date("2026-12-01T00:00:00.000Z") }), intent);
    expect((await stateOf(h)).skills.pdf.installedAt).toBe(first);
    expect(await contentHash(nodeFs, at(h, ".gandalf/skills/pdf"))).toBe(
      await contentHash(nodeFs, at(h, "src/pdf")),
    );
  });
});

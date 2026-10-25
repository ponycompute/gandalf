import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitError, StateCorruptError, nodeEnv, parseIntent } from "@gandalf/skills";
import { afterEach, describe, expect, it } from "vitest";
import { seedHome } from "../../e2e/homes";
import { MAX_SKILL_FILE_BYTES, openService, settle, toAppError } from "./gandalf";

function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("toAppError", () => {
  it("maps a StateCorruptError to stateCorrupt with its absolute path and its reason", () => {
    expect(toAppError(new StateCorruptError("/h/.gandalf/state.json", "bad JSON"))).toEqual({
      kind: "stateCorrupt",
      path: "/h/.gandalf/state.json",
      reason: "bad JSON",
    });
  });

  it("maps the InputError of a malformed intent to badInput with its field", () => {
    const error = thrown(() => parseIntent({ kind: "remove", skill: "../x" }));
    expect(toAppError(error)).toEqual({
      kind: "badInput",
      field: "skill",
      message: 'skill: not a skill name: "../x"',
    });
  });

  it("maps a GitError to git with its message", () => {
    expect(toAppError(new GitError("fatal: not a git repository"))).toEqual({
      kind: "git",
      message: "fatal: not a git repository",
    });
  });

  it("maps any other throw to internal", () => {
    expect(toAppError(new TypeError("boom"))).toEqual({ kind: "internal", message: "boom" });
    expect(toAppError("bare string")).toEqual({ kind: "internal", message: "bare string" });
  });
});

describe("settle", () => {
  it("returns a synchronous throw while building the work as an error result", async () => {
    const result = await settle(() =>
      Promise.resolve(parseIntent({ kind: "remove", skill: "../x" })),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "badInput", field: "skill" } });
  });

  it("returns the value of work that resolves", async () => {
    expect(await settle(() => Promise.resolve(3))).toEqual({ ok: true, value: 3 });
  });
});

describe("openService", () => {
  let home = "";

  afterEach(async () => {
    if (home !== "") await rm(home, { recursive: true, force: true });
    home = "";
  });

  it("returns stateCorrupt, not a throw, when state.json is not JSON", async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "gandalf-desktop-")));
    await mkdir(join(home, ".gandalf"));
    await writeFile(join(home, ".gandalf/state.json"), "{ not json");
    expect(await openService(nodeEnv({ home })).snapshot()).toMatchObject({
      ok: false,
      error: { kind: "stateCorrupt", path: join(home, ".gandalf/state.json") },
    });
  });

  it("returns the snapshot of the given HOME", async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "gandalf-desktop-")));
    await mkdir(join(home, ".cursor"));
    const result = await openService(nodeEnv({ home })).snapshot();
    if (!result.ok) throw new Error(result.error.kind);
    expect(result.value.libraryDir).toBe(join(home, ".gandalf/skills"));
    expect(result.value.agents.filter((agent) => agent.installed).map((agent) => agent.id)).toEqual(
      ["cursor"],
    );
  });

  it("returns badInput with the field of a malformed intent, and plans nothing", async () => {
    home = await seedHome("twoAgents");
    const service = openService(nodeEnv({ home }));
    expect(
      await service.plan({ kind: "setEnabled", skill: "demo", enabled: "yes", agents: ["cursor"] }),
    ).toEqual({
      ok: false,
      error: { kind: "badInput", field: "enabled", message: "enabled: must be a boolean" },
    });
    expect(
      await service.plan({ kind: "setEnabled", skill: "demo", enabled: true, agents: ["x"] }),
    ).toMatchObject({ ok: false, error: { kind: "badInput", field: "agents[0]" } });
  });

  it("returns a planner refusal as a value, not an error", async () => {
    home = await seedHome("twoAgents");
    const service = openService(nodeEnv({ home }));
    expect(
      await service.plan({ kind: "setEnabled", skill: "nope", enabled: true, agents: ["cursor"] }),
    ).toEqual({ ok: true, value: { ok: false, error: { kind: "unknownSkill", skill: "nope" } } });
  });

  it("returns badInput for a forged token, and writes nothing", async () => {
    home = await seedHome("twoAgents");
    const service = openService(nodeEnv({ home }));
    expect(
      await service.apply({ intent: { kind: "remove", skill: "../x" }, fingerprint: "x" }),
    ).toMatchObject({ ok: false, error: { kind: "badInput", field: "fingerprint" } });
    expect(
      await service.apply({
        intent: { kind: "remove", skill: "../x" },
        fingerprint: `sha256:${"0".repeat(64)}`,
      }),
    ).toMatchObject({ ok: false, error: { kind: "badInput", field: "skill" } });
    expect(await readlink(join(home, ".claude/skills/demo"))).toBe(
      join(home, ".gandalf/skills/demo"),
    );
  });

  it("applies the plan it re-derives and ignores steps the caller sends along", async () => {
    home = await seedHome("twoAgents");
    const service = openService(nodeEnv({ home }));
    const planned = await service.plan({
      kind: "setEnabled",
      skill: "demo",
      enabled: true,
      agents: ["cursor"],
    });
    if (!planned.ok || !planned.value.ok) throw new Error("expected a plan");
    const { plan } = planned.value;
    const forgedUnlink = {
      kind: "unlink",
      slot: { root: join(home, ".claude/skills"), name: "demo" },
      skill: "demo",
    };
    const outcome = await service.apply({ ...plan, steps: [...plan.steps, forgedUnlink] });
    if (!outcome.ok || outcome.value.kind !== "applied") throw new Error("expected applied");
    expect(outcome.value.results.map((result) => [result.step.kind, result.status])).toEqual(
      plan.steps.map((step) => [step.kind, "done"]),
    );
    expect((await lstat(join(home, ".claude/skills/demo"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(home, ".cursor/skills/demo"))).toBe(
      join(home, ".gandalf/skills/demo"),
    );
  });
});

describe("readSkillFile", () => {
  let home = "";

  afterEach(async () => {
    if (home !== "") await rm(home, { recursive: true, force: true });
    home = "";
  });

  const refused = { ok: false, error: { kind: "badInput", field: "path" } };

  it("reads SKILL.md of a skill you placed", async () => {
    home = await seedHome("adoptChoice");
    const service = openService(nodeEnv({ home }));
    expect(await service.readSkillFile(join(home, ".cursor/skills/review/SKILL.md"))).toEqual({
      ok: true,
      value: "---\nname: review\ndescription: Review a PR\n---\n\nThe Cursor variant.\n",
    });
  });

  it("reads SKILL.md of a library skill", async () => {
    home = await seedHome("twoAgents");
    const service = openService(nodeEnv({ home }));
    expect(await service.readSkillFile(join(home, ".gandalf/skills/demo/SKILL.md"))).toMatchObject({
      ok: true,
      value: expect.stringContaining("name: demo"),
    });
  });

  it("refuses a path outside the snapshot's skill folders", async () => {
    home = await seedHome("adoptChoice");
    const service = openService(nodeEnv({ home }));
    await writeFile(join(home, "secret.txt"), "not a skill");
    expect(await service.readSkillFile("/etc/hosts")).toMatchObject(refused);
    expect(await service.readSkillFile(join(home, "secret.txt"))).toMatchObject(refused);
    expect(await service.readSkillFile(join(home, ".cursor/skills/SKILL.md"))).toMatchObject(
      refused,
    );
    expect(await service.readSkillFile("SKILL.md")).toMatchObject(refused);
    expect(await service.readSkillFile({ path: "/etc/hosts" })).toMatchObject(refused);
  });

  it("refuses a .. path even when it lands inside a skill folder", async () => {
    home = await seedHome("adoptChoice");
    const service = openService(nodeEnv({ home }));
    expect(
      await service.readSkillFile(`${home}/.cursor/skills/notes/../review/SKILL.md`),
    ).toMatchObject(refused);
    expect(
      await service.readSkillFile(`${home}/.cursor/skills/review/../../../secret.txt`),
    ).toMatchObject(refused);
  });

  it("refuses a symlink inside a skill folder that points out of it", async () => {
    home = await seedHome("adoptChoice");
    await writeFile(join(home, "secret.txt"), "not a skill");
    await symlink(join(home, "secret.txt"), join(home, ".cursor/skills/review/escape.md"));
    const service = openService(nodeEnv({ home }));
    expect(
      await service.readSkillFile(join(home, ".cursor/skills/review/escape.md")),
    ).toMatchObject(refused);
  });

  it("refuses a file in a subfolder of a skill folder", async () => {
    home = await seedHome("adoptChoice");
    await mkdir(join(home, ".cursor/skills/review/docs"));
    await writeFile(join(home, ".cursor/skills/review/docs/more.md"), "nested");
    const service = openService(nodeEnv({ home }));
    expect(
      await service.readSkillFile(join(home, ".cursor/skills/review/docs/more.md")),
    ).toMatchObject(refused);
  });

  it("refuses every file in a library skill folder that is a link", async () => {
    home = await seedHome("twoAgents");
    const code = join(home, "code/linked");
    await mkdir(code, { recursive: true });
    await writeFile(join(code, "SKILL.md"), "---\nname: linked\ndescription: Linked\n---\n");
    await writeFile(join(code, ".env"), "TOKEN=secret");
    await symlink(code, join(home, ".gandalf/skills/linked"));
    const service = openService(nodeEnv({ home }));
    const snapshot = await service.snapshot();
    expect(snapshot.ok && snapshot.value.skills.some((skill) => skill.name === "linked")).toBe(
      true,
    );
    for (const file of ["SKILL.md", ".env"]) {
      expect(await service.readSkillFile(join(home, ".gandalf/skills/linked", file))).toMatchObject(
        refused,
      );
    }
  });

  it("refuses a FIFO in a skill folder at once instead of waiting for a writer", async () => {
    home = await seedHome("adoptChoice");
    const fifo = join(home, ".cursor/skills/review/pipe");
    await promisify(execFile)("mkfifo", [fifo]);
    const service = openService(nodeEnv({ home }));
    const started = Date.now();
    expect(await service.readSkillFile(fifo)).toMatchObject(refused);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 5000);

  it("refuses a file over 1 MB and reads one at exactly 1 MB", async () => {
    home = await seedHome("adoptChoice");
    const dir = join(home, ".cursor/skills/review");
    await writeFile(join(dir, "big.md"), "x".repeat(MAX_SKILL_FILE_BYTES + 1));
    await writeFile(join(dir, "edge.md"), "x".repeat(MAX_SKILL_FILE_BYTES));
    const service = openService(nodeEnv({ home }));
    expect(await service.readSkillFile(join(dir, "big.md"))).toMatchObject(refused);
    expect(await service.readSkillFile(join(dir, "edge.md"))).toMatchObject({ ok: true });
  });
});

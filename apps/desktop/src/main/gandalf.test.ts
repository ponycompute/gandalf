import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, StateCorruptError, nodeEnv, parseIntent } from "@gandalf/skills";
import { afterEach, describe, expect, it } from "vitest";
import { openService, settle, toAppError } from "./gandalf";

function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("toAppError", () => {
  it("maps a StateCorruptError to stateCorrupt with its path under ~ and its reason", () => {
    expect(toAppError(new StateCorruptError("/h/.gandalf/state.json", "bad JSON"), "/h")).toEqual({
      kind: "stateCorrupt",
      path: "~/.gandalf/state.json",
      reason: "bad JSON",
    });
  });

  it("keeps a path outside the home directory whole", () => {
    expect(toAppError(new StateCorruptError("/hx/state.json", "bad JSON"), "/h")).toMatchObject({
      path: "/hx/state.json",
    });
  });

  it("maps the InputError of a malformed intent to badInput with its field", () => {
    const error = thrown(() => parseIntent({ kind: "remove", skill: "../x" }));
    expect(toAppError(error, "/h")).toEqual({
      kind: "badInput",
      field: "skill",
      message: 'skill: not a skill name: "../x"',
    });
  });

  it("maps a GitError to git with its message", () => {
    expect(toAppError(new GitError("fatal: not a git repository"), "/h")).toEqual({
      kind: "git",
      message: "fatal: not a git repository",
    });
  });

  it("maps any other throw to internal", () => {
    expect(toAppError(new TypeError("boom"), "/h")).toEqual({ kind: "internal", message: "boom" });
    expect(toAppError("bare string", "/h")).toEqual({ kind: "internal", message: "bare string" });
  });
});

describe("settle", () => {
  it("returns a synchronous throw while building the work as an error result", async () => {
    const result = await settle("/h", () =>
      Promise.resolve(parseIntent({ kind: "remove", skill: "../x" })),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "badInput", field: "skill" } });
  });

  it("returns the value of work that resolves", async () => {
    expect(await settle("/h", () => Promise.resolve(3))).toEqual({ ok: true, value: 3 });
  });
});

describe("openService", () => {
  let home = "";

  afterEach(async () => {
    if (home !== "") await rm(home, { recursive: true, force: true });
  });

  it("returns stateCorrupt, not a throw, when state.json is not JSON", async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "gandalf-desktop-")));
    await mkdir(join(home, ".gandalf"));
    await writeFile(join(home, ".gandalf/state.json"), "{ not json");
    expect(await openService(nodeEnv({ home })).snapshot()).toMatchObject({
      ok: false,
      error: { kind: "stateCorrupt", path: "~/.gandalf/state.json" },
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
});

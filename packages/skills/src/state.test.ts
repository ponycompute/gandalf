import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { layout, nodeFs } from "./env.js";
import {
  EMPTY_STATE,
  StateCorruptError,
  applyChanges,
  isEnabled,
  isNoop,
  jsonStateStore,
  readState,
  withAgents,
  writeState,
  type DesiredState,
  type StateStore,
} from "./state.js";
import { tempHome } from "./testkit.js";
import type {
  AbsPath,
  Enablement,
  GitCommit,
  IsoTime,
  Revision,
  SkillName,
  StateChange,
} from "./types.js";

const now = () => new Date("2026-10-24T09:00:00.000Z");
const t0 = "2026-10-24T09:00:00.000Z" as IsoTime;
const t1 = "2026-10-25T09:00:00.000Z" as IsoTime;
const pdf = "pdf" as SkillName;
const notes = "notes" as SkillName;
const commit = "a".repeat(40) as GitCommit;

const sample: DesiredState = {
  revision: 3 as Revision,
  skills: {
    [pdf]: {
      source: { kind: "git", url: "https://x/repo.git", ref: "main", subpath: "pdf", commit },
      installedAt: t0,
      enabled: { default: true, except: ["codex"] },
    },
    [notes]: {
      source: { kind: "adopted", from: "claude_code" },
      installedAt: t0,
      enabled: { default: false, except: ["cursor", "claude_code"] },
    },
  },
  agents: { cursor: { skillsDir: "/work/cursor-skills" as AbsPath, mode: "copy" } },
  projects: {},
};

async function stateHome() {
  const home = await tempHome();
  const paths = layout(home, now);
  return { home, paths };
}

describe("state.json", () => {
  it("reads a missing file as the empty state", async () => {
    const { paths } = await stateHome();
    expect(await readState(nodeFs, paths)).toEqual(EMPTY_STATE);
  });

  it("round-trips through an atomic write with stable bytes", async () => {
    const { paths } = await stateHome();
    await writeState(nodeFs, paths, sample);
    expect(await readState(nodeFs, paths)).toEqual(sample);
    const first = await readFile(paths.stateFile, "utf8");
    await writeState(nodeFs, paths, await readState(nodeFs, paths));
    expect(await readFile(paths.stateFile, "utf8")).toBe(first);
    expect(await readdir(paths.gandalfDir)).toEqual(["staging", "state.json"]);
    expect(await readdir(paths.stagingDir)).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["an unknown schema", JSON.stringify({ schema: 2, revision: 0, skills: {}, agents: {} })],
    [
      "a bad skill name",
      JSON.stringify({ schema: 1, revision: 0, skills: { "../x": {} }, agents: {} }),
    ],
    ["a negative revision", JSON.stringify({ schema: 1, revision: -1, skills: {}, agents: {} })],
  ])("refuses %s with StateCorruptError", async (_name, contents) => {
    const { paths } = await stateHome();
    await mkdir(paths.gandalfDir, { recursive: true });
    await writeFile(paths.stateFile, contents);
    await expect(readState(nodeFs, paths)).rejects.toBeInstanceOf(StateCorruptError);
  });

  it("ignores agents that left the registry", async () => {
    const { paths } = await stateHome();
    await mkdir(paths.gandalfDir, { recursive: true });
    await writeFile(
      paths.stateFile,
      JSON.stringify({
        schema: 1,
        revision: 1,
        skills: {
          pdf: {
            source: { kind: "adopted", from: "retired_agent" },
            installedAt: t0,
            enabled: { default: false, except: ["retired_agent", "cursor"] },
          },
        },
        agents: { retired_agent: { skillsDir: "/x", mode: null } },
      }),
    );
    expect(await readState(nodeFs, paths)).toEqual({
      revision: 1,
      skills: {
        pdf: {
          source: { kind: "adopted", from: null },
          installedAt: t0,
          enabled: { default: false, except: ["cursor"] },
        },
      },
      agents: {},
      projects: {},
    });
  });
});

describe("enablement", () => {
  const off: Enablement = { default: false, except: [] };
  const on: Enablement = { default: true, except: [] };

  it.each([
    [
      "enable two agents on an off skill",
      off,
      ["codex", "cursor"],
      true,
      { default: false, except: ["cursor", "codex"] },
    ],
    [
      "disable one agent on an on skill",
      on,
      ["codex"],
      false,
      { default: true, except: ["codex"] },
    ],
    [
      "re-enable drops the redundant override",
      { default: true, except: ["codex"] },
      ["codex"],
      true,
      on,
    ],
    ["enable all resets overrides", { default: false, except: ["grok"] }, "all", true, on],
    ["disable all resets overrides", { default: true, except: ["grok"] }, "all", false, off],
  ] as const)("%s", (_name, from, agents, enable, expected) => {
    expect(withAgents(from, agents, enable)).toEqual(expected);
  });

  it("lets agents installed later inherit the default", () => {
    const enablement = withAgents({ default: true, except: [] }, ["codex"], false);
    expect(isEnabled(enablement, "codex")).toBe(false);
    expect(isEnabled(enablement, "goose")).toBe(true);
    expect(isEnabled(withAgents(enablement, ["cursor"], true), "goose")).toBe(true);
  });
});

describe("state patches", () => {
  const track: StateChange = {
    kind: "track",
    skill: pdf,
    source: { kind: "local", path: "/src/pdf" as AbsPath },
    enabled: { default: true, except: [] },
  };

  it("are idempotent and keep installedAt when the same source is tracked again", () => {
    const once = applyChanges(EMPTY_STATE, [track], t0);
    expect(applyChanges(once, [track], t1)).toEqual(once);
    expect(isNoop(once, [track])).toBe(true);
    expect(isNoop(EMPTY_STATE, [track])).toBe(false);
  });

  it("restamp installedAt when the source changes", () => {
    const once = applyChanges(EMPTY_STATE, [track], t0);
    const moved = applyChanges(
      once,
      [{ ...track, source: { kind: "local", path: "/elsewhere" as AbsPath } }],
      t1,
    );
    expect(moved.skills[pdf]?.installedAt).toBe(t1);
  });

  it("untrack, setEnabled, setSource and setAgent edit only what they name", () => {
    const next = applyChanges(
      sample,
      [
        { kind: "untrack", skill: notes },
        { kind: "setEnabled", skill: pdf, enabled: { default: false, except: [] } },
        { kind: "setAgent", agent: "cursor", skillsDir: null, mode: null },
        { kind: "setAgent", agent: "codex", skillsDir: null, mode: "link" },
        {
          kind: "setEnabled",
          skill: "absent" as SkillName,
          enabled: { default: true, except: [] },
        },
      ],
      t1,
    );
    expect(next).toEqual({
      revision: 3,
      skills: { pdf: { ...sample.skills[pdf], enabled: { default: false, except: [] } } },
      agents: { codex: { skillsDir: null, mode: "link" } },
      projects: {},
    });
  });
});

/**
 * The StateStore contract. Every store runs the same cases, so a new backing store is checked by
 * adding one call here.
 */
function storeContract(name: string, open: () => Promise<StateStore>) {
  const track: StateChange = {
    kind: "track",
    skill: pdf,
    source: { kind: "local", path: "/src/pdf" as AbsPath },
    enabled: { default: true, except: [] },
  };

  describe(`${name} store`, () => {
    it("reads nothing recorded as the empty state", async () => {
      expect(await (await open()).read()).toEqual(EMPTY_STATE);
    });

    it("commits at the expected revision and bumps it by one", async () => {
      const store = await open();
      expect(await store.commit(0 as Revision, [track], t0)).toEqual({ kind: "done" });
      const state = await store.read();
      expect(state.revision).toBe(1);
      expect(state.skills[pdf]?.installedAt).toBe(t0);
    });

    it("calls changes already in effect alreadyDone at any revision, writing nothing", async () => {
      const store = await open();
      await store.commit(0 as Revision, [track], t0);
      expect(await store.commit(0 as Revision, [track], t1)).toEqual({ kind: "alreadyDone" });
      expect(await store.read()).toMatchObject({ revision: 1 });
    });

    it("refuses a commit from a revision the store has moved past", async () => {
      const store = await open();
      await store.commit(0 as Revision, [track], t0);
      const untrack: StateChange = { kind: "untrack", skill: pdf };
      expect(await store.commit(0 as Revision, [untrack], t1)).toEqual({
        kind: "moved",
        revision: 1,
      });
      expect((await store.read()).skills[pdf]).toBeDefined();
    });
  });
}

storeContract("json", async () => {
  const { paths } = await stateHome();
  return jsonStateStore(nodeFs, paths);
});

describe("json store", () => {
  it("names state.json and throws StateCorruptError for an unreadable file", async () => {
    const { paths } = await stateHome();
    await mkdir(paths.gandalfDir, { recursive: true });
    await writeFile(paths.stateFile, "{");
    const store = jsonStateStore(nodeFs, paths);
    expect(store.location).toBe(paths.stateFile);
    await expect(store.read()).rejects.toBeInstanceOf(StateCorruptError);
  });
});

import { cp, mkdir, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY_MARKER, classify, contentHash, serializeMarker } from "./disk.js";
import { nodeFs } from "./env.js";
import { reconcileEntry, type VerdictContext } from "./reconcile.js";
import { at, createTempHome, link, writeSkill, writeTree } from "./testkit.js";
import type { ContentHash, Desired, ModeSetting, RootRole, SkillName } from "./types.js";

type Seed = (slot: string, home: string) => Promise<void>;

const library = (home: string) => `${home}/.gandalf/skills`;
const linkTo =
  (skill: string): Seed =>
  (slot, home) =>
    link(`${library(home)}/${skill}`, slot);
const skillDir: Seed = (slot) => writeSkill(slot, "someone-elses");
const foreignLink: Seed = (slot) => link("/opt/elsewhere", slot);
const file: Seed = (slot) => writeFile(slot, "x");
const nothing: Seed = async () => {};

/** A copy of library/alpha with a marker. `drift` edits it after marking, `stale` before. */
function copyOf(skill: string, change: "none" | "drift" | "stale" = "none"): Seed {
  return async (slot, home) => {
    await cp(`${library(home)}/${skill}`, slot, { recursive: true });
    if (change === "stale") await writeFile(`${slot}/older.txt`, "previous version");
    const hash = await contentHash(nodeFs, slot as never);
    await writeFile(`${slot}/${COPY_MARKER}`, serializeMarker({ skill: skill as SkillName, hash }));
    if (change === "drift") await writeFile(`${slot}/SKILL.md`, "edited");
  };
}

interface Row {
  readonly role: RootRole;
  readonly seed: Seed;
  readonly desired: readonly [skill: string, mode: ModeSetting] | null;
  readonly expected: { readonly verdict: string; readonly why?: string } | null;
}

// Library: alpha and beta are valid skills, untracked-lib has no record, nomd has no SKILL.md.
// state.json tracks alpha, beta, nomd and gone (whose library dir does not exist).
const rows: Record<string, Row> = {
  "scan root, owned link": {
    role: "scan",
    seed: linkTo("alpha"),
    desired: null,
    expected: { verdict: "untouched", why: "scanRoot" },
  },
  "scan root, user skill": {
    role: "scan",
    seed: skillDir,
    desired: null,
    expected: { verdict: "unmanaged" },
  },
  "scan root, nothing there": { role: "scan", seed: nothing, desired: null, expected: null },
  "no desire, link to tracked skill": {
    role: "target",
    seed: linkTo("alpha"),
    desired: null,
    expected: { verdict: "extra" },
  },
  "no desire, link to untracked library dir": {
    role: "target",
    seed: linkTo("untracked-lib"),
    desired: null,
    expected: { verdict: "untouched", why: "untracked" },
  },
  "no desire, dangling link to unknown skill": {
    role: "target",
    seed: linkTo("ghost"),
    desired: null,
    expected: { verdict: "extra" },
  },
  "no desire, clean copy": {
    role: "target",
    seed: copyOf("alpha"),
    desired: null,
    expected: { verdict: "extra" },
  },
  "no desire, user skill": {
    role: "target",
    seed: skillDir,
    desired: null,
    expected: { verdict: "unmanaged" },
  },
  "no desire, modified copy": {
    role: "target",
    seed: copyOf("alpha", "drift"),
    desired: null,
    expected: { verdict: "unmanaged" },
  },
  "no desire, foreign link": {
    role: "target",
    seed: foreignLink,
    desired: null,
    expected: { verdict: "unmanaged" },
  },
  "no desire, plain file": {
    role: "target",
    seed: file,
    desired: null,
    expected: { verdict: "unmanaged" },
  },
  "no desire, nothing there": { role: "target", seed: nothing, desired: null, expected: null },
  "desired, absent": {
    role: "target",
    seed: nothing,
    desired: ["alpha", "link"],
    expected: { verdict: "missing" },
  },
  "desired, user skill in the way": {
    role: "target",
    seed: skillDir,
    desired: ["alpha", "auto"],
    expected: { verdict: "conflict" },
  },
  "desired, modified copy in the way": {
    role: "target",
    seed: copyOf("alpha", "drift"),
    desired: ["alpha", "copy"],
    expected: { verdict: "conflict" },
  },
  "desired, foreign link in the way": {
    role: "target",
    seed: foreignLink,
    desired: ["alpha", "link"],
    expected: { verdict: "conflict" },
  },
  "desired link, link present": {
    role: "target",
    seed: linkTo("alpha"),
    desired: ["alpha", "link"],
    expected: { verdict: "ok" },
  },
  "desired auto, link present": {
    role: "target",
    seed: linkTo("alpha"),
    desired: ["alpha", "auto"],
    expected: { verdict: "ok" },
  },
  "desired auto, clean copy present": {
    role: "target",
    seed: copyOf("alpha"),
    desired: ["alpha", "auto"],
    expected: { verdict: "ok" },
  },
  "desired copy, clean copy present": {
    role: "target",
    seed: copyOf("alpha"),
    desired: ["alpha", "copy"],
    expected: { verdict: "ok" },
  },
  "desired, link to another skill": {
    role: "target",
    seed: linkTo("beta"),
    desired: ["alpha", "link"],
    expected: { verdict: "repair", why: "otherSkill" },
  },
  "desired copy, link present": {
    role: "target",
    seed: linkTo("alpha"),
    desired: ["alpha", "copy"],
    expected: { verdict: "repair", why: "wrongMode" },
  },
  "desired link, clean copy present": {
    role: "target",
    seed: copyOf("alpha"),
    desired: ["alpha", "link"],
    expected: { verdict: "repair", why: "wrongMode" },
  },
  "desired copy, copy of an older version": {
    role: "target",
    seed: copyOf("alpha", "stale"),
    desired: ["alpha", "copy"],
    expected: { verdict: "repair", why: "staleCopy" },
  },
  "desired auto, copy of an older version": {
    role: "target",
    seed: copyOf("alpha", "stale"),
    desired: ["alpha", "auto"],
    expected: { verdict: "repair", why: "staleCopy" },
  },
  "desired, library dir has no SKILL.md": {
    role: "target",
    seed: nothing,
    desired: ["nomd", "link"],
    expected: { verdict: "blocked" },
  },
  "desired, library dir gone, dangling link": {
    role: "target",
    seed: linkTo("gone"),
    desired: ["gone", "link"],
    expected: { verdict: "blocked" },
  },
  "desired, library dir gone, user skill": {
    role: "target",
    seed: skillDir,
    desired: ["gone", "auto"],
    expected: { verdict: "conflict" },
  },
};

describe("verdict table", () => {
  let home: string;
  let context: Omit<VerdictContext, "role">;

  beforeAll(async () => {
    home = await createTempHome();
    await writeSkill(`${library(home)}/alpha`, "alpha");
    await writeSkill(`${library(home)}/beta`, "beta");
    await writeSkill(`${library(home)}/untracked-lib`, "untracked-lib");
    await writeTree(library(home), { "nomd/notes.txt": "no SKILL.md" });
    const hashes = new Map<string, ContentHash>();
    for (const name of ["alpha", "beta", "untracked-lib"]) {
      hashes.set(name, await contentHash(nodeFs, at(library(home), name)));
    }
    const tracked = new Set(["alpha", "beta", "nomd", "gone"]);
    context = {
      tracked: (skill) => tracked.has(skill),
      inLibrary: (skill) => ["alpha", "beta", "untracked-lib", "nomd"].includes(skill),
      libraryHash: (skill) => hashes.get(skill) ?? null,
    };
  });

  afterAll(() => rm(home, { recursive: true, force: true }));

  it.each(Object.entries(rows))("%s", async (name, row) => {
    const root = at(home, `.cursor/skills-${Object.keys(rows).indexOf(name)}`);
    await mkdir(root, { recursive: true });
    const slot = at(root, "entry");
    await row.seed(slot, home);
    const observed = await classify(nodeFs, [at(home, ".gandalf/skills")], slot);
    const desired: Desired | null =
      row.desired === null ? null : { skill: row.desired[0] as SkillName, mode: row.desired[1] };
    const reconciled = reconcileEntry(observed, desired, { ...context, role: row.role });
    if (row.expected === null) {
      expect(reconciled).toBeNull();
      return;
    }
    expect(reconciled).toMatchObject(row.expected);
    if (reconciled?.verdict === "extra" || reconciled?.verdict === "repair") {
      expect(["link", "cleanCopy"]).toContain(reconciled.observed.kind);
    }
  });
});

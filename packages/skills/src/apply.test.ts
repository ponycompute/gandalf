import { mkdir, readFile, rename as fsRename, unlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { nodeFs } from "./env.js";
import { openGandalf } from "./gandalf.js";
import { parsePlanToken } from "./parse.js";
import {
  at,
  link,
  seedState,
  tempHome,
  testEnv,
  treeOf,
  writeSkill,
  writeTree,
} from "./testkit.js";
import type { AbsPath, Intent, IsoTime, SkillName } from "./types.js";

const pdf = "pdf" as SkillName;

async function home(): Promise<AbsPath> {
  const h = await tempHome();
  await writeTree(h, { ".cursor/settings.json": "{}", ".claude/settings.json": "{}" });
  await writeSkill(at(h, ".gandalf/skills/pdf"), "pdf");
  await seedState(h, {
    skills: {
      [pdf]: {
        source: { kind: "local", path: null },
        installedAt: "2026-10-01T00:00:00.000Z" as IsoTime,
        enabled: { default: true, except: [] },
      },
    },
  });
  await link(at(h, ".gandalf/skills/pdf"), at(h, ".cursor/skills/pdf"));
  await link(at(h, ".gandalf/skills/pdf"), at(h, ".claude/skills/pdf"));
  return h;
}

const disableCursor: Intent = {
  kind: "setEnabled",
  skill: pdf,
  enabled: false,
  agents: ["cursor"],
};

async function planOf(h: AbsPath, intent: Intent) {
  const outcome = await openGandalf(testEnv(h)).plan(intent);
  if (!outcome.ok) throw new Error(outcome.error.kind);
  return outcome.plan;
}

describe("apply", () => {
  it("returns stale with a fresh plan when disk changed since the preview, writing nothing", async () => {
    const h = await home();
    const plan = await planOf(h, { kind: "setEnabled", skill: pdf, enabled: true, agents: "all" });
    await writeTree(h, { ".codex/config.toml": "" });
    const before = await treeOf(h);
    const result = await openGandalf(testEnv(h)).apply(plan);
    expect(result.kind).toBe("stale");
    // The newly installed agent inherits the skill's default, so the fresh plan links it there.
    expect(
      result.kind === "stale" && result.fresh.ok && result.fresh.plan.steps.map((s) => s.kind),
    ).toEqual(["ensureDir", "link"]);
    expect(await treeOf(h)).toEqual(before);
  });

  it("never runs a forged token: the intent is re-derived and must match the fingerprint", async () => {
    const h = await home();
    const plan = await planOf(h, disableCursor);
    const forged = parsePlanToken({
      intent: { kind: "remove", skill: "pdf" },
      fingerprint: plan.fingerprint,
      steps: [{ kind: "libraryTrash", skill: "pdf" }],
    });
    const before = await treeOf(h);
    expect((await openGandalf(testEnv(h)).apply(forged)).kind).toBe("stale");
    expect(await treeOf(h)).toEqual(before);
  });

  it("reports busy while another live gandalf holds the lock", async () => {
    const h = await home();
    const plan = await planOf(h, disableCursor);
    await writeFile(
      at(h, ".gandalf/lock"),
      JSON.stringify({ pid: 7, since: new Date().toISOString() }),
    );
    const env = { ...testEnv(h), isAlive: (pid: number) => pid === 7 };
    expect(await openGandalf(env).apply(plan)).toMatchObject({ kind: "busy", holder: { pid: 7 } });
  });

  it("replaces a lock left by a dead process", async () => {
    const h = await home();
    const plan = await planOf(h, disableCursor);
    await writeFile(
      at(h, ".gandalf/lock"),
      JSON.stringify({ pid: 7, since: new Date().toISOString() }),
    );
    expect((await openGandalf(testEnv(h)).apply(plan)).kind).toBe("applied");
    await expect(readFile(at(h, ".gandalf/lock"))).rejects.toThrow();
  });

  it("puts back a user's entry that replaced our link mid-apply and still records the intent", async () => {
    const h = await home();
    const slot = at(h, ".cursor/skills/pdf");
    const userDir = at(h, "user-pdf");
    await writeSkill(userDir, "pdf", { "mine.txt": "the user's" });
    let swapped = false;
    const env = testEnv(h, {
      fs: {
        rename: async (from, to) => {
          if (from === slot && !swapped) {
            swapped = true;
            await unlink(slot);
            await fsRename(userDir, slot);
          }
          return nodeFs.rename(from, to);
        },
      },
    });
    const gandalf = openGandalf(env);
    const outcome = await gandalf.plan(disableCursor);
    if (!outcome.ok) throw new Error(outcome.error.kind);
    const result = await gandalf.apply(outcome.plan);
    expect(result.kind === "applied" && result.results.map((r) => [r.step.kind, r.status])).toEqual(
      [
        ["unlink", "drifted"],
        ["commitState", "done"],
      ],
    );
    expect(await readFile(at(h, ".cursor/skills/pdf/mine.txt"), "utf8")).toBe("the user's");
    const state = JSON.parse(await readFile(at(h, ".gandalf/state.json"), "utf8"));
    expect(state.skills.pdf.enabled).toEqual({ default: true, except: ["cursor"] });
  });

  it("skips creations on a slot whose removal drifted", async () => {
    const h = await home();
    await mkdir(at(h, ".gandalf/skills/other"));
    await writeSkill(at(h, ".gandalf/skills/other"), "other");
    await unlink(at(h, ".claude/skills/pdf"));
    await link(at(h, ".gandalf/skills/other"), at(h, ".claude/skills/pdf"));
    const slot = at(h, ".claude/skills/pdf");
    const env = testEnv(h, {
      fs: {
        rename: async (from, to) => {
          if (from === slot) {
            await unlink(slot);
            await writeSkill(slot, "pdf");
          }
          return nodeFs.rename(from, to);
        },
      },
    });
    const gandalf = openGandalf(env);
    const outcome = await gandalf.plan({ kind: "sync", skills: "all" });
    if (!outcome.ok) throw new Error(outcome.error.kind);
    const result = await gandalf.apply(outcome.plan);
    expect(result.kind === "applied" && result.results.map((r) => [r.step.kind, r.status])).toEqual(
      [
        ["unlink", "drifted"],
        ["link", "skipped"],
      ],
    );
  });
});

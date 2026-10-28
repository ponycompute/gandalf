// The lever for crash safety: crash before every mutating Fs call of a real apply, re-run, and
// require the same end state as an uninterrupted run, with every unmanaged byte intact.

import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contentHash } from "./disk.js";
import { nodeFs, type Env } from "./env.js";
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
import type { AbsPath, ContentHash, Intent, IsoTime, SkillName } from "./types.js";

/**
 * cursor, claude_code, codex and grok are installed; grok has no skills dir yet. pdf is tracked and
 * enabled for cursor only. my-notes is a user skill with identical bytes in claude and cursor and
 * different bytes in codex. codex holds a user dir named pdf, and cursor a foreign symlink.
 */
async function seedHome(): Promise<AbsPath> {
  const home = await tempHome();
  await writeTree(home, { ".grok/config.toml": "" });
  await writeSkill(at(home, ".gandalf/skills/pdf"), "pdf", { "tool.sh": "echo pdf\n" });
  await seedState(home, {
    skills: {
      ["pdf" as SkillName]: {
        source: { kind: "local", path: null },
        installedAt: "2026-10-01T00:00:00.000Z" as IsoTime,
        enabled: { default: false, except: ["cursor"] },
      },
    },
  });
  await link(at(home, ".gandalf/skills/pdf"), at(home, ".cursor/skills/pdf"));
  for (const agent of [".claude", ".cursor"]) {
    await writeTree(at(home, `${agent}/skills/my-notes`), {
      "SKILL.md": skillMd("my-notes"),
      "notes.md": "shared notes\n",
    });
  }
  await writeTree(at(home, ".codex/skills/my-notes"), {
    "SKILL.md": skillMd("my-notes"),
    "notes.md": "codex's own notes\n",
  });
  await writeSkill(at(home, ".codex/skills/pdf"), "pdf", { "mine.txt": "the user's pdf\n" });
  await link("/nonexistent/elsewhere", at(home, ".cursor/skills/elsewhere"));
  return home;
}

const USER_ENTRIES = [
  ".claude/skills/my-notes",
  ".cursor/skills/my-notes",
  ".codex/skills/my-notes",
  ".codex/skills/pdf",
];

/** Content hashes of every top-level dir in agent dirs, the library, and trash. */
async function hashesEverywhere(home: AbsPath): Promise<Set<ContentHash>> {
  const found = new Set<ContentHash>();
  const dirs = [
    ".claude/skills",
    ".cursor/skills",
    ".codex/skills",
    ".grok/skills",
    ".gandalf/skills",
    ".gandalf/trash",
  ];
  for (const dir of dirs) {
    const entries = await readdir(at(home, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory())
        found.add(await contentHash(nodeFs, at(home, `${dir}/${entry.name}`)));
    }
  }
  return found;
}

async function userHashes(home: AbsPath): Promise<ContentHash[]> {
  return Promise.all(USER_ENTRIES.map((entry) => contentHash(nodeFs, at(home, entry))));
}

const notesA = async (home: AbsPath) => contentHash(nodeFs, at(home, ".claude/skills/my-notes"));

interface Scenario {
  readonly intent: (home: AbsPath) => Promise<Intent>;
  /** What an uninterrupted run must have done, checked on the reference home. */
  readonly expect: (home: AbsPath, tree: string[]) => Promise<void>;
}

const libraryLink = (agent: string, skill: string) =>
  `${agent}/skills/${skill} link ~/.gandalf/skills/${skill}`;

const scenarios: Record<string, Scenario> = {
  "enable pdf for every agent": {
    intent: async () => ({
      kind: "setEnabled",
      skill: "pdf" as SkillName,
      enabled: true,
      agents: "all",
    }),
    expect: async (_home, tree) => {
      expect(tree).toContain(libraryLink(".claude", "pdf"));
      expect(tree).toContain(libraryLink(".grok", "pdf"));
      expect(tree).toContain(libraryLink(".cursor", "pdf"));
      expect(tree).toContain(".codex/skills/pdf/mine.txt file the user's pdf\n");
    },
  },
  "disable pdf for cursor": {
    intent: async () => ({
      kind: "setEnabled",
      skill: "pdf" as SkillName,
      enabled: false,
      agents: ["cursor"],
    }),
    expect: async (_home, tree) => {
      expect(tree.some((line) => line.startsWith(".cursor/skills/pdf "))).toBe(false);
    },
  },
  "adopt my-notes picking the claude and cursor copy": {
    intent: async (home) => ({
      kind: "adopt",
      names: ["my-notes" as SkillName],
      pick: [{ name: "my-notes" as SkillName, kind: "hash", hash: await notesA(home) }],
    }),
    expect: async (home, tree) => {
      expect(tree).toContain(libraryLink(".claude", "my-notes"));
      expect(tree).toContain(libraryLink(".cursor", "my-notes"));
      expect(tree).toContain(".codex/skills/my-notes/notes.md file codex's own notes\n");
      expect(tree).toContain(".gandalf/skills/my-notes/notes.md file shared notes\n");
      expect(await recordedState(home)).toMatchObject({
        skills: { "my-notes": { enabled: { default: false, except: ["cursor", "claude_code"] } } },
      });
    },
  },
  "remove pdf": {
    intent: async () => ({ kind: "remove", skill: "pdf" as SkillName }),
    expect: async (_home, tree) => {
      expect(tree.filter((line) => line.includes("/pdf") && line.includes(" link "))).toEqual([]);
      expect(tree.some((line) => line.startsWith(".gandalf/skills/pdf"))).toBe(false);
      expect(tree).toContain(".codex/skills/pdf/mine.txt file the user's pdf\n");
    },
  },
  "move cursor to another skills dir": {
    intent: async (home) => ({
      kind: "configureAgent",
      agent: "cursor",
      skillsDir: at(home, "work/cursor-skills"),
      mode: null,
    }),
    expect: async (_home, tree) => {
      expect(tree).toContain("work/cursor-skills/pdf link ~/.gandalf/skills/pdf");
      expect(tree.some((line) => line.startsWith(".cursor/skills/pdf "))).toBe(false);
      expect(tree).toContain(".cursor/skills/elsewhere link /nonexistent/elsewhere");
    },
  },
  "adopt my-notes from codex": {
    intent: async () => ({
      kind: "adopt",
      names: ["my-notes" as SkillName],
      pick: [{ name: "my-notes" as SkillName, kind: "agent", agent: "codex" }],
    }),
    expect: async (_home, tree) => {
      expect(tree).toContain(libraryLink(".codex", "my-notes"));
      expect(tree).toContain(".gandalf/skills/my-notes/notes.md file codex's own notes\n");
      expect(tree).toContain(".claude/skills/my-notes/notes.md file shared notes\n");
    },
  },
};

/**
 * Re-running the intent must finish the work. A crash after the last step leaves nothing for a
 * remove to do, which it reports as unknownSkill; the tree comparison still decides.
 */
async function rerun(env: Env, intent: Intent): Promise<void> {
  const outcome = await openGandalf(env).plan(intent);
  if (intent.kind === "remove" && !outcome.ok && outcome.error.kind === "unknownSkill") return;
  await run(env, intent);
}

describe("apply converges after a crash at any mutation", () => {
  it.each(Object.entries(scenarios))("%s", async (_name, scenario) => {
    const referenceHome = await seedHome();
    const seeded = await userHashes(referenceHome);
    const counter = { n: 0 };
    await run(testEnv(referenceHome, { counter }), await scenario.intent(referenceHome));
    const reference = await treeOf(referenceHome);
    await scenario.expect(referenceHome, reference);
    expect(counter.n).toBeGreaterThan(3);

    for (let n = 1; n <= counter.n; n += 1) {
      const home = await seedHome();
      const intent = await scenario.intent(home);
      await expect(run(testEnv(home, { crashAt: n, pid: 1 }), intent)).rejects.toThrow(
        "SimulatedCrash",
      );
      // pid 1 is dead from here on, so the lock it left behind is stale.
      await rerun(testEnv(home, { pid: 2 }), intent);
      expect(await treeOf(home), `crash before mutation ${n}`).toEqual(reference);
      const everywhere = await hashesEverywhere(home);
      for (const hash of seeded) expect(everywhere, `crash before mutation ${n}`).toContain(hash);
    }
  });
});

describe("install re-run after a crash converges on the recorded commit", () => {
  async function seedInstall() {
    const home = await tempHome();
    await writeTree(home, { ".cursor/settings.json": "{}", ".claude/settings.json": "{}" });
    const remote = await gitRemote(at(home, "repo"), {
      "SKILL.md": skillMd("pdf"),
      "tool.sh": "v1",
    });
    const intent: Intent = {
      kind: "install",
      source: { kind: "git", url: remote.url, ref: null, subpath: null, skill: null, commit: null },
      agents: "all",
    };
    return { home, remote, intent };
  }

  /** The tree without the fixture repo, with this home's commit ids replaced by version labels. */
  async function normalized(home: AbsPath, commits: Record<string, string>) {
    return (await treeOf(home))
      .filter((line) => !line.startsWith("repo"))
      .map((line) =>
        Object.entries(commits).reduce((text, [label, id]) => text.split(id).join(label), line),
      );
  }

  it("reuses the commit in state.json once the crashed run recorded it", async () => {
    const reference = await seedInstall();
    const counter = { n: 0 };
    await run(testEnv(reference.home, { counter }), reference.intent);
    const v1 = await normalized(reference.home, { "<v1>": reference.remote.commit });
    expect(v1).toContain(".gandalf/skills/pdf/tool.sh file v1");

    const later = await seedInstall();
    const v2commit = await commitTo(at(later.home, "repo"), { "tool.sh": "v2" });
    await run(testEnv(later.home), later.intent);
    const v2 = await normalized(later.home, { "<v1>": later.remote.commit, "<v2>": v2commit });

    let recordedRuns = 0;
    for (let n = 1; n <= counter.n; n += 1) {
      const { home, remote, intent } = await seedInstall();
      await expect(run(testEnv(home, { crashAt: n, pid: 1 }), intent)).rejects.toThrow(
        "SimulatedCrash",
      );
      const state = JSON.stringify(await recordedState(home));
      const recorded = state.includes(remote.commit);
      const moved = await commitTo(at(home, "repo"), { "tool.sh": "v2" });
      await run(testEnv(home, { pid: 2 }), intent);
      const tree = await normalized(home, { "<v1>": remote.commit, "<v2>": moved });
      expect(tree, `crash before mutation ${n}`).toEqual(recorded ? v1 : v2);
      if (recorded) recordedRuns += 1;
    }
    expect(recordedRuns).toBeGreaterThan(0);
  });
});

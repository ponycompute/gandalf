// The lever for crash safety: crash before every mutating Fs call of a real apply, re-run, and
// require the same end state as an uninterrupted run, with every unmanaged byte intact.

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contentHash } from "./disk.js";
import { nodeFs } from "./env.js";
import {
  at,
  link,
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
      expect(JSON.parse(await readFile(at(home, ".gandalf/state.json"), "utf8"))).toMatchObject({
        skills: { "my-notes": { enabled: { default: false, except: ["cursor", "claude_code"] } } },
      });
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
      await run(testEnv(home, { pid: 2 }), intent);
      expect(await treeOf(home), `crash before mutation ${n}`).toEqual(reference);
      const everywhere = await hashesEverywhere(home);
      for (const hash of seeded) expect(everywhere, `crash before mutation ${n}`).toContain(hash);
    }
  });
});

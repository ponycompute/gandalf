import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { nodeEnv, openGandalf, parseIntent } from "@gandalf/skills";

const run = promisify(execFile);

type Seed = (home: string) => Promise<void>;

export const FIXTURES = {
  empty: async () => {},
  twoAgents,
  conflict: async (home) => {
    await twoAgents(home);
    await writeTree(home, {
      ".cursor/skills/demo/SKILL.md": skillMd("demo", "The demo you placed by hand"),
      ".cursor/skills/demo/notes.txt": "the user's own bytes",
    });
  },
  adoptChoice: async (home) => {
    await agents(home, [".claude", ".cursor", ".codex"]);
    await writeTree(home, {
      ".claude/skills/review/SKILL.md": skillMd(
        "review",
        "Review a PR",
        "The Claude Code variant.",
      ),
      ".cursor/skills/review/SKILL.md": skillMd("review", "Review a PR", "The Cursor variant."),
      ".claude/skills/notes/SKILL.md": skillMd("notes", "Project notes"),
      ".codex/skills/notes/SKILL.md": skillMd("notes", "Project notes"),
    });
  },
  /** Three skills you placed, each with copies that agree, and nothing in the library. */
  threeAgreeing: async (home) => {
    await agents(home, [".claude", ".cursor"]);
    for (const name of ["alpha", "bravo", "charlie"]) {
      await writeTree(home, {
        [`.claude/skills/${name}/SKILL.md`]: skillMd(name, `The ${name} skill`),
        [`.cursor/skills/${name}/SKILL.md`]: skillMd(name, `The ${name} skill`),
      });
    }
  },
  /** Two 400-line versions of handbook whose every line differs. */
  longDiff: async (home) => {
    await agents(home, [".claude", ".cursor"]);
    const body = (variant: string) =>
      Array.from({ length: 400 }, (_, n) => `Step ${n + 1}: the ${variant} way.`).join("\n");
    await writeTree(home, {
      ".claude/skills/handbook/SKILL.md": skillMd("handbook", "House rules", body("Claude Code")),
      ".cursor/skills/handbook/SKILL.md": skillMd("handbook", "House rules", body("Cursor")),
    });
  },
  /** A skill you placed only in ~/.agents/skills, the folder Codex and GitHub Copilot read. */
  scanRoot: async (home) => {
    await agents(home, [".claude", ".codex", ".copilot"]);
    await writeTree(home, {
      ".agents/skills/shared-notes/SKILL.md": skillMd("shared-notes", "Notes every agent reads"),
    });
  },
  gitSource: async (home) => {
    await agents(home, [".claude", ".cursor"]);
    const work = join(home, "repo-work");
    await writeTree(work, { "skills/review/SKILL.md": skillMd("review", "Review a PR", "v1") });
    await git(home, work, "init", "--quiet", "--initial-branch=main");
    await git(home, work, "add", ".");
    await git(home, work, "commit", "--quiet", "-m", "v1");
    await git(home, home, "clone", "--quiet", "--bare", work, join(home, "review.git"));
    await apply(home, {
      kind: "install",
      source: { kind: "git", url: join(home, "review.git"), subpath: "skills/review" },
      agents: "all",
    });
  },
  realShaped: async (home) => {
    await agents(home, OPERATOR_AGENT_DIRS);
    for (const [name, description] of LIBRARY) {
      await writeTree(home, { [`src/${name}/SKILL.md`]: skillMd(name, description) });
      await apply(home, {
        kind: "install",
        source: { kind: "local", path: join(home, "src", name) },
        agents: ["claude_code", "cursor"],
      });
    }
    const elsewhere = join(home, ".local/share/ego/ego-skills");
    await writeTree(elsewhere, { "SKILL.md": skillMd("ego-browser", "A browser skill") });
    const names = userSkillNames(80);
    for (const [root, mix] of REAL_MIX) {
      for (const name of names.slice(mix.skillDirs.from, mix.skillDirs.to)) {
        await writeTree(join(home, root, name), { "SKILL.md": skillMd(name, `${name} skill`) });
      }
      for (let n = 0; n < mix.notSkills; n += 1) {
        await writeTree(join(home, root, `tool-${n}`), { "README.md": "not a skill" });
      }
      for (let n = 0; n < mix.brokenLinks; n += 1) {
        await link(join(home, ".agents/skills", `gone-${n}`), join(home, root, `gone-${n}`));
      }
      if (mix.foreignLink) await link(elsewhere, join(home, root, "ego-browser"));
    }
  },
  manySkills: async (home) => {
    await agents(home, [".claude", ".cursor"]);
    for (let n = 1; n <= 200; n += 1) {
      const name = `skill-${String(n).padStart(3, "0")}`;
      await writeTree(join(home, ".gandalf/skills", name), {
        "SKILL.md": skillMd(name, `Fixture skill ${n} of 200`),
      });
    }
  },
} as const satisfies Record<string, Seed>;

export type Fixture = keyof typeof FIXTURES;

export async function seedHome(fixture: Fixture): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), `gandalf-${fixture}-`)));
  try {
    await FIXTURES[fixture](home);
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  return home;
}

export async function withHome<T>(
  fixture: Fixture,
  work: (home: string) => Promise<T>,
): Promise<T> {
  const home = await seedHome(fixture);
  try {
    return await work(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function listTree(dir: string): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (path: string, rel: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) lines.push(`${relPath} -> ${await readlink(child)}`);
      else if (entry.isDirectory()) {
        lines.push(`${relPath}/`);
        await walk(child, relPath);
      } else {
        const digest = createHash("sha256")
          .update(await readFile(child))
          .digest("hex");
        lines.push(`${relPath} ${digest}`);
      }
    }
  };
  await walk(dir, "");
  return lines.sort();
}

async function twoAgents(home: string): Promise<void> {
  await agents(home, [".claude", ".cursor"]);
  await writeTree(home, { "src/demo/SKILL.md": skillMd("demo", "A demo skill") });
  await apply(home, {
    kind: "install",
    source: { kind: "local", path: join(home, "src/demo") },
    agents: ["claude_code"],
  });
}

const OPERATOR_AGENT_DIRS = [
  ".cursor",
  ".claude",
  ".omp/agent",
  ".codex",
  ".grok",
  ".gemini/antigravity",
  ".config/agents",
  ".kilocode",
  ".roo",
  ".config/goose",
  ".gemini",
  ".copilot",
];

const LIBRARY = [
  ["pdf-tools", "Fill and merge PDF forms"],
  ["review-pull-request", "Review a PR against the team checklist"],
  ["deploy-preview", "Ship a preview build"],
  ["release-notes", "Draft release notes from merged work"],
  ["my-notes", "Personal project notes"],
  ["design-review", "Critique a screen against the design system"],
  ["test-audit", "Find tests that assert nothing"],
  ["docs-writer", "Write docs in the house style"],
  ["browser-check", "Drive a browser to verify a change"],
  ["git-hygiene", "Tidy branches and commits"],
  ["api-client", "Call the team's internal APIs"],
  ["sql-helper", "Write and explain SQL"],
] as const;

interface RootMix {
  readonly skillDirs: { readonly from: number; readonly to: number };
  readonly notSkills: number;
  readonly brokenLinks: number;
  readonly foreignLink: boolean;
}

const REAL_MIX: readonly (readonly [string, RootMix])[] = [
  [
    ".agents/skills",
    { skillDirs: { from: 0, to: 20 }, notSkills: 0, brokenLinks: 0, foreignLink: true },
  ],
  [
    ".claude/skills",
    { skillDirs: { from: 20, to: 22 }, notSkills: 48, brokenLinks: 37, foreignLink: true },
  ],
  [
    ".gemini/skills",
    { skillDirs: { from: 10, to: 75 }, notSkills: 6, brokenLinks: 1, foreignLink: true },
  ],
  [
    ".config/goose/skills",
    { skillDirs: { from: 0, to: 0 }, notSkills: 0, brokenLinks: 7, foreignLink: true },
  ],
  [
    ".grok/skills",
    { skillDirs: { from: 75, to: 76 }, notSkills: 0, brokenLinks: 0, foreignLink: true },
  ],
  [
    ".kilocode/skills",
    { skillDirs: { from: 0, to: 0 }, notSkills: 0, brokenLinks: 1, foreignLink: true },
  ],
  [
    ".roo/skills",
    { skillDirs: { from: 75, to: 76 }, notSkills: 0, brokenLinks: 0, foreignLink: false },
  ],
  [
    ".config/agents/skills",
    { skillDirs: { from: 0, to: 0 }, notSkills: 0, brokenLinks: 0, foreignLink: true },
  ],
];

function userSkillNames(count: number): string[] {
  const topics = ["cloud", "browser", "design", "deploy", "auth", "docs", "test", "data"];
  const kinds = [
    "kit",
    "guide",
    "check",
    "audit",
    "flow",
    "helper",
    "notes",
    "review",
    "cli",
    "sdk",
  ];
  return topics.flatMap((topic) => kinds.map((kind) => `${topic}-${kind}`)).slice(0, count);
}

function skillMd(name: string, description: string, body = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

async function agents(home: string, detectDirs: readonly string[]): Promise<void> {
  for (const dir of detectDirs) await mkdir(join(home, dir), { recursive: true });
}

async function writeTree(base: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(dirname(join(base, relative)), { recursive: true });
    await writeFile(join(base, relative), contents);
  }
}

async function link(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
}

async function git(home: string, cwd: string, ...args: string[]): Promise<void> {
  await run(
    "git",
    ["-c", "user.name=gandalf-e2e", "-c", "user.email=e2e@gandalf.invalid", ...args],
    {
      cwd,
      env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
}

async function apply(home: string, intent: unknown): Promise<void> {
  const gandalf = openGandalf(nodeEnv({ home }));
  const planned = await gandalf.plan(parseIntent(intent));
  if (!planned.ok) throw new Error(`fixture plan failed: ${JSON.stringify(planned.error)}`);
  const outcome = await gandalf.apply(planned.plan);
  const complete =
    outcome.kind === "applied" &&
    outcome.results.every((r) => r.status === "done" || r.status === "alreadyDone");
  if (!complete) throw new Error(`fixture apply incomplete: ${JSON.stringify(outcome)}`);
}

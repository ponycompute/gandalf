// End-to-end lever: the built `gandalf` binary against a throwaway HOME. It needs only `pnpm build`
// and git on PATH, and rebuilds its whole world on every run.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const run = promisify(execFile);

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let home = "";
let seeded = { pdf: [] as string[], mine: [] as string[] };

async function gandalf(...args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof failed.code !== "number") throw error;
    return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function json<T>(...args: string[]): Promise<T> {
  const result = await gandalf("--json", ...args);
  return JSON.parse(result.stdout) as T;
}

async function writeTree(base: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(dirname(join(base, relative)), { recursive: true });
    await writeFile(join(base, relative), contents);
  }
}

/** Every path under `dir` with its kind and, for files and links, a digest of what it holds. */
async function tree(dir: string, skip: readonly string[] = []): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (path: string, rel: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (skip.includes(relPath)) continue;
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

async function kind(relative: string): Promise<"link" | "dir" | "file" | "absent"> {
  try {
    const stats = await lstat(join(home, relative));
    if (stats.isSymbolicLink()) return "link";
    return stats.isDirectory() ? "dir" : "file";
  } catch {
    return "absent";
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.name=gandalf-e2e", "-c", "user.email=e2e@gandalf.invalid", ...args],
    { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } },
  );
  return stdout.trim();
}

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`;

interface Entry {
  readonly root: string;
  readonly name: string;
  readonly verdict: string;
  readonly observed: { readonly kind: string };
}

interface Problem {
  readonly kind: string;
}

interface PlanJson {
  readonly plan: {
    readonly steps: readonly { readonly kind: string }[];
    readonly notDone: readonly { readonly kind: string }[];
  };
}

const USER_FILES = {
  // A skill the user wrote by hand. gandalf may move it into the library on adopt, never edit it.
  ".claude/skills/mine/SKILL.md": skillMd("mine", "the user's own skill"),
  ".claude/skills/mine/notes/todo.txt": "keep these bytes",
  // The user's own `pdf`, unrelated to the library's. It must survive every command untouched.
  ".codex/skills/pdf/SKILL.md": skillMd("pdf", "the user's pdf, not gandalf's"),
};

describe("gandalf binary against a temp HOME", () => {
  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "gandalf-e2e-")));
    await writeTree(home, {
      ".cursor/settings.json": "{}",
      ...USER_FILES,
      "src/pdf/SKILL.md": skillMd("pdf", "the library's pdf"),
    });
    seeded = {
      pdf: await tree(join(home, ".codex/skills/pdf")),
      mine: await tree(join(home, ".claude/skills/mine")),
    };
  });

  afterAll(async () => {
    if (home !== "") await rm(home, { recursive: true, force: true });
  });

  it("detects the three agents", async () => {
    const { agents } = await json<{ agents: { id: string; installed: boolean }[] }>("agents");
    expect(agents.filter((agent) => agent.installed).map((agent) => agent.id)).toEqual([
      "cursor",
      "claude_code",
      "codex",
    ]);
  });

  it("scan classifies the user's entries as unmanaged", async () => {
    const entries = await json<Entry[]>("skills", "scan");
    expect(
      entries.map((e) => [e.root.slice(home.length), e.name, e.verdict, e.observed.kind]),
    ).toEqual([
      ["/.claude/skills", "mine", "unmanaged", "skillDir"],
      ["/.codex/skills", "pdf", "unmanaged", "skillDir"],
    ]);
  });

  it("install links into free slots and reports the occupied one as a conflict", async () => {
    const result = await gandalf("skills", "install", "src/pdf");
    expect(result.code).toBe(0);
    expect(await kind(".gandalf/skills/pdf")).toBe("dir");
    expect(await readlink(join(home, ".cursor/skills/pdf"))).toBe(
      join(home, ".gandalf/skills/pdf"),
    );
    expect(await readlink(join(home, ".claude/skills/pdf"))).toBe(
      join(home, ".gandalf/skills/pdf"),
    );
    expect(await kind(".codex/skills/pdf")).toBe("dir");
    expect(result.stdout).toContain("conflict");
  });

  it("status exits 2 while the conflict stands, and 0 once pdf is off for codex", async () => {
    const before = await gandalf("--json", "status");
    expect(before.code).toBe(2);
    expect((JSON.parse(before.stdout) as { problems: Problem[] }).problems).toEqual([
      expect.objectContaining({ kind: "conflict" }),
    ]);
    expect((await gandalf("skills", "disable", "pdf", "--agent", "codex")).code).toBe(0);
    expect(await gandalf("status")).toMatchObject({ code: 0, stdout: "clean\n" });
  });

  it("adopt moves the user's skill into the library and links it back", async () => {
    expect((await gandalf("skills", "adopt", "mine")).code).toBe(0);
    expect(await readlink(join(home, ".claude/skills/mine"))).toBe(
      join(home, ".gandalf/skills/mine"),
    );
    expect(await tree(join(home, ".gandalf/skills/mine"))).toEqual(seeded.mine);
  });

  it("enable and disable create and remove links", async () => {
    expect((await gandalf("skills", "enable", "mine")).code).toBe(0);
    expect(await kind(".cursor/skills/mine")).toBe("link");
    expect(await kind(".codex/skills/mine")).toBe("link");
    expect((await gandalf("skills", "disable", "mine", "--agent", "cursor")).code).toBe(0);
    expect(await kind(".cursor/skills/mine")).toBe("absent");
    expect(await kind(".codex/skills/mine")).toBe("link");
  });

  it("status exits 2 on drift; sync --dry-run prints the repair and writes nothing", async () => {
    await unlink(join(home, ".codex/skills/mine"));
    const status = await json<{ problems: Problem[] }>("status");
    expect(status.problems.map((problem) => problem.kind)).toEqual(["drift"]);
    expect((await gandalf("status")).code).toBe(2);

    const before = await tree(home);
    const preview = await gandalf("skills", "sync", "--dry-run");
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("link  ~/.codex/skills/mine -> ~/.gandalf/skills/mine");
    expect(preview.stdout).toContain("dry run: nothing was written");
    const previewJson = await json<PlanJson>("skills", "sync", "--dry-run");
    expect(previewJson.plan.steps.map((step) => step.kind)).toEqual(["link"]);
    expect(await tree(home)).toEqual(before);

    expect((await gandalf("skills", "sync")).code).toBe(0);
    expect(await kind(".codex/skills/mine")).toBe("link");
    expect((await gandalf("status")).code).toBe(0);
  });

  it("installs a pinned commit from a local bare repo and updates it", async () => {
    const work = join(home, "repo-work");
    await writeTree(work, { "skills/review/SKILL.md": skillMd("review", "v1") });
    await git(work, "init", "--quiet", "--initial-branch=main");
    await git(work, "add", ".");
    await git(work, "commit", "--quiet", "-m", "v1");
    const first = await git(work, "rev-parse", "HEAD");
    await git(home, "clone", "--quiet", "--bare", work, join(home, "review.git"));

    const install = await gandalf("skills", "install", "review.git", "--subpath", "skills/review");
    expect(install.code).toBe(0);
    expect(await readFile(join(home, ".claude/skills/review/SKILL.md"), "utf8")).toContain("v1");
    const state = JSON.parse(await readFile(join(home, ".gandalf/state.json"), "utf8")) as {
      skills: Record<string, { source: { kind: string; commit: string } }>;
    };
    expect(state.skills.review?.source).toMatchObject({ kind: "git", commit: first });

    await writeTree(work, { "skills/review/SKILL.md": skillMd("review", "v2") });
    await git(work, "commit", "--quiet", "-am", "v2");
    await git(work, "push", "--quiet", join(home, "review.git"), "main");
    const preview = await json<PlanJson>("skills", "update", "--dry-run");
    expect(preview.plan.steps.map((step) => step.kind)).toEqual(["libraryReplace", "commitState"]);
    expect(await readFile(join(home, ".gandalf/skills/review/SKILL.md"), "utf8")).toContain("v1");
    expect((await gandalf("skills", "update")).code).toBe(0);
    expect(await readFile(join(home, ".cursor/skills/review/SKILL.md"), "utf8")).toContain("v2");
    expect(await gandalf("status")).toMatchObject({ code: 0, stdout: "clean\n" });
  });

  it("copies a skill into a project's agent dirs, lists it, and takes it out again", async () => {
    await writeTree(home, { "work/api/README.md": "api\n" });
    expect((await gandalf("projects", "add", "work/api")).code).toBe(0);
    const enable = await gandalf("skills", "enable", "mine", "--project", "work/api");
    expect(enable.code).toBe(0);
    for (const dir of [".cursor/skills", ".claude/skills", ".agents/skills"]) {
      expect(await kind(`work/api/${dir}/mine`)).toBe("dir");
      expect(await tree(join(home, `work/api/${dir}/mine`))).toEqual(seeded.mine);
    }
    const listed = await gandalf("projects");
    expect(listed.stdout).toContain("~/work/api  (cursor, claude_code, codex)");
    expect(listed.stdout).toMatch(/mine\s+●\s+●\s+●/);
    expect(await gandalf("status")).toMatchObject({ code: 0, stdout: "clean\n" });

    expect(
      await gandalf("skills", "enable", "mine", "--project", "work/api", "--agent", "cursor"),
    ).toMatchObject({ code: 1 });
    expect((await gandalf("skills", "disable", "mine", "--project", "work/api")).code).toBe(0);
    expect(await readdir(join(home, "work/api/.claude/skills"))).toEqual([]);
    expect((await gandalf("projects", "remove", "work/api")).code).toBe(0);
    expect((await gandalf("projects")).stdout).toContain("no projects");
  });

  it("never changed the bytes of the user's own entries", async () => {
    expect(await tree(join(home, ".codex/skills/pdf"))).toEqual(seeded.pdf);
    expect(await tree(join(home, ".gandalf/skills/mine"))).toEqual(seeded.mine);
  });

  it("rejects bad input with exit 1 and writes nothing", async () => {
    const before = await tree(home);
    expect(await gandalf("skills", "enable", "../escape")).toMatchObject({ code: 1 });
    expect(await gandalf("skills", "remove", "nope")).toMatchObject({
      code: 1,
      stderr: "gandalf: unknown skill nope\n",
    });
    expect(await tree(home)).toEqual(before);
  });
});

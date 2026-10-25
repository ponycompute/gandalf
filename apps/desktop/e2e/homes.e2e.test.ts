import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { listTree, withHome } from "./homes";
import { gandalfCli } from "./lever";

const run = promisify(execFile);

interface PlanJson {
  readonly plan: {
    readonly steps: readonly { readonly kind: string }[];
    readonly notDone: readonly {
      readonly kind: string;
      readonly name?: string;
      readonly entry?: { readonly path: string };
      readonly variants?: readonly unknown[];
    }[];
  };
}

function planOf(json: unknown): PlanJson["plan"] {
  return (json as PlanJson).plan;
}

describe("each fixture keeps the promise its doc comment makes", () => {
  it("conflict: enabling demo in Cursor stops at the dir you placed there", async () => {
    await withHome("conflict", async (home) => {
      const before = await listTree(home);
      const cli = await gandalfCli(home, [
        "skills",
        "enable",
        "demo",
        "--agent",
        "cursor",
        "--dry-run",
      ]);
      const plan = planOf(cli.json);
      expect(plan.notDone).toEqual([
        expect.objectContaining({
          kind: "conflict",
          entry: expect.objectContaining({ path: join(home, ".cursor/skills/demo") }),
        }),
      ]);
      expect(plan.steps.filter((step) => step.kind === "link")).toEqual([]);
      expect(await listTree(home)).toEqual(before);
    });
  });

  it("adoptChoice: review needs a choice between two variants, notes does not", async () => {
    await withHome("adoptChoice", async (home) => {
      const review = await gandalfCli(home, ["skills", "adopt", "review", "--dry-run"]);
      expect(review.code).toBe(2);
      expect(planOf(review.json).notDone).toEqual([
        expect.objectContaining({ kind: "needsChoice", name: "review" }),
      ]);
      expect(planOf(review.json).notDone[0]?.variants).toHaveLength(2);

      const notes = await gandalfCli(home, ["skills", "adopt", "notes", "--dry-run"]);
      expect(notes.code).toBe(0);
      expect(planOf(notes.json).notDone).toEqual([]);
      expect(planOf(notes.json).steps.map((step) => step.kind)).toContain("adoptMove");
    });
  });

  it("gitSource: review comes from ~/review.git, and a pushed commit is an update", async () => {
    await withHome("gitSource", async (home) => {
      const skills = (await gandalfCli(home, ["skills", "list"])).json as readonly {
        readonly name: string;
        readonly source: { readonly kind: string; readonly url: string } | null;
      }[];
      expect(skills.map((skill) => [skill.name, skill.source?.kind, skill.source?.url])).toEqual([
        ["review", "git", join(home, "review.git")],
      ]);
      const idle = await gandalfCli(home, ["skills", "update", "--dry-run"]);
      expect(planOf(idle.json).steps).toEqual([]);

      const work = join(home, "repo-work");
      const git = (...args: string[]) =>
        run(
          "git",
          ["-c", "user.name=gandalf-e2e", "-c", "user.email=e2e@gandalf.invalid", ...args],
          { cwd: work, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } },
        );
      await writeFile(
        join(work, "skills/review/SKILL.md"),
        "---\nname: review\ndescription: Review a PR\n---\n\nv2\n",
      );
      await git("commit", "--quiet", "-am", "v2");
      await git("push", "--quiet", join(home, "review.git"), "main");
      const update = await gandalfCli(home, ["skills", "update", "--dry-run"]);
      expect(planOf(update.json).steps.map((step) => step.kind)).toEqual([
        "libraryReplace",
        "commitState",
      ]);
    });
  });
});

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  nodeEnv,
  openGandalf,
  type AgentId,
  type Intent,
  type PlanError,
  type SourceSpec,
} from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import { planGit } from "../../main/git";
import type { AppError } from "../../shared/ipc";
import type { Flow } from "../changes/writeFlow";
import {
  agentSelection,
  emptyDraft,
  expandHome,
  formProblem,
  installIntent,
  sourceSpec,
  type InstallDraft,
} from "./form";

const HOME = "/Users/me";
const exec = promisify(execFile);

type GitSpec = Extract<SourceSpec, { kind: "git" }>;
const INSTALLED = ["claude_code", "cursor"] as AgentId[];

function draft(fields: Partial<InstallDraft>): InstallDraft {
  return { ...emptyDraft(INSTALLED), ...fields };
}

describe("sourceSpec", () => {
  it("builds a local source for a folder", () => {
    expect(sourceSpec(draft({ folder: "/Users/me/skills/pdf-tools" }), HOME)).toEqual({
      ok: true,
      value: { kind: "local", path: "/Users/me/skills/pdf-tools" },
    });
  });

  it("reads ~ in a folder as the home folder and trims the spaces a paste leaves", () => {
    expect(sourceSpec(draft({ folder: "  ~/skills/pdf-tools " }), HOME)).toEqual({
      ok: true,
      value: { kind: "local", path: "/Users/me/skills/pdf-tools" },
    });
  });

  it("keeps the folder panel's spelling of a chosen folder while Folder still shows it", () => {
    // HOME runs through a symlink, so ~ expands to another spelling than the panel's realpath.
    const chosen = { shown: "~/src", path: "/private/var/h/src" };
    expect(sourceSpec(draft({ folder: "~/src", chosen }), "/var/h")).toEqual({
      ok: true,
      value: { kind: "local", path: "/private/var/h/src" },
    });
    expect(sourceSpec(draft({ folder: "~/src/a", chosen }), "/var/h")).toEqual({
      ok: true,
      value: { kind: "local", path: "/var/h/src/a" },
    });
  });

  it("builds a git source with a ref", () => {
    expect(
      sourceSpec(
        draft({ source: "git", url: "https://github.com/acme/skills.git", ref: "v1.2" }),
        HOME,
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "git",
        url: "https://github.com/acme/skills.git",
        ref: "v1.2",
        subpath: null,
        commit: null,
      },
    });
  });

  it("builds a git source with a subpath, without the ./ or trailing / around it", () => {
    expect(
      sourceSpec(draft({ source: "git", url: "~/review.git", subpath: "./skills/review/" }), HOME),
    ).toEqual({
      ok: true,
      value: {
        kind: "git",
        url: "/Users/me/review.git",
        ref: null,
        subpath: "skills/review",
        commit: null,
      },
    });
  });

  it("builds a git source with both a ref and a subpath", () => {
    expect(
      sourceSpec(
        draft({ source: "git", url: "git@github.com:acme/skills.git", ref: "main", subpath: "a" }),
        HOME,
      ),
    ).toMatchObject({ ok: true, value: { ref: "main", subpath: "a" } });
  });

  it("uses only the shown source's fields", () => {
    const both = draft({ folder: "/Users/me/x", url: "https://example.invalid/y.git" });
    expect(sourceSpec(both, HOME)).toMatchObject({ ok: true, value: { kind: "local" } });
    expect(sourceSpec({ ...both, source: "git" }, HOME)).toMatchObject({
      ok: true,
      value: { kind: "git", url: "https://example.invalid/y.git" },
    });
  });

  it("asks for a folder that is missing or not a full path", () => {
    expect(sourceSpec(draft({ folder: " " }), HOME)).toEqual({
      ok: false,
      field: "folder",
      message: "Choose the folder that contains SKILL.md.",
    });
    expect(sourceSpec(draft({ folder: "skills/pdf-tools" }), HOME)).toMatchObject({
      ok: false,
      field: "folder",
    });
  });

  it("refuses a relative repository path, which git would read against gandalf's cache", () => {
    const git = (url: string) => sourceSpec(draft({ source: "git", url }), HOME);
    for (const url of ["skills-repo", "../repo", "./repo.git", "repo/x:y"]) {
      expect(git(url), url).toMatchObject({ ok: false, field: "url" });
    }
    for (const url of [
      "/srv/repo.git",
      "~/repo.git",
      "https://github.com/acme/skills.git",
      "ssh://git@host/acme/skills.git",
      "file:///srv/repo.git",
      "git@github.com:acme/skills.git",
    ]) {
      expect(git(url), url).toMatchObject({ ok: true });
    }
  });

  it("drops a trailing / from a repository, which the core would take as another origin", () => {
    expect(sourceSpec(draft({ source: "git", url: "~/review.git//" }), HOME)).toMatchObject({
      ok: true,
      value: { url: "/Users/me/review.git" },
    });
  });

  it("says ~name is not read as another user's home folder", () => {
    const message = "gandalf reads ~ only as your home folder. Enter the full path instead.";
    expect(sourceSpec(draft({ folder: "~root/src" }), HOME)).toEqual({
      ok: false,
      field: "folder",
      message,
    });
    expect(sourceSpec(draft({ source: "git", url: "~root/r.git" }), HOME)).toEqual({
      ok: false,
      field: "url",
      message,
    });
  });

  it("refuses what git would read as an option, and a subpath out of the repository", () => {
    const git = (fields: Partial<InstallDraft>) =>
      sourceSpec(draft({ source: "git", url: "https://example.invalid/r.git", ...fields }), HOME);
    expect(git({ url: "" })).toMatchObject({ ok: false, field: "url" });
    expect(git({ url: "--upload-pack=x" })).toMatchObject({ ok: false, field: "url" });
    expect(git({ ref: "-x" })).toMatchObject({ ok: false, field: "ref" });
    for (const subpath of ["/etc", "../up", "a/../../b", "a/-x"]) {
      expect(git({ subpath }), subpath).toMatchObject({ ok: false, field: "subpath" });
    }
  });
});

describe("agentSelection", () => {
  it("sends all when every installed agent is checked, as the CLI does", () => {
    expect(agentSelection(["cursor", "claude_code"] as AgentId[], INSTALLED)).toBe("all");
  });

  it("sends the checked agents in installed order", () => {
    const three = ["claude_code", "cursor", "codex"] as AgentId[];
    expect(agentSelection(["codex", "claude_code"] as AgentId[], three)).toEqual([
      "claude_code",
      "codex",
    ]);
  });

  it("returns null when none is checked", () => {
    expect(agentSelection([], INSTALLED)).toBeNull();
  });

  it("sends the checked agents, not all, while an installed agent is hidden from the form", () => {
    expect(agentSelection(["cursor", "claude_code"] as AgentId[], INSTALLED, true)).toEqual(
      INSTALLED,
    );
  });

  it("sends all with no agent to show, so the skill goes to the library and later agents", () => {
    expect(agentSelection([], [])).toBe("all");
  });
});

describe("installIntent", () => {
  it("plans an install of the source into the chosen agents", () => {
    expect(
      installIntent(draft({ folder: "/s/demo", agents: ["cursor"] as AgentId[] }), INSTALLED, HOME),
    ).toEqual({
      ok: true,
      value: {
        kind: "install",
        source: { kind: "local", path: "/s/demo" },
        agents: ["cursor"],
      },
    });
  });

  it("asks for an agent when none is checked", () => {
    expect(installIntent(draft({ folder: "/s/demo", agents: [] }), INSTALLED, HOME)).toEqual({
      ok: false,
      field: "agents",
      message: "Choose at least one agent to link it into.",
    });
  });
});

describe("expandHome", () => {
  it("expands only a leading ~ or ~/", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("~/a", HOME)).toBe("/Users/me/a");
    expect(expandHome("~other/a", HOME)).toBe("~other/a");
    expect(expandHome("/a/~/b", HOME)).toBe("/a/~/b");
  });
});

describe("formProblem", () => {
  const local: Intent = {
    kind: "install",
    source: { kind: "local", path: "/s/empty" as never },
    agents: "all",
  };
  const git = (subpath: string | null): Intent => ({
    kind: "install",
    source: { kind: "git", url: "/r.git", ref: null, subpath, commit: null },
    agents: "all",
  });
  const refused = (intent: Intent, error: PlanError): Flow => ({
    kind: "failed",
    intent,
    failure: { kind: "refused", error },
    stale: false,
  });
  const errored = (intent: Intent, error: AppError): Flow => ({
    kind: "failed",
    intent,
    failure: { kind: "error", error },
    stale: false,
  });
  const badSource = (reason: string): PlanError => ({ kind: "badSource", reason });

  it("says a folder has no SKILL.md in the README's words", () => {
    expect(formProblem(refused(local, badSource("no SKILL.md in /s/empty")))).toEqual({
      field: "folder",
      message: "No SKILL.md in this folder. Choose a folder that contains one.",
      detail: null,
    });
  });

  it("puts a repository's missing SKILL.md on the subpath, or on the URL without one", () => {
    const reason = "no SKILL.md in /h/.gandalf/cache/x";
    expect(formProblem(refused(git("skills/a"), badSource(reason)))).toMatchObject({
      field: "subpath",
      detail: null,
    });
    expect(formProblem(refused(git(null), badSource(reason)))).toMatchObject({
      field: "url",
      detail: null,
    });
  });

  it("shows git's own message for a repository it could not fetch", () => {
    const reason = "fatal: '/nowhere.git' does not appear to be a git repository";
    expect(formProblem(refused(git(null), badSource(reason)))).toEqual({
      field: "url",
      message:
        "gandalf could not fetch this repository. Check the URL and the branch or tag, then click Install.",
      detail: reason,
    });
  });

  it("puts a source field the core refused on its own field, without the field's prefix", () => {
    const error: AppError = {
      kind: "badInput",
      field: "source.ref",
      message: "source.ref: must be a non-empty string not starting with '-'",
    };
    expect(formProblem(errored(git(null), error))).toEqual({
      field: "ref",
      message:
        "gandalf cannot use this value (must be a non-empty string not starting with '-'). Change it, then click Install.",
      detail: null,
    });
  });

  /**
   * The core's refusal of `source` as main plans it, with the app's git, against a repository in a
   * temp HOME: git's own words, never typed here. The repository has skills/a on main, and an
   * empty one has no commit at all.
   */
  async function coreRefusal(source: Partial<GitSpec> & { readonly empty?: boolean }) {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gandalf-form-")));
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    const run = (cwd: string, ...args: string[]) =>
      exec("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd, env });
    try {
      const repo = join(home, "repo");
      await mkdir(join(repo, "skills/a"), { recursive: true });
      await run(repo, "init", "--quiet", "--initial-branch=main");
      if (source.empty !== true) {
        await writeFile(join(repo, "skills/a/SKILL.md"), "---\nname: a\ndescription: A\n---\n");
        await run(repo, "add", ".");
        await run(repo, "commit", "--quiet", "-m", "a");
      }
      const intent: Intent = {
        kind: "install",
        source: { kind: "git", url: repo, ref: null, subpath: null, commit: null, ...source },
        agents: "all",
      };
      const gandalf = openGandalf({ ...nodeEnv({ home }), git: planGit(home).git });
      const outcome = await gandalf.plan(intent);
      if (outcome.ok) throw new Error("the core planned it");
      return { intent, error: outcome.error };
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  it("puts a Folder the commit does not have on Folder, not on Repository", async () => {
    const { intent, error } = await coreRefusal({ subpath: "skills/nope" });
    expect(formProblem(refused(intent, error))).toEqual({
      field: "subpath",
      message:
        "The repository has no folder by this name. Check the spelling, or leave it empty when SKILL.md is at the top.",
      detail: null,
    });
  });

  it("puts an unknown branch or tag on Branch or tag, naming it", async () => {
    const { intent, error } = await coreRefusal({ ref: "nope", subpath: "skills/a" });
    expect(formProblem(refused(intent, error))).toEqual({
      field: "ref",
      message:
        "The repository has no branch or tag named nope. Check the name, or leave it empty for the default branch.",
      detail: null,
    });
    const empty = await coreRefusal({ empty: true });
    expect(formProblem(refused(empty.intent, empty.error))).toMatchObject({
      field: "ref",
      message: "The repository has no default branch. Enter a branch or tag.",
    });
  });

  it("says a local folder that is not there is missing, not that it lacks SKILL.md", () => {
    expect(formProblem(refused(local, badSource("no folder at /s/empty")))).toEqual({
      field: "folder",
      message: "No folder at this path. Choose another.",
      detail: null,
    });
  });

  it("leaves nameTaken, other errors and other intents to the sync sheet", () => {
    expect(formProblem(refused(local, { kind: "nameTaken", skill: "demo" as never }))).toBeNull();
    expect(formProblem(errored(local, { kind: "internal", message: "boom" }))).toBeNull();
    const remove: Intent = { kind: "remove", skill: "demo" as never };
    expect(formProblem(refused(remove, badSource("no SKILL.md in /x")))).toBeNull();
    expect(formProblem({ kind: "idle" })).toBeNull();
  });
});

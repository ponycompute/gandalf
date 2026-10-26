import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError } from "@gandalf/skills";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANCELLED, mayFetch, planGit, subcommand } from "./git";

/**
 * A stand-in for git. A fetch writes its pid and starts a child that holds its stdout, as a
 * transport would; both hang until a file named release appears. env prints the environment; all
 * else, and a released fetch, print the arguments after the flags main adds.
 */
const FAKE_GIT = `#!/bin/sh
here="$(dirname "$0")"
[ "$3" = env ] && exec env
for arg; do
  if [ "$arg" = fetch ]; then
    echo $$ > "$here/fetch.pid"
    (while [ ! -e "$here/release" ]; do sleep 0.05; done) &
    echo $! > "$here/transport.pid"
    while [ ! -e "$here/release" ]; do sleep 0.05; done
    break
  fi
done
shift 2
echo "$@"
`;

/** A local intent, and ones that may fetch. */
const LOCAL = { kind: "remove", skill: "demo" };
const FETCH = { kind: "update", skills: "all", pins: [] };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("planGit", () => {
  let dir = "";
  let command = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gandalf-git-"));
    command = join(dir, "git");
    await writeFile(command, FAKE_GIT);
    await chmod(command, 0o755);
  });

  afterEach(async () => {
    // Frees any fetch a case left waiting before its folder goes.
    await writeFile(join(dir, "release"), "");
    await new Promise((done) => setTimeout(done, 200));
    await rm(dir, { recursive: true, force: true });
  });

  const options = () => ({ cwd: dir as never });

  it("runs git with the core's flags and returns its output", async () => {
    const { git } = planGit(dir, command);
    expect(await git(["rev-parse", "HEAD"], options())).toBe("rev-parse HEAD\n");
  });

  it("runs git with the core's environment, in C so its messages stay in English", async () => {
    process.env.LC_ALL = "de_DE.UTF-8";
    try {
      const { git } = planGit(dir, command);
      const env = (await git(["env"], options())).split("\n");
      expect(env).toEqual(
        expect.arrayContaining([`HOME=${dir}`, "GIT_TERMINAL_PROMPT=0", "LC_ALL=C", "LANG=C"]),
      );
    } finally {
      delete process.env.LC_ALL;
    }
  });

  it("kills a plan's hung fetch on cancel, and refuses the fetches it starts after", async () => {
    const runner = planGit(dir, command);
    const started = Date.now();
    const plan = runner.plan(FETCH, () => runner.git(["fetch", "--quiet"], options()));
    await new Promise((done) => setTimeout(done, 100));
    runner.cancel();
    await expect(plan).rejects.toBeInstanceOf(GitError);
    expect(Date.now() - started).toBeLessThan(5000);

    const later = runner.plan(FETCH, async () => {
      await new Promise((done) => setTimeout(done, 10));
      return runner.git(["fetch"], options());
    });
    const next = runner.plan(FETCH, () => runner.git(["fetch"], options()));
    runner.cancel();
    await expect(later).rejects.toThrow(CANCELLED);
    await expect(next).rejects.toThrow(CANCELLED);
  });

  it("lets a cancelled plan's other git commands run, and a plan after the cancel fetch", async () => {
    const runner = planGit(dir, command);
    const cancelled = runner.plan(FETCH, async () => {
      runner.cancel();
      return runner.git(["cat-file", "-e", "x"], options());
    });
    expect(await cancelled).toBe("cat-file -e x\n");
    const fresh = runner.plan(FETCH, () => runner.git(["fetch", "--quiet"], options()));
    await new Promise((done) => setTimeout(done, 100));
    // Still running: the cancel came before this plan, so it does not reach it.
    let settled = false;
    void fresh.finally(() => (settled = true)).catch(() => undefined);
    await new Promise((done) => setTimeout(done, 100));
    expect(settled).toBe(false);
    runner.cancel();
    await expect(fresh).rejects.toBeInstanceOf(GitError);
  });

  it("starts a plan only once the one before it has settled", async () => {
    const runner = planGit(dir, command);
    const order: string[] = [];
    const first = runner.plan(FETCH, async () => {
      await new Promise((done) => setTimeout(done, 50));
      order.push("first");
      throw new Error("first failed");
    });
    const second = runner.plan(FETCH, async () => {
      order.push("second");
      return "second";
    });
    await expect(first).rejects.toThrow("first failed");
    expect(await second).toBe("second");
    expect(order).toEqual(["first", "second"]);
  });

  it("kills a cancelled fetch's own children too, such as its transport", async () => {
    const runner = planGit(dir, command);
    const plan = runner.plan(FETCH, () => runner.git(["fetch", "--quiet"], options()));
    const pid = async (name: string) => Number(await readFile(join(dir, name), "utf8"));
    await expect
      .poll(() => readFile(join(dir, "transport.pid"), "utf8").catch(() => ""))
      .not.toBe("");
    const [fetch, transport] = [await pid("fetch.pid"), await pid("transport.pid")];
    expect([alive(fetch), alive(transport)]).toEqual([true, true]);
    runner.cancel();
    // The transport held git's stdout, so the plan settles only once it is gone too.
    await expect(plan).rejects.toBeInstanceOf(GitError);
    await expect.poll(() => [alive(fetch), alive(transport)]).toEqual([false, false]);
  });

  it("runs a plan that cannot fetch at once, never behind a hung fetch", async () => {
    const runner = planGit(dir, command);
    const hung = runner.plan(FETCH, () => runner.git(["fetch"], options()));
    void hung.catch(() => undefined);
    await expect.poll(() => readFile(join(dir, "fetch.pid"), "utf8").catch(() => "")).not.toBe("");
    expect(await runner.plan(LOCAL, () => runner.git(["status"], options()))).toBe("status\n");
    // A local plan is not the queue's, so a cancel leaves its git alone, and still ends the fetch.
    runner.cancel();
    await expect(hung).rejects.toBeInstanceOf(GitError);
  });

  it("never kills a fetch outside a plan, such as an apply's", async () => {
    const runner = planGit(dir, command);
    const fetch = runner.git(["fetch"], options());
    let settled = false;
    void fetch.finally(() => (settled = true)).catch(() => undefined);
    runner.cancel();
    await new Promise((done) => setTimeout(done, 200));
    expect(settled).toBe(false);
    await writeFile(join(dir, "release"), "");
    expect(await fetch).toBe("fetch\n");
  }, 10_000);
});

describe("subcommand", () => {
  it("finds the subcommand past git's leading options and their values", () => {
    expect(subcommand(["fetch", "--quiet"])).toBe("fetch");
    expect(subcommand(["-c", "a=b", "-C", "/repo", "--no-pager", "fetch"])).toBe("fetch");
    expect(subcommand(["-c", "fetch=x", "rev-parse"])).toBe("rev-parse");
    expect(subcommand(["--bare"])).toBeNull();
  });
});

describe("mayFetch", () => {
  it("queues an update and an install from git, and nothing local", () => {
    expect(mayFetch(FETCH)).toBe(true);
    expect(mayFetch({ kind: "install", source: { kind: "git", url: "/r.git" } })).toBe(true);
    expect(mayFetch({ kind: "install", source: { kind: "local", path: "/a" } })).toBe(false);
    for (const kind of ["sync", "setEnabled", "adopt", "remove", "configureAgent"]) {
      expect(mayFetch({ kind }), kind).toBe(false);
    }
  });

  it("queues a payload of a shape it does not know, which the core refuses anyway", () => {
    for (const intent of [null, "update", {}, { kind: "fetchAll" }, { kind: "install" }]) {
      expect(mayFetch(intent)).toBe(true);
    }
  });
});

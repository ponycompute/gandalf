import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_CANCELLED, GitCancelled, GitError, nodeGit } from "./env.js";
import type { AbsPath } from "./types.js";

/**
 * A stand-in for git. A fetch writes its pid and starts a child that holds its stdout, as a
 * transport would; both hang until a file named release appears. env prints the environment, out
 * and err write that many bytes to stdout and stderr, and all else, and a released fetch, prints
 * every argument, the flags nodeGit adds included.
 */
const FAKE_GIT = `#!/bin/sh
here="$(dirname "$0")"
case "$3" in
  env) exec env ;;
  out) head -c "$4" /dev/zero; head -c "$5" /dev/zero >&2; exit 0 ;;
esac
for arg; do
  if [ "$arg" = fetch ]; then
    echo $$ > "$here/fetch.pid"
    (while [ ! -e "$here/release" ]; do sleep 0.05; done) &
    echo $! > "$here/transport.pid"
    while [ ! -e "$here/release" ]; do sleep 0.05; done
    break
  fi
done
echo "$@"
`;

const MB = 1024 * 1024;

/**
 * Whether `pid` still runs in process group `group`. kill(pid, 0) cannot tell: a killed transport is
 * an orphan, and stays a zombie that kill(pid, 0) still finds until whatever reaps orphans gets to
 * it, which in a container whose init does not reap is never. The group keeps a pid reused after the
 * zombie goes from counting.
 */
function running(pid: number, group: number): boolean {
  try {
    let state: string, pgid: string;
    if (process.platform === "linux") {
      // pid (comm) state ppid pgrp ..., where comm may itself hold spaces and parentheses.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      [state = "", , pgid = ""] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    } else {
      // ps exits non-zero, so throws, when there is no such process.
      const ps = execFileSync("ps", ["-o", "stat=,pgid=", "-p", String(pid)], { encoding: "utf8" });
      [state = "", pgid = ""] = ps.trim().split(/\s+/);
    }
    return !/^[ZX]/.test(state) && Number(pgid) === group;
  } catch {
    return false;
  }
}

describe("nodeGit", () => {
  let dir = "" as AbsPath;
  let command = "";

  beforeEach(async () => {
    dir = (await mkdtemp(join(tmpdir(), "gandalf-git-"))) as AbsPath;
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

  const pid = async (name: string) => Number(await readFile(join(dir, name), "utf8"));
  const started = () =>
    expect.poll(() => readFile(join(dir, "transport.pid"), "utf8").catch(() => "")).not.toBe("");

  it("runs git with ext transports refused and returns its output", async () => {
    const git = nodeGit(dir, command);
    expect(await git(["rev-parse", "HEAD"], { cwd: dir })).toBe(
      "-c protocol.ext.allow=never rev-parse HEAD\n",
    );
  });

  it("pins HOME, never prompts, and speaks C so git's messages stay in English", async () => {
    process.env.LC_ALL = "de_DE.UTF-8";
    process.env.LANG = "de_DE.UTF-8";
    try {
      const env = (await nodeGit(dir, command)(["env"], { cwd: dir })).split("\n");
      expect(env).toEqual(
        expect.arrayContaining([`HOME=${dir}`, "GIT_TERMINAL_PROMPT=0", "LC_ALL=C", "LANG=C"]),
      );
    } finally {
      delete process.env.LC_ALL;
      delete process.env.LANG;
    }
  });

  it("rejects a non-zero exit with a GitError carrying stderr", async () => {
    const failing = join(dir, "failing");
    await writeFile(failing, "#!/bin/sh\necho 'fatal: no such ref' >&2\nexit 128\n");
    await chmod(failing, 0o755);
    const run = nodeGit(dir, failing)(["fetch"], { cwd: dir });
    await expect(run).rejects.toBeInstanceOf(GitError);
    await expect(run).rejects.toThrow("fatal: no such ref");
  });

  it("caps each stream at 64 MB on its own, as execFile's maxBuffer does", async () => {
    const git = nodeGit(dir, command);
    const both = await git(["out", String(40 * MB), String(40 * MB)], { cwd: dir });
    expect(both.length).toBe(40 * MB);
    await expect(git(["out", String(65 * MB), "0"], { cwd: dir })).rejects.toThrow(
      "wrote more than 64 MB to stdout",
    );
    await expect(git(["out", "0", String(65 * MB)], { cwd: dir })).rejects.toThrow(
      "wrote more than 64 MB to stderr",
    );
  }, 20_000);

  it("rejects at once without spawning when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = nodeGit(dir, command)(["fetch"], { cwd: dir, signal: controller.signal });
    await expect(run).rejects.toBeInstanceOf(GitCancelled);
    await expect(run).rejects.toThrow(GIT_CANCELLED);
    await new Promise((done) => setTimeout(done, 200));
    await expect(readFile(join(dir, "fetch.pid"), "utf8")).rejects.toThrow();
  });

  it("kills a hung fetch with its own children, such as its transport, on abort", async () => {
    const controller = new AbortController();
    const begun = Date.now();
    const run = nodeGit(dir, command)(["fetch", "--quiet"], {
      cwd: dir,
      signal: controller.signal,
    });
    await started();
    const [fetch, transport] = [await pid("fetch.pid"), await pid("transport.pid")];
    // A git with a signal leads its own group, and its transport runs in it.
    expect([running(fetch, fetch), running(transport, fetch)]).toEqual([true, true]);
    controller.abort();
    // The transport held git's stdout, so git settles only once it is gone too.
    await expect(run).rejects.toBeInstanceOf(GitCancelled);
    expect(Date.now() - begun).toBeLessThan(5000);
    await expect
      .poll(() => [running(fetch, fetch), running(transport, fetch)])
      .toEqual([false, false]);
  });

  it("leaves a git with a signal that never aborts alone", async () => {
    const controller = new AbortController();
    const run = nodeGit(dir, command)(["fetch"], { cwd: dir, signal: controller.signal });
    await started();
    await writeFile(join(dir, "release"), "");
    expect(await run).toBe("-c protocol.ext.allow=never fetch\n");
    controller.abort();
  });
});

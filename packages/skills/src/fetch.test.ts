import { mkdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sha256 } from "./disk.js";
import { GitCancelled, layout, type Env, type GitRunner } from "./env.js";
import { openGandalf } from "./gandalf.js";
import { fetchCommit } from "./library.js";
import { at, gitRemote, skillMd, tempHome, testEnv, writeTree } from "./testkit.js";
import type { AbsPath } from "./types.js";

/** `env` with each fetch held until the test lets it through, and a log of when each ran. */
function heldFetches(env: Env) {
  const log: string[] = [];
  const held: (() => void)[] = [];
  const git: GitRunner = async (args, options) => {
    if (!args.includes("fetch")) return env.git(args, options);
    const url = args[args.indexOf("--") + 1] ?? "";
    log.push(`start ${url}`);
    await new Promise<void>((done) => held.push(done));
    try {
      return await env.git(args, options);
    } finally {
      log.push(`end ${url}`);
    }
  };
  return { env: { ...env, git }, log, release: () => held.shift()?.() };
}

const lockOf = (h: AbsPath, url: string) =>
  at(h, `.gandalf/cache/git/${sha256(url).slice(0, 16)}.lock`);
const settledSoon = () => new Promise((done) => setTimeout(done, 150));
/** A lock file as a holder with `pid` writes it, `ageMs` before the test clock's now. */
const lockBody = (env: Env, pid: number, ageMs = 0) =>
  JSON.stringify({ pid, since: new Date(env.now().getTime() - ageMs).toISOString() });

async function remotes(h: AbsPath) {
  const one = await gitRemote(at(h, "one"), { "SKILL.md": skillMd("one") });
  const two = await gitRemote(at(h, "two"), { "SKILL.md": skillMd("two") });
  return { one, two };
}

describe("the fetch lock", () => {
  it("runs two plans' fetches of one repository one after the other", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    const held = heldFetches(testEnv(h));
    const paths = layout(h, held.env.now);
    const first = fetchCommit(held.env, paths, one.url, null);
    const second = fetchCommit(held.env, paths, one.url, null);
    await expect.poll(() => held.log.length).toBe(1);
    await settledSoon();
    expect(held.log).toEqual([`start ${one.url}`]);
    held.release();
    await expect.poll(() => held.log.length).toBe(3);
    held.release();
    expect(await Promise.all([first, second])).toEqual([one.commit, one.commit]);
    expect(held.log).toEqual([
      `start ${one.url}`,
      `end ${one.url}`,
      `start ${one.url}`,
      `end ${one.url}`,
    ]);
  });

  it("serializes another process's fetch of the same repository by the lock file", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    const both = (pid: number) => ({ ...testEnv(h, { pid }), isAlive: () => true });
    const app = heldFetches(both(1));
    const cli = heldFetches(both(2));
    const paths = layout(h, app.env.now);
    const first = fetchCommit(app.env, paths, one.url, null);
    await expect.poll(() => app.log.length).toBe(1);
    expect(JSON.parse(await readFile(lockOf(h, one.url), "utf8"))).toMatchObject({ pid: 1 });
    const second = fetchCommit(cli.env, paths, one.url, null);
    await settledSoon();
    expect(cli.log).toEqual([]);
    app.release();
    await expect.poll(() => cli.log.length).toBe(1);
    cli.release();
    expect(await Promise.all([first, second])).toEqual([one.commit, one.commit]);
    await expect(readFile(lockOf(h, one.url))).rejects.toThrow();
  });

  it("lets fetches of different repositories run at once", async () => {
    const h = await tempHome();
    const { one, two } = await remotes(h);
    const held = heldFetches(testEnv(h));
    const paths = layout(h, held.env.now);
    const first = fetchCommit(held.env, paths, one.url, null);
    const second = fetchCommit(held.env, paths, two.url, null);
    await expect.poll(() => held.log.length).toBe(2);
    held.release();
    held.release();
    expect(await Promise.all([first, second])).toEqual([one.commit, two.commit]);
  });

  it("takes over a lock left by a process that died", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    const env = testEnv(h);
    await writeTree(h, { [lockOf(h, one.url).slice(h.length + 1)]: lockBody(env, 4242) });
    expect(await fetchCommit(env, layout(h, env.now), one.url, null)).toBe(one.commit);
    await expect(readFile(lockOf(h, one.url))).rejects.toThrow();
  });

  it("takes over a lock held longer than ten minutes, though its pid answers", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    const env = { ...testEnv(h), isAlive: () => true };
    await writeTree(h, {
      [lockOf(h, one.url).slice(h.length + 1)]: lockBody(env, 4242, 11 * 60 * 1000),
    });
    expect(await fetchCommit(env, layout(h, env.now), one.url, null)).toBe(one.commit);
  });

  it("lets only one of several processes break the same stale lock, so none fetch together", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    const pids = [11, 12, 13, 14, 15, 16];
    let running = 0;
    let most = 0;
    const racer = (pid: number): Env => {
      const base = testEnv(h, { pid });
      // Each racer removes what it found stale a little later than the one before, as processes
      // that arrive together do, so a later one would remove the lock an earlier one just took.
      const env: Env = {
        ...base,
        isAlive: (other) => pids.includes(other),
        fs: {
          ...base.fs,
          unlink: async (path) => {
            await new Promise((done) => setTimeout(done, (pid - 11) * 15));
            return base.fs.unlink(path);
          },
        },
      };
      const git: GitRunner = async (args, options) => {
        if (!args.includes("fetch")) return env.git(args, options);
        running += 1;
        most = Math.max(most, running);
        try {
          return await env.git(args, options);
        } finally {
          await new Promise((done) => setTimeout(done, 20));
          running -= 1;
        }
      };
      return { ...env, git };
    };
    const first = racer(pids[0] ?? 0);
    await writeTree(h, { [lockOf(h, one.url).slice(h.length + 1)]: lockBody(first, 4242) });
    const paths = layout(h, first.now);
    const commits = await Promise.all(
      pids.map((pid) => fetchCommit(racer(pid), paths, one.url, null)),
    );
    expect(commits).toEqual(pids.map(() => one.commit));
    expect(most).toBe(1);
    await expect(readFile(lockOf(h, one.url))).rejects.toThrow();
    await expect(readFile(`${lockOf(h, one.url)}.break`)).rejects.toThrow();
  });

  it("waits, without spinning, on something other than a file at the lock's path", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    await mkdir(lockOf(h, one.url), { recursive: true });
    const base = testEnv(h);
    let attempts = 0;
    const env: Env = {
      ...base,
      fs: {
        ...base.fs,
        writeFileExclusive: (path, data) => {
          attempts += 1;
          return base.fs.writeFileExclusive(path, data);
        },
      },
    };
    const controller = new AbortController();
    const waiting = fetchCommit(env, layout(h, env.now), one.url, null, controller.signal);
    await new Promise((done) => setTimeout(done, 300));
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(GitCancelled);
    expect(attempts).toBeLessThan(10);
  });

  it("rejects a wait for a live process's lock as cancelled on abort, leaving its lock", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    const env = { ...testEnv(h), isAlive: (pid: number) => pid === 1 || pid === 4242 };
    const holder = lockBody(env, 4242);
    await writeTree(h, { [lockOf(h, one.url).slice(h.length + 1)]: holder });
    const controller = new AbortController();
    const waiting = fetchCommit(env, layout(h, env.now), one.url, null, controller.signal);
    await settledSoon();
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(GitCancelled);
    expect(await readFile(lockOf(h, one.url), "utf8")).toBe(holder);
  });

  it("rejects a plan waiting its turn in this process on abort, and the queue moves on", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    const held = heldFetches(testEnv(h));
    const paths = layout(h, held.env.now);
    const first = fetchCommit(held.env, paths, one.url, null);
    await expect.poll(() => held.log.length).toBe(1);
    const controller = new AbortController();
    const waiting = fetchCommit(held.env, paths, one.url, null, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(GitCancelled);
    held.release();
    expect(await first).toBe(one.commit);
    const third = fetchCommit(held.env, paths, one.url, null);
    await expect.poll(() => held.log.length).toBe(3);
    held.release();
    expect(await third).toBe(one.commit);
  });
});

describe("a plan's signal", () => {
  it("rejects a git install as cancelled, not as a bad source, once it has aborted", async () => {
    const h = await tempHome();
    const { one } = await remotes(h);
    const controller = new AbortController();
    controller.abort();
    const outcome = openGandalf(testEnv(h)).plan(
      {
        kind: "install",
        source: { kind: "git", url: one.url, ref: null, subpath: null, commit: null },
        agents: "all",
      },
      { signal: controller.signal },
    );
    await expect(outcome).rejects.toBeInstanceOf(GitCancelled);
  });

  it("stops a local plan after its local steps", async () => {
    const h = await tempHome();
    const controller = new AbortController();
    controller.abort();
    const outcome = openGandalf(testEnv(h)).plan(
      { kind: "sync", skills: "all" },
      { signal: controller.signal },
    );
    await expect(outcome).rejects.toBeInstanceOf(GitCancelled);
  });
});

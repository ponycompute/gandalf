// The central library (~/.gandalf/skills/<name>/) and the sources skills come from.
//
// The library directory listing is the truth for which skills exist. The dir name is the skill's
// identity. Frontmatter `name` decides the dir name on intake (install, adopt) and is linted after.

import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { contentHash, sha256 } from "./disk.js";
import {
  GitCancelled,
  GitError,
  errorCode,
  within,
  type Env,
  type Fs,
  type GandalfPath,
  type Layout,
  type StagingPath,
} from "./env.js";
import { intakeName, parseFrontmatter } from "./frontmatter.js";
import { parseSkillName } from "./parse.js";
import type {
  AbsPath,
  ContentHash,
  GitCommit,
  Materialize,
  PlanError,
  RepoSkill,
  RepoSkillsOutcome,
  SkillIssue,
  SkillName,
  SourceSpec,
} from "./types.js";

export interface LibrarySkill {
  readonly name: SkillName;
  readonly dir: AbsPath;
  /** Content hash of the dir, valid or not, so removal can verify what it trashes. */
  readonly hash: ContentHash;
  /** Has a SKILL.md. Only valid skills are ever linked or copied. */
  readonly valid: boolean;
  readonly description: string | null;
  readonly issues: readonly SkillIssue[];
}

export interface LibraryListing {
  readonly exists: boolean;
  readonly skills: readonly LibrarySkill[];
}

export async function readLibrary(fs: Fs, paths: Layout): Promise<LibraryListing> {
  const names = await fs.readdir(paths.libraryDir);
  if (names === null) return { exists: false, skills: [] };
  const skills: LibrarySkill[] = [];
  for (const raw of [...names].sort()) {
    const name = parseSkillName(raw);
    if (name === null) continue;
    const dir = paths.librarySkill(name);
    if ((await fs.stat(dir)) !== "dir") continue;
    const skillMd = await fs.readFile(join(dir, "SKILL.md") as AbsPath);
    const front = skillMd === null ? null : parseFrontmatter(new TextDecoder().decode(skillMd));
    const issues: SkillIssue[] = [];
    if (skillMd === null) issues.push({ kind: "noSkillMd" });
    if (front?.name != null && front.name !== name) {
      issues.push({ kind: "nameMismatch", declared: front.name });
    }
    skills.push({
      name,
      dir,
      hash: await contentHash(fs, dir),
      valid: skillMd !== null,
      description: front?.description ?? null,
      issues,
    });
  }
  return { exists: true, skills };
}

export interface ResolvedSource {
  /** The spec with the commit pinned, so re-planning is offline and deterministic. */
  readonly spec: SourceSpec;
  readonly name: SkillName;
  /** The SKILL.md description, for saying what the skill does before it is installed. */
  readonly description: string | null;
  readonly hash: ContentHash;
  readonly materialize: Materialize;
}

export type SourceResult =
  | { readonly ok: true; readonly source: ResolvedSource }
  | { readonly ok: false; readonly error: PlanError };

/**
 * Read-only toward the library, agent dirs, and state.json. A git source is fetched into
 * ~/.gandalf/cache, which is gandalf-private and keyed by commit, so concurrent plans converge on
 * the same bytes. A spec whose commit is already pinned never touches the network. `signal` reaches
 * only the fetch; once it aborts, this rejects with a GitCancelled rather than a refusal.
 */
export async function resolveSource(
  env: Env,
  paths: Layout,
  spec: SourceSpec,
  signal?: AbortSignal,
): Promise<SourceResult> {
  try {
    if (spec.kind === "local") {
      return await fromDir(env.fs, spec, spec.path, basename(spec.path), {
        kind: "local",
        path: spec.path,
      });
    }
    const commit = spec.commit ?? (await fetchCommit(env, paths, spec.url, spec.ref, signal));
    const subpath =
      spec.skill === null
        ? spec.subpath
        : await findSkill(env, paths, spec.url, commit, spec.skill);
    const tree = await gitTree(env, paths, spec.url, commit, subpath);
    const folder = subpath === null ? repoName(spec.url) : basename(subpath);
    return await fromDir(env.fs, { ...spec, subpath, skill: null, commit }, tree, folder, {
      kind: "git",
      url: spec.url,
      commit,
      subpath,
    });
  } catch (error) {
    if (!isSourceFailure(error)) throw error;
    return { ok: false, error: { kind: "badSource", reason: messageOf(error) } };
  }
}

/**
 * A source gandalf cannot use, as opposed to a bug: a git failure, a cache miss, or an I/O error. A
 * cancelled fetch says nothing about the source, so it is not one.
 */
export function isSourceFailure(error: unknown): error is Error {
  if (error instanceof GitCancelled) return false;
  return (
    error instanceof GitError || error instanceof SourceError || errorCode(error) !== undefined
  );
}

class SourceError extends Error {}

async function fromDir(
  fs: Fs,
  spec: SourceSpec,
  dir: AbsPath,
  folder: string,
  materialize: Materialize,
): Promise<SourceResult> {
  const skillMd = await fs.readFile(join(dir, "SKILL.md") as AbsPath);
  if (skillMd === null) {
    return { ok: false, error: { kind: "badSource", reason: `no SKILL.md in ${dir}` } };
  }
  const front = parseFrontmatter(new TextDecoder().decode(skillMd));
  const name = intakeName(front.name, folder);
  if (name === null) {
    return { ok: false, error: { kind: "badSource", reason: `no usable skill name in ${dir}` } };
  }
  const hash = await contentHash(fs, dir);
  return {
    ok: true,
    source: { spec, name, description: front.description, hash, materialize },
  };
}

/**
 * Fetch `ref` (default HEAD) from `url` into the cache and return the commit it points at. The
 * fetch and the read of FETCH_HEAD hold the repository's fetch lock, so a concurrent plan, in this
 * process or another, cannot swap FETCH_HEAD in between. A stalled HTTP transfer fails on its own
 * after a minute; `signal` kills the fetch, or the wait for the lock, at once.
 */
export async function fetchCommit(
  env: Env,
  paths: Layout,
  url: string,
  ref: string | null,
  signal?: AbortSignal,
): Promise<GitCommit> {
  return withFetchLock(env, paths, url, signal, async () => {
    const repo = await ensureRepo(env, paths, url);
    await env.git(
      [
        ...["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"],
        ...["fetch", "--quiet", "--no-tags", "--", url, ref ?? "HEAD"],
      ],
      { cwd: repo, signal },
    );
    const commit = (await env.git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { cwd: repo }))
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new SourceError(`unexpected commit id ${commit}`);
    return commit as GitCommit;
  });
}

/**
 * Each fetch lock's queue in this process, by pid and lock file: every Env of one pid shares it, so
 * the lock file can only ever hold this pid while its own turn is the one running.
 */
const fetchTurns = new Map<string, Promise<void>>();

/** How long a wait for another process's fetch lock sleeps between looks: doubling, capped. */
const LOCK_POLL_MS = { first: 20, max: 500 };

/**
 * A lock file that stays unreadable this long is a holder that died between creating and writing
 * it. Shorter, and a holder caught between the two would lose its lock.
 */
const GARBLED_LOCK_MS = 2000;

/**
 * A holder older than this is stale even when its pid answers, as the apply lock's 10 minutes: a
 * reused pid, or one that answers EPERM, would otherwise hold the lock forever. A stalled HTTP
 * fetch fails after a minute, so a live holder this old is not fetching.
 */
const FETCH_LOCK_MAX_AGE_MS = 10 * 60 * 1000;

/** A break file older than this belongs to a process that died while it held it. */
const BREAK_MAX_AGE_MS = 10 * 1000;

/**
 * Runs `work` holding the fetch lock of `url`'s cache repository: first its turn in this process,
 * then `cache/git/<repo>.lock`, created exclusively and holding the pid. The apply lock is a
 * separate file and is never waited on. An abort while waiting rejects with a GitCancelled.
 */
async function withFetchLock<T>(
  env: Env,
  paths: Layout,
  url: string,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const lockFile = within(paths.cacheDir, "git", `${repoKey(url)}.lock`);
  const key = `${env.pid}:${lockFile}`;
  const before = fetchTurns.get(key) ?? Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>((resolve) => (release = resolve));
  // Settles once both have: a turn given up while still waiting does not jump the one before it.
  const after = before.then(() => turn);
  fetchTurns.set(key, after);
  try {
    await untilAborted(before, signal);
    await takeLockFile(env, paths, lockFile, signal);
    try {
      return await work();
    } finally {
      await removeLockFile(env, lockFile);
    }
  } finally {
    release();
    void after.then(() => {
      if (fetchTurns.get(key) === after) fetchTurns.delete(key);
    });
  }
}

/**
 * Creates `lockFile` holding this pid, waiting while a live process holds it. One whose holder is
 * dead, older than FETCH_LOCK_MAX_AGE_MS, or this pid (whose turn is the one running, so the file
 * is a leftover) is stale and broken by breakStale. Lock files are the only files this removes,
 * through the GandalfPath-only unlink.
 */
async function takeLockFile(
  env: Env,
  paths: Layout,
  lockFile: GandalfPath,
  signal: AbortSignal | undefined,
): Promise<void> {
  await env.fs.mkdir(within(paths.cacheDir, "git"));
  let pause = LOCK_POLL_MS.first;
  let garbledSince: number | null = null;
  for (;;) {
    if (signal?.aborted === true) throw new GitCancelled();
    if (await env.fs.writeFileExclusive(lockFile, lockBody(env))) return;
    // null as well when something other than a file sits there, such as a folder: that waits
    // GARBLED_LOCK_MS like a garbled file, rather than spinning, before its removal is tried.
    const bytes = await env.fs.readFile(lockFile);
    const holder = bytes === null ? null : lockHolder(bytes);
    if (holder === null) garbledSince ??= env.now().getTime();
    else garbledSince = null;
    const stale =
      holder === null
        ? env.now().getTime() - (garbledSince ?? env.now().getTime()) >= GARBLED_LOCK_MS
        : holder.pid === env.pid ||
          !env.isAlive(holder.pid) ||
          env.now().getTime() - holder.since > FETCH_LOCK_MAX_AGE_MS;
    if (stale && (await breakStale(env, lockFile, bytes))) {
      garbledSince = null;
      continue;
    }
    await sleep(pause, signal);
    pause = Math.min(pause * 2, LOCK_POLL_MS.max);
  }
}

/**
 * Removes `lockFile` if it still holds `seen`, the stale bytes the caller read. Two processes that
 * both saw the same stale lock would otherwise both unlink it, the second removing the fresh lock
 * the first had just created. So the removal holds `<lock>.break`, created exclusively, and reads
 * the lock again under it: only the first still finds `seen`. A break file left by a process that
 * died holding it goes after BREAK_MAX_AGE_MS. False when another process holds the break.
 */
async function breakStale(
  env: Env,
  lockFile: GandalfPath,
  seen: Uint8Array | null,
): Promise<boolean> {
  const breakFile = `${lockFile}.break` as GandalfPath;
  if (!(await env.fs.writeFileExclusive(breakFile, lockBody(env)))) {
    const bytes = await env.fs.readFile(breakFile);
    const holder = bytes === null ? null : lockHolder(bytes);
    if (
      holder === null ||
      !env.isAlive(holder.pid) ||
      env.now().getTime() - holder.since > BREAK_MAX_AGE_MS
    ) {
      await removeLockFile(env, breakFile);
    }
    return false;
  }
  try {
    const now = await env.fs.readFile(lockFile);
    // Changed since the caller looked: someone broke it first, or took it fresh. Look again.
    if (now === null ? seen !== null : seen === null || !sameBytes(now, seen)) return true;
    await removeLockFile(env, lockFile);
    return true;
  } finally {
    await removeLockFile(env, breakFile);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function lockBody(env: Env): string {
  return JSON.stringify({ pid: env.pid, since: env.now().toISOString() });
}

async function removeLockFile(env: Env, lockFile: GandalfPath): Promise<void> {
  try {
    await env.fs.unlink(lockFile);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/** The pid and start of a lock's holder; null for a file that is not a lock gandalf wrote. */
function lockHolder(bytes: Uint8Array): { readonly pid: number; readonly since: number } | null {
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof raw !== "object" || raw === null || !("pid" in raw) || !("since" in raw))
      return null;
    const { pid, since } = raw;
    const start = typeof since === "string" ? Date.parse(since) : NaN;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && !Number.isNaN(start)
      ? { pid, since: start }
      : null;
  } catch {
    return null;
  }
}

/** `work`, or a GitCancelled as soon as `signal` aborts, whichever comes first. */
function untilAborted(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(new GitCancelled());
  return new Promise((done, fail) => {
    const abort = () => fail(new GitCancelled());
    signal.addEventListener("abort", abort, { once: true });
    void work.then(() => {
      signal.removeEventListener("abort", abort);
      done();
    });
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return untilAborted(new Promise((done) => setTimeout(done, ms)), signal);
}

/** How many SKILL.md files findSkill reads by their name before it gives up on a repository. */
const MAX_SKILL_READS = 500;

/**
 * The folder of the skill named `skill` in the cached commit, as a subpath, null for the top of
 * the repository: one whose SKILL.md declares the name, or that declares none and whose folder is
 * named so, the way intake names it. A folder named as the skill is read first. With several, the
 * shallowest wins, then the first in path order. Offline.
 */
/** The folders of every SKILL.md at `commit`, shallowest first, null for the top. */
async function skillFolders(env: Env, paths: Layout, url: string, commit: GitCommit) {
  const listing = await env.git(["ls-tree", "-r", "-z", "--name-only", commit], {
    cwd: repoDir(paths, url),
  });
  return listing
    .split("\0")
    .filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
    .map((path) => (path === "SKILL.md" ? null : path.slice(0, -"/SKILL.md".length)))
    .sort((a, b) => depth(a) - depth(b) || (a ?? "").localeCompare(b ?? ""));
}

async function readSkillMd(
  env: Env,
  paths: Layout,
  url: string,
  commit: GitCommit,
  folder: string | null,
): Promise<string> {
  const path = folder === null ? "SKILL.md" : `${folder}/SKILL.md`;
  return env.git(["cat-file", "blob", `${commit}:${path}`], { cwd: repoDir(paths, url) });
}

function folderName(url: string, folder: string | null): string {
  return folder === null ? repoName(url) : basename(folder);
}

async function findSkill(
  env: Env,
  paths: Layout,
  url: string,
  commit: GitCommit,
  skill: SkillName,
): Promise<string | null> {
  const folders = await skillFolders(env, paths, url, commit);
  const named = folders.filter((folder) => folderName(url, folder) === skill);
  const rest = folders.filter((folder) => folderName(url, folder) !== skill);
  for (const folder of [...named, ...rest].slice(0, MAX_SKILL_READS)) {
    const text = await readSkillMd(env, paths, url, commit, folder);
    if (intakeName(parseFrontmatter(text).name, folderName(url, folder)) === skill) return folder;
  }
  throw new SourceError(`no skill named ${skill} in ${url}`);
}

/**
 * Every skill in the repository at `ref` (default HEAD), fetched into the cache first: the skills
 * whose SKILL.md gives or whose folder is a usable name, once each, shallowest first.
 */
export async function listRepoSkills(
  env: Env,
  paths: Layout,
  url: string,
  ref: string | null,
  signal?: AbortSignal,
): Promise<RepoSkillsOutcome> {
  try {
    const commit = await fetchCommit(env, paths, url, ref, signal);
    const skills: RepoSkill[] = [];
    const seen = new Set<SkillName>();
    for (const folder of (await skillFolders(env, paths, url, commit)).slice(0, MAX_SKILL_READS)) {
      const front = parseFrontmatter(await readSkillMd(env, paths, url, commit, folder));
      const name = intakeName(front.name, folderName(url, folder));
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, subpath: folder, description: front.description });
    }
    return { ok: true, commit, skills };
  } catch (error) {
    if (!isSourceFailure(error)) throw error;
    return { ok: false, error: { kind: "badSource", reason: messageOf(error) } };
  }
}

function depth(folder: string | null): number {
  return folder === null ? 0 : folder.split("/").length;
}

/** The cached tree for (url, commit, subpath), materializing it on first use. Offline. */
export async function gitTree(
  env: Env,
  paths: Layout,
  url: string,
  commit: GitCommit,
  subpath: string | null,
): Promise<AbsPath> {
  const treeRoot = within(
    paths.cacheDir,
    "trees",
    `${commit}-${sha256(subpath ?? "").slice(0, 12)}`,
  );
  const tree = (subpath === null ? treeRoot : join(treeRoot, subpath)) as AbsPath;
  if ((await env.fs.lstat(treeRoot)) !== null) return tree;
  const repo = repoDir(paths, url);
  try {
    await env.git(["cat-file", "-e", `${commit}^{commit}`], { cwd: repo });
  } catch {
    throw new SourceError(`commit ${commit} of ${url} is not in the cache; plan again to fetch it`);
  }
  const tmp = within(paths.cacheDir, "tmp", randomUUID());
  await env.fs.mkdir(tmp);
  await env.git(
    ["--git-dir", repo, "--work-tree", tmp, "checkout", "--quiet", "--force", commit, "--"].concat(
      subpath ?? ".",
    ),
    { cwd: tmp },
  );
  await env.fs.mkdir(within(paths.cacheDir, "trees"));
  try {
    await env.fs.rename(tmp, treeRoot);
  } catch (error) {
    // A concurrent plan materialized the same tree first. Its bytes are the same commit's.
    if (!["ENOTEMPTY", "EEXIST"].includes(errorCode(error) ?? "")) throw error;
  }
  return tree;
}

/** Copy the source content into `into`. apply verifies contentHash(into) against the step's hash. */
export async function materialize(
  env: Env,
  paths: Layout,
  from: Materialize,
  into: StagingPath,
): Promise<void> {
  const dir =
    from.kind === "local"
      ? from.path
      : await gitTree(env, paths, from.url, from.commit, from.subpath);
  await env.fs.copyTree(dir, into);
}

function repoKey(url: string): string {
  return sha256(url).slice(0, 16);
}

function repoDir(paths: Layout, url: string) {
  return within(paths.cacheDir, "git", repoKey(url));
}

async function ensureRepo(env: Env, paths: Layout, url: string): Promise<AbsPath> {
  const repo = repoDir(paths, url);
  if ((await env.fs.lstat(repo)) === null) {
    await env.fs.mkdir(repo);
    await env.git(["init", "--bare", "--quiet", repo], { cwd: repo });
  }
  return repo;
}

function repoName(url: string): string {
  return basename(url.replace(/\/+$/, "")).replace(/\.git$/, "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

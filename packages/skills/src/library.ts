// The central library (~/.gandalf/skills/<name>/) and the sources skills come from.
//
// The library directory listing is the truth for which skills exist. The dir name is the skill's
// identity. Frontmatter `name` decides the dir name on intake (install, adopt) and is linted after.

import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { contentHash, sha256 } from "./disk.js";
import { errorCode, within, type Env, type Fs, type Layout, type StagingPath } from "./env.js";
import { intakeName, parseFrontmatter } from "./frontmatter.js";
import { parseSkillName } from "./parse.js";
import type {
  AbsPath,
  ContentHash,
  GitCommit,
  Materialize,
  PlanError,
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
  readonly hash: ContentHash;
  readonly materialize: Materialize;
}

export type SourceResult =
  | { readonly ok: true; readonly source: ResolvedSource }
  | { readonly ok: false; readonly error: PlanError };

/**
 * Read-only toward the library, agent dirs, and state.json. A git source is fetched into
 * ~/.gandalf/cache, which is gandalf-private and keyed by commit, so concurrent plans converge on
 * the same bytes. A spec whose commit is already pinned never touches the network.
 */
export async function resolveSource(
  env: Env,
  paths: Layout,
  spec: SourceSpec,
): Promise<SourceResult> {
  try {
    if (spec.kind === "local") {
      return await fromDir(env.fs, spec, spec.path, basename(spec.path), {
        kind: "local",
        path: spec.path,
      });
    }
    const commit = spec.commit ?? (await fetchCommit(env, paths, spec.url, spec.ref));
    const tree = await gitTree(env, paths, spec.url, commit, spec.subpath);
    const folder = spec.subpath === null ? repoName(spec.url) : basename(spec.subpath);
    return await fromDir(env.fs, { ...spec, commit }, tree, folder, {
      kind: "git",
      url: spec.url,
      commit,
      subpath: spec.subpath,
    });
  } catch (error) {
    // Everything here is driven by user-supplied paths and URLs, so any failure is a bad source.
    return { ok: false, error: { kind: "badSource", reason: messageOf(error) } };
  }
}

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
  const name = intakeName(parseFrontmatter(new TextDecoder().decode(skillMd)).name, folder);
  if (name === null) {
    return { ok: false, error: { kind: "badSource", reason: `no usable skill name in ${dir}` } };
  }
  return { ok: true, source: { spec, name, hash: await contentHash(fs, dir), materialize } };
}

/** Fetch `ref` (default HEAD) from `url` into the cache and return the commit it points at. */
export async function fetchCommit(
  env: Env,
  paths: Layout,
  url: string,
  ref: string | null,
): Promise<GitCommit> {
  const repo = await ensureRepo(env, paths, url);
  await env.git(["fetch", "--quiet", "--no-tags", "--", url, ref ?? "HEAD"], { cwd: repo });
  const commit = (await env.git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], { cwd: repo }))
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected commit id ${commit}`);
  return commit as GitCommit;
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
    throw new Error(`commit ${commit} of ${url} is not in the cache; plan again to fetch it`);
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

function repoDir(paths: Layout, url: string) {
  return within(paths.cacheDir, "git", sha256(url).slice(0, 16));
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

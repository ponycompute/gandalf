// On-disk evidence and the atomic primitives that act on it.
//
// One module owns the ownership rule, and both scan and apply call it: classify() decides what an
// entry is, and apply's pre/post checks call the same classify(). There is no second opinion that
// could disagree.
//
// Ownership evidence lives on the entry itself:
//   link       a symlink whose target is <library>/<name>
//   cleanCopy  a dir whose .gandalf-copy.json records a hash equal to the dir's content hash
// Nothing else is owned, whatever state.json says.

import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  errorCode,
  within,
  type Fs,
  type GandalfPath,
  type Layout,
  type StagingPath,
} from "./env.js";
import { parseFrontmatter } from "./frontmatter.js";
import { parseContentHash, parseSkillName } from "./parse.js";
import type { AbsPath, ContentHash, Observed, SkillName } from "./types.js";

/** Written into every copy gandalf places. Excluded from contentHash. */
export const COPY_MARKER = ".gandalf-copy.json";

/** Names contentHash ignores: the marker, VCS metadata, and Finder litter. */
const HASH_IGNORED: ReadonlySet<string> = new Set([COPY_MARKER, ".git", ".DS_Store"]);

/**
 * The library dir as written in link targets and as its realpath. A link counts as owned when its
 * target's parent is either, so a symlinked HOME or ~/.gandalf does not orphan existing links.
 */
export type LibraryDirs = readonly AbsPath[];

export async function classify(fs: Fs, library: LibraryDirs, path: AbsPath): Promise<Observed> {
  const kind = await fs.lstat(path);
  if (kind === null) return { kind: "absent" };
  if (kind === "symlink") {
    const target = resolve(dirname(path), await fs.readlink(path));
    const resolves = (await fs.stat(path)) !== null;
    const skill = library.includes(dirname(target) as AbsPath)
      ? parseSkillName(basename(target))
      : null;
    return skill === null
      ? { kind: "foreignLink", target, resolves }
      : { kind: "link", skill, resolves };
  }
  if (kind !== "dir") return { kind: "other" };

  const marker = parseMarker(await fs.readFile(join(path, COPY_MARKER) as AbsPath));
  if (marker !== null) {
    const actual = await contentHash(fs, path);
    return actual === marker.hash
      ? { kind: "cleanCopy", skill: marker.skill, hash: actual }
      : { kind: "modifiedCopy", skill: marker.skill, recorded: marker.hash, actual };
  }
  const skillMd = await fs.readFile(join(path, "SKILL.md") as AbsPath);
  if (skillMd === null) return { kind: "other" };
  return {
    kind: "skillDir",
    hash: await contentHash(fs, path),
    declaredName: parseFrontmatter(new TextDecoder().decode(skillMd)).name,
  };
}

/**
 * sha256 over the sorted list of (posix relative path, file bytes | link target), recursing into
 * subdirectories and skipping HASH_IGNORED. File modes and empty dirs are ignored, so a local dir, a
 * git tree materialized into the cache, and a copy of either hash the same.
 */
export async function contentHash(fs: Fs, dir: AbsPath): Promise<ContentHash> {
  const lines: string[] = [];
  const walk = async (abs: AbsPath, rel: string): Promise<void> => {
    const names = [...((await fs.readdir(abs)) ?? [])].sort();
    for (const name of names) {
      if (HASH_IGNORED.has(name)) continue;
      const path = join(abs, name) as AbsPath;
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const kind = await fs.lstat(path);
      if (kind === "dir") await walk(path, relPath);
      if (kind === "symlink") lines.push(`l ${JSON.stringify(relPath)} ${await fs.readlink(path)}`);
      if (kind === "file") {
        lines.push(`f ${JSON.stringify(relPath)} ${sha256((await fs.readFile(path)) ?? "")}`);
      }
    }
  };
  await walk(dir, "");
  return `sha256:${sha256(lines.join("\n"))}` as ContentHash;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface CopyMarker {
  readonly skill: SkillName;
  readonly hash: ContentHash;
}

export function serializeMarker(marker: CopyMarker): string {
  return `${JSON.stringify({ skill: marker.skill, hash: marker.hash })}\n`;
}

function parseMarker(bytes: Uint8Array | null): CopyMarker | null {
  if (bytes === null) return null;
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof raw !== "object" || raw === null) return null;
    const skill =
      "skill" in raw && typeof raw.skill === "string" ? parseSkillName(raw.skill) : null;
    const hash = "hash" in raw ? parseContentHash(raw.hash) : null;
    return skill === null || hash === null ? null : { skill, hash };
  } catch {
    return null;
  }
}

export type RootListing =
  | {
      readonly ok: true;
      readonly exists: boolean;
      readonly entries: ReadonlyMap<string, Observed>;
    }
  | { readonly ok: false; readonly error: string };

/** classify() every non-dot child of `root`. A missing root is an empty listing. */
export async function observeRoot(
  fs: Fs,
  library: LibraryDirs,
  root: AbsPath,
): Promise<RootListing> {
  let names: readonly string[] | null;
  try {
    names = await fs.readdir(root);
  } catch (error) {
    return { ok: false, error: errorCode(error) ?? String(error) };
  }
  const entries = new Map<string, Observed>();
  for (const name of [...(names ?? [])].sort()) {
    if (name.startsWith(".")) continue;
    entries.set(name, await classifyOrOther(fs, library, join(root, name) as AbsPath));
  }
  return { ok: true, exists: names !== null, entries };
}

/** An entry gandalf cannot read is not gandalf's: `other` is unowned, so nothing will touch it. */
async function classifyOrOther(fs: Fs, library: LibraryDirs, path: AbsPath): Promise<Observed> {
  try {
    return await classify(fs, library, path);
  } catch (error) {
    if (errorCode(error) === undefined) throw error;
    return { kind: "other" };
  }
}

/**
 * Atomically move whatever is at `path` into a fresh trash slot, so the verify that follows runs on
 * an entry nobody else can still change in place. Returns null if `path` was already absent.
 * Throws EXDEV across volumes: Stage 1 refuses cross-volume removal rather than gaining a delete.
 */
export async function grab(
  fs: Fs,
  paths: Layout,
  path: AbsPath,
  label: string,
): Promise<GandalfPath | null> {
  if ((await fs.lstat(path)) === null) return null;
  await fs.mkdir(paths.trashDir);
  const grabbed = paths.trash(label);
  try {
    await fs.rename(path, grabbed);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  return grabbed;
}

/**
 * Undo a grab whose verify failed. False when something new now occupies `path`; the grabbed entry
 * then stays in trash. The occupancy check comes first because rename silently replaces a file.
 */
export async function restore(fs: Fs, grabbed: GandalfPath, path: AbsPath): Promise<boolean> {
  if ((await fs.lstat(path)) !== null) return false;
  await fs.rename(grabbed, path);
  return true;
}

/** copyTree(<library>/<skill>) into staging and write COPY_MARKER with the staged content hash. */
export async function stageCopy(
  fs: Fs,
  paths: Layout,
  skill: SkillName,
): Promise<{ readonly staged: StagingPath; readonly hash: ContentHash }> {
  await fs.mkdir(paths.stagingDir);
  const staged = paths.staging(skill);
  await fs.copyTree(paths.librarySkill(skill), staged);
  const hash = await contentHash(fs, staged);
  await fs.writeFile(within(staged, COPY_MARKER), serializeMarker({ skill, hash }));
  return { staged, hash };
}

/**
 * rename(staged, path). "occupied" when the destination exists (ENOTEMPTY, ENOTDIR, EEXIST): nothing
 * was replaced. The one thing POSIX rename can replace is an empty directory, which holds no content.
 */
export async function place(
  fs: Fs,
  staged: StagingPath,
  path: AbsPath,
): Promise<"placed" | "occupied"> {
  try {
    await fs.rename(staged, path);
    return "placed";
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(errorCode(error) ?? "")) {
      return "occupied";
    }
    throw error;
  }
}

/** Remove everything under staging. Safe only while holding the apply lock. */
export async function cleanStaging(fs: Fs, paths: Layout): Promise<void> {
  await fs.removeTree(paths.stagingDir);
}

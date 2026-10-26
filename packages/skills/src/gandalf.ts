// The facade: three methods over one Env. Stateless; every call reads disk fresh, so the CLI and the
// Electron main process can each hold their own instance without coordinating.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gatherAgentFacts, resolveAgents } from "./agents.js";
import { applyToken } from "./apply.js";
import { contentHash, observeRoot, type RootListing } from "./disk.js";
import { GitCancelled, layout, type Env, type Layout } from "./env.js";
import { fetchCommit, gitTree, isSourceFailure, readLibrary, resolveSource } from "./library.js";
import {
  NOTHING_RESOLVED,
  planIntent,
  sameOrigin,
  view,
  type Resolved,
  type UpdateTarget,
  type World,
} from "./reconcile.js";
import { readState } from "./state.js";
import type {
  AbsPath,
  ApplyOutcome,
  CommitPin,
  ContentHash,
  GitCommit,
  Intent,
  PlanError,
  PlanOutcome,
  PlanToken,
  SkillName,
  SkillSource,
  Snapshot,
  SourceSpec,
} from "./types.js";

export interface Gandalf {
  /** Read-only. Observes the library, state.json, and every agent dir. */
  snapshot(): Promise<Snapshot>;
  /**
   * Never writes the library or state.json. A git source may be fetched into ~/.gandalf/cache, and a
   * root about to receive its first creation in auto mode is probed for symlink support. The
   * returned plan's intent has its pins filled in. Once `signal` aborts, a running fetch is killed,
   * no further one starts, and the plan rejects with a GitCancelled after the local step it is in.
   */
  plan(intent: Intent, options?: PlanOptions): Promise<PlanOutcome>;
  /** Re-derives the plan under the apply lock and executes it only if the fingerprint matches. */
  apply(token: PlanToken): Promise<ApplyOutcome>;
}

export interface PlanOptions {
  readonly signal?: AbortSignal;
}

export function openGandalf(env: Env): Gandalf {
  const paths = layout(env.home, env.now);
  return {
    snapshot: async () => view(await observe(env, paths, [])),
    plan: (intent, options) => derivePlan(env, paths, intent, options?.signal),
    // apply re-derives without a signal: nothing may stop it half way.
    apply: (token) => applyToken(env, paths, token, (intent) => derivePlan(env, paths, intent)),
  };
}

async function derivePlan(
  env: Env,
  paths: Layout,
  intent: Intent,
  signal?: AbortSignal,
): Promise<PlanOutcome> {
  let world = await observe(env, paths, extraRootsFor(intent));
  const resolved = await resolveFor(env, paths, intent, world, signal);
  if (signal?.aborted === true) throw new GitCancelled();
  if (!resolved.ok) return resolved;
  for (;;) {
    const planned = planIntent(resolved.intent, world, resolved.inputs);
    if (!("probe" in planned)) return planned;
    const symlinks = new Map(world.symlinks);
    for (const root of planned.probe) symlinks.set(root, await probe(env, root));
    world = { ...world, symlinks };
  }
}

/** A root that does not exist yet is probed in its nearest existing ancestor, the same volume. */
async function probe(env: Env, root: AbsPath): Promise<boolean> {
  let dir = root;
  while ((await env.fs.stat(dir)) !== "dir" && dirname(dir) !== dir) {
    dir = dirname(dir) as AbsPath;
  }
  return env.fs.probeSymlink(dir);
}

/** configureAgent must observe the new dir too, so the plan can diff it before it becomes a root. */
function extraRootsFor(intent: Intent): readonly AbsPath[] {
  return intent.kind === "configureAgent" && intent.skillsDir !== null ? [intent.skillsDir] : [];
}

async function observe(env: Env, paths: Layout, extraRoots: readonly AbsPath[]): Promise<World> {
  const { fs } = env;
  const desired = await readState(fs, paths);
  const overridden = Object.values(desired.agents).flatMap((override) =>
    override?.skillsDir == null ? [] : [override.skillsDir],
  );
  const facts = await gatherAgentFacts(fs, env.home, paths.gandalfDir, [
    paths.libraryDir,
    ...overridden,
    ...extraRoots,
  ]);
  const libraryReal = facts.realpaths.get(paths.libraryDir);
  const libraryDirs =
    libraryReal === undefined || libraryReal === paths.libraryDir
      ? [paths.libraryDir]
      : [paths.libraryDir, libraryReal];
  const library = await readLibrary(fs, paths);
  const rootPaths = new Set(resolveAgents(facts, desired.agents).roots.map((root) => root.path));
  for (const dir of extraRoots) rootPaths.add(facts.realpaths.get(dir) ?? dir);
  const listings = new Map<AbsPath, RootListing>();
  for (const root of rootPaths) listings.set(root, await observeRoot(fs, libraryDirs, root));
  return {
    gandalfDir: paths.gandalfDir,
    libraryDir: paths.libraryDir,
    libraryDirs,
    libraryExists: library.exists,
    desired,
    library: library.skills,
    facts,
    listings,
    symlinks: new Map(),
  };
}

type ResolveResult =
  | { readonly ok: true; readonly intent: Intent; readonly inputs: Resolved }
  | { readonly ok: false; readonly error: PlanError };

/**
 * The I/O an intent needs before the pure planner runs, and the pins that make re-derivation exact:
 *   install  resolveSource(spec) with the commit pinned. An unpinned git spec whose origin state.json
 *            already records reuses that commit, so a re-run after a crash converges instead of
 *            taking whatever the remote has now. A local path or file:// URL spelled differently
 *            from the recorded one, as /var against /private/var, is the same origin when both
 *            resolve to the same folder; the spec then takes the recorded spelling.
 *   update   per git skill: the target at pins[skill] or the fetched ref, plus the hash of the tree
 *            at the recorded commit; pins filled
 *   others   nothing
 */
async function resolveFor(
  env: Env,
  paths: Layout,
  intent: Intent,
  world: World,
  signal: AbortSignal | undefined,
): Promise<ResolveResult> {
  if (intent.kind === "install") {
    let spec = await recordedSpelling(env, intent.source, world);
    if (spec.kind === "git" && spec.commit === null) {
      const unpinned = spec;
      const recorded = Object.values(world.desired.skills).find(
        (record) =>
          record !== undefined &&
          record.source.kind === "git" &&
          sameOrigin(record.source, { ...unpinned, commit: record.source.commit }),
      )?.source;
      if (recorded?.kind === "git") spec = { ...spec, commit: recorded.commit };
    }
    const result = await resolveSource(env, paths, spec, signal);
    if (!result.ok) return result;
    return {
      ok: true,
      intent: { ...intent, source: result.source.spec },
      inputs: { ...NOTHING_RESOLVED, source: result.source },
    };
  }

  if (intent.kind === "update") {
    const skills = world.desired.skills;
    const names =
      intent.skills === "all" ? (Object.keys(skills) as SkillName[]) : [...intent.skills];
    const updates = new Map<SkillName, UpdateTarget>();
    const pins: CommitPin[] = [];
    for (const name of names.sort()) {
      const source = skills[name]?.source;
      if (source?.kind !== "git") continue;
      const pinned = intent.pins.find((pin) => pin.skill === name)?.commit;
      let commit: GitCommit;
      try {
        commit = pinned ?? (await fetchCommit(env, paths, source.url, source.ref, signal));
      } catch (error) {
        if (!isSourceFailure(error)) throw error;
        return { ok: false, error: { kind: "badSource", reason: error.message } };
      }
      const target = await resolveSource(env, paths, { ...source, commit }, signal);
      if (!target.ok) return target;
      updates.set(name, {
        target: target.source,
        pristine: await pristineHash(env, paths, source),
      });
      pins.push({ skill: name, commit });
    }
    return { ok: true, intent: { ...intent, pins }, inputs: { ...NOTHING_RESOLVED, updates } };
  }

  return { ok: true, intent, inputs: NOTHING_RESOLVED };
}

/**
 * `spec` with the path or URL of the recorded source it names, when that is spelled differently but
 * resolves to the same folder, as through a symlinked HOME. The recorded string is kept as given,
 * so state.json does not change for a re-install, and a git source keeps its cache repository.
 */
async function recordedSpelling(env: Env, spec: SourceSpec, world: World): Promise<SourceSpec> {
  const here = await realLocation(env, spec.kind === "local" ? spec.path : spec.url);
  if (here === null) return spec;
  for (const record of Object.values(world.desired.skills)) {
    const source = record?.source;
    if (source === undefined || source.kind !== spec.kind) continue;
    if (source.kind === "local" && spec.kind === "local") {
      const recorded = source.path;
      if (recorded === null || recorded === spec.path) continue;
      if ((await realLocation(env, recorded)) === here) return { ...spec, path: recorded };
    }
    if (source.kind === "git" && spec.kind === "git" && source.url !== spec.url) {
      const same = { ...spec, url: source.url };
      if (!sameOrigin(source, { ...same, commit: source.commit })) continue;
      if ((await realLocation(env, source.url)) === here) return same;
    }
  }
  return spec;
}

/** The real path of a local path or file:// URL, or null for a remote URL or a missing path. */
async function realLocation(env: Env, location: string): Promise<AbsPath | null> {
  let path: string;
  try {
    path = location.startsWith("file:") ? fileURLToPath(location) : location;
  } catch {
    return null;
  }
  if (!path.startsWith("/")) return null;
  return env.fs.realpath(path as AbsPath);
}

async function pristineHash(
  env: Env,
  paths: Layout,
  source: Extract<SkillSource, { kind: "git" }>,
): Promise<ContentHash | null> {
  try {
    const tree = await gitTree(env, paths, source.url, source.commit, source.subpath);
    return await contentHash(env.fs, tree);
  } catch (error) {
    if (!isSourceFailure(error)) throw error;
    return null;
  }
}

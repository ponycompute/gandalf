// The facade: three methods over one Env. Stateless; every call reads disk fresh, so the CLI and the
// Electron main process can each hold their own instance without coordinating.

import { dirname } from "node:path";
import { gatherAgentFacts, resolveAgents } from "./agents.js";
import { applyToken } from "./apply.js";
import { contentHash, observeRoot, type RootListing } from "./disk.js";
import { layout, type Env, type Layout } from "./env.js";
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
} from "./types.js";

export interface Gandalf {
  /** Read-only. Observes the library, state.json, and every agent dir. */
  snapshot(): Promise<Snapshot>;
  /**
   * Never writes the library or state.json. A git source may be fetched into ~/.gandalf/cache, and a
   * root about to receive its first creation in auto mode is probed for symlink support. The
   * returned plan's intent has its pins filled in.
   */
  plan(intent: Intent): Promise<PlanOutcome>;
  /** Re-derives the plan under the apply lock and executes it only if the fingerprint matches. */
  apply(token: PlanToken): Promise<ApplyOutcome>;
}

export function openGandalf(env: Env): Gandalf {
  const paths = layout(env.home, env.now);
  const derive = (intent: Intent): Promise<PlanOutcome> => derivePlan(env, paths, intent);
  return {
    snapshot: async () => view(await observe(env, paths, [])),
    plan: derive,
    apply: (token) => applyToken(env, paths, token, derive),
  };
}

async function derivePlan(env: Env, paths: Layout, intent: Intent): Promise<PlanOutcome> {
  let world = await observe(env, paths, extraRootsFor(intent));
  const resolved = await resolveFor(env, paths, intent, world);
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
 *            taking whatever the remote has now.
 *   update   per git skill: the target at pins[skill] or the fetched ref, plus the hash of the tree
 *            at the recorded commit; pins filled
 *   others   nothing
 */
async function resolveFor(
  env: Env,
  paths: Layout,
  intent: Intent,
  world: World,
): Promise<ResolveResult> {
  if (intent.kind === "install") {
    let spec = intent.source;
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
    const result = await resolveSource(env, paths, spec);
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
        commit = pinned ?? (await fetchCommit(env, paths, source.url, source.ref));
      } catch (error) {
        if (!isSourceFailure(error)) throw error;
        return { ok: false, error: { kind: "badSource", reason: error.message } };
      }
      const target = await resolveSource(env, paths, { ...source, commit });
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

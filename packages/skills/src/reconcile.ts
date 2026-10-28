// The pure core: desired state x observed state -> verdict per entry -> steps.
//
// Every command is the same pipeline. An intent becomes a Draft (state changes, library ops, scope).
// The Draft is simulated onto the World, the simulated world is diffed entry by entry with one verdict
// table, and the verdicts map to slot steps. Commands never hand-write link or unlink steps.
// No I/O here. gandalf.ts gathers the World and resolves sources first.

import { basename, dirname, join } from "node:path";
import {
  projectDirBlocked,
  projectSkillsDir,
  resolveAgents,
  resolveProjects,
  targetRootOf,
  type AgentFacts,
  type AgentId,
  type ResolvedAgents,
  type Root,
} from "./agents.js";
import { sha256, type LibraryDirs, type RootListing } from "./disk.js";
import { intakeName } from "./frontmatter.js";
import { canonicalJson } from "./json.js";
import type { LibrarySkill, ResolvedSource } from "./library.js";
import { parseSkillName } from "./parse.js";
import { applyChanges, isEnabled, isNoop, withAgents, type DesiredState } from "./state.js";
import type {
  AbsPath,
  AdoptPick,
  AdoptVariant,
  ContentHash,
  Desired,
  Entry,
  EntryLocation,
  Intent,
  IsoTime,
  NotDone,
  Observed,
  Owned,
  PlanError,
  PlanFingerprint,
  PlanOutcome,
  Problem,
  ProjectView,
  Reconciled,
  RootRole,
  SkillIssue,
  SkillName,
  SkillSource,
  Slot,
  Snapshot,
  StateChange,
  Step,
} from "./types.js";

/** Everything a planner reads, from one pass of I/O. */
export interface World {
  readonly gandalfDir: AbsPath;
  readonly libraryDir: AbsPath;
  readonly libraryDirs: LibraryDirs;
  readonly libraryExists: boolean;
  readonly desired: DesiredState;
  readonly library: readonly LibrarySkill[];
  readonly facts: AgentFacts;
  /** One listing per root path observed, including roots only the next config would have. */
  readonly listings: ReadonlyMap<AbsPath, RootListing>;
  /** Symlink support per root, probed on demand for roots that receive a creation in auto mode. */
  readonly symlinks: ReadonlyMap<AbsPath, boolean>;
}

export interface UpdateTarget {
  readonly target: ResolvedSource;
  /** Hash of the tree at the recorded commit, to tell a pristine library dir from an edited one. */
  readonly pristine: ContentHash | null;
}

/** Inputs planIntent needs that only I/O can produce. gandalf.ts fills exactly what the intent asks. */
export interface Resolved {
  readonly source: ResolvedSource | null;
  /** An install's `also`, resolved in its order. */
  readonly also: readonly ResolvedSource[];
  readonly updates: ReadonlyMap<SkillName, UpdateTarget>;
}

export const NOTHING_RESOLVED: Resolved = { source: null, also: [], updates: new Map() };

/** planIntent either finishes or names the roots whose symlink support it needs first. */
export type Planned = PlanOutcome | { readonly probe: readonly AbsPath[] };

// ---------------------------------------------------------------------------
// Step order. The one rule that makes every command crash-safe.
// ---------------------------------------------------------------------------

/**
 * Removals run before the commit and additions after it. A crash before the commit leaves state.db
 * on the old intent, and `sync` restores whatever was removed. A crash after it leaves state.db on
 * the new intent, and `sync` or a re-run finishes the additions. Either way state.db names the
 * intent the disk converges to. `satisfies` makes a new step kind fail to compile until it is ranked.
 */
export const RANK = {
  unlink: 0,
  trashCopy: 1,
  trashProjectCopy: 2,
  libraryReplace: 3,
  commitState: 4,
  ensureDir: 5,
  libraryAdd: 6,
  adoptMove: 7,
  trashDuplicate: 8,
  link: 9,
  copy: 10,
  projectCopy: 11,
  libraryTrash: 12,
} as const satisfies Record<Step["kind"], number>;

function sortKey(step: Step): string {
  switch (step.kind) {
    case "unlink":
    case "trashCopy":
    case "trashProjectCopy":
    case "link":
    case "copy":
    case "projectCopy":
      return join(step.slot.root, step.slot.name);
    case "adoptMove":
    case "trashDuplicate":
      return step.from.path;
    case "ensureDir":
      return step.dir;
    case "commitState":
      return "";
    case "libraryAdd":
    case "libraryReplace":
    case "libraryTrash":
      return step.skill;
  }
}

export function sortSteps(steps: readonly Step[]): readonly Step[] {
  return [...steps].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || sortKey(a).localeCompare(sortKey(b)),
  );
}

/** sha256 of canonical JSON (sorted keys) of { intent, steps }. notDone is excluded on purpose. */
export function fingerprint(intent: Intent, steps: readonly Step[]): PlanFingerprint {
  return `sha256:${sha256(canonicalJson({ intent, steps }))}` as PlanFingerprint;
}

// ---------------------------------------------------------------------------
// Desired and verdict
// ---------------------------------------------------------------------------

export interface VerdictContext {
  readonly role: RootRole;
  readonly tracked: (skill: SkillName) => boolean;
  /** The library has a dir of that name, valid or not. */
  readonly inLibrary: (skill: SkillName) => boolean;
  /** null when the library has no such skill, or the dir has no SKILL.md. */
  readonly libraryHash: (skill: SkillName) => ContentHash | null;
}

/**
 * What should occupy `name` in `root`: the skill of that name when it is tracked and enabled for any
 * agent writing to the root. Scan roots desire nothing. With several writers, the first enabled one
 * in registry order decides the mode. A project root desires a copy of each skill the project gets,
 * while any agent still writes to it.
 */
export function desiredAt(desired: DesiredState, root: Root, name: string): Desired | null {
  if (root.role === "scan") return null;
  if (root.project !== null) {
    const skill = parseSkillName(name);
    const project = desired.projects[root.project];
    if (skill === null || root.targets.length === 0 || !project?.skills.includes(skill))
      return null;
    return { skill, mode: "copy" };
  }
  const skill = parseSkillName(name);
  const record = skill === null ? undefined : desired.skills[skill];
  if (skill === null || record === undefined) return null;
  const agent = root.targets.find((id) => isEnabled(record.enabled, id));
  if (agent === undefined) return null;
  return { skill, mode: desired.agents[agent]?.mode ?? "auto" };
}

/**
 * The verdict table. Exhaustive over (role, desired, observed.kind). The return type ties each
 * verdict to its evidence, so `extra` and `repair` can only be built from Owned observations.
 *
 *   scan root,  Owned                         -> untouched(scanRoot)
 *   scan root,  Unowned                       -> unmanaged
 *   no desire,  Owned, skill untracked in lib -> untouched(untracked)
 *   no desire,  Owned otherwise               -> extra
 *   no desire,  Unowned                       -> unmanaged
 *   desire,     library lacks skill           -> blocked (Absent | Owned), conflict (Unowned)
 *   desire,     absent                        -> missing
 *   desire,     owned, for another skill      -> repair(otherSkill)
 *   desire,     link, mode copy               -> repair(wrongMode)
 *   desire,     clean copy, mode link         -> repair(wrongMode)
 *   desire,     clean copy, hash != library   -> repair(staleCopy)
 *   desire,     link or clean copy, matching  -> ok   (mode auto accepts either)
 *   desire,     Unowned                       -> conflict
 *
 * Returns null for (no desire, absent): such entries do not exist.
 */
export function reconcileEntry(
  observed: Observed,
  desired: Desired | null,
  context: VerdictContext,
): Reconciled | null {
  if (observed.kind === "absent") {
    if (context.role === "scan" || desired === null) return null;
    return context.libraryHash(desired.skill) === null
      ? { verdict: "blocked", observed, desired }
      : { verdict: "missing", observed, desired };
  }
  if (!isOwned(observed)) {
    return context.role === "scan" || desired === null
      ? { verdict: "unmanaged", observed, desired: null }
      : { verdict: "conflict", observed, desired };
  }
  if (context.role === "scan") {
    return { verdict: "untouched", observed, desired: null, why: "scanRoot" };
  }
  if (desired === null) {
    return context.inLibrary(observed.skill) && !context.tracked(observed.skill)
      ? { verdict: "untouched", observed, desired: null, why: "untracked" }
      : { verdict: "extra", observed, desired: null };
  }
  const libraryHash = context.libraryHash(desired.skill);
  if (libraryHash === null) return { verdict: "blocked", observed, desired };
  if (observed.skill !== desired.skill) {
    return { verdict: "repair", observed, desired, why: "otherSkill" };
  }
  if (observed.kind === "link") {
    return desired.mode === "copy"
      ? { verdict: "repair", observed, desired, why: "wrongMode" }
      : { verdict: "ok", observed, desired };
  }
  if (desired.mode === "link") return { verdict: "repair", observed, desired, why: "wrongMode" };
  return observed.hash === libraryHash
    ? { verdict: "ok", observed, desired }
    : { verdict: "repair", observed, desired, why: "staleCopy" };
}

export function isOwned(observed: Observed): observed is Owned {
  return observed.kind === "link" || observed.kind === "cleanCopy";
}

type Library = ReadonlyMap<SkillName, LibrarySkill>;

const ABSENT: Observed = { kind: "absent" };

/** Every entry of every readable root: observed children plus absent slots that something desires. */
function reconcileAll(
  desired: DesiredState,
  library: Library,
  listings: ReadonlyMap<AbsPath, RootListing>,
  roots: readonly Root[],
): Entry[] {
  const entries: Entry[] = [];
  for (const root of roots) {
    const listing = listings.get(root.path);
    if (listing === undefined || !listing.ok) continue;
    const context: VerdictContext = {
      role: root.role,
      tracked: (skill) => desired.skills[skill] !== undefined,
      inLibrary: (skill) => library.has(skill),
      libraryHash: (skill) => {
        const found = library.get(skill);
        return found?.valid === true ? found.hash : null;
      },
    };
    const names = new Set(listing.entries.keys());
    const wanted =
      root.project === null
        ? Object.keys(desired.skills)
        : (desired.projects[root.project]?.skills ?? []);
    if (root.role === "target") for (const skill of wanted) names.add(skill);
    for (const name of [...names].sort()) {
      const observed = listing.entries.get(name) ?? ABSENT;
      const reconciled = reconcileEntry(observed, desiredAt(desired, root, name), context);
      if (reconciled === null) continue;
      entries.push({
        root: root.path,
        role: root.role,
        readers: root.readers,
        project: root.project,
        name,
        path: join(root.path, name) as AbsPath,
        ...reconciled,
      });
    }
  }
  return entries;
}

function libraryMap(skills: readonly LibrarySkill[]): Library {
  return new Map(skills.map((skill) => [skill.name, skill]));
}

/** The observation and its current diff, shared by the snapshot and every draft. */
interface Model {
  readonly world: World;
  readonly agents: ResolvedAgents;
  /** The roots under HOME, then those of registered projects. */
  readonly roots: readonly Root[];
  readonly library: Library;
  readonly entries: readonly Entry[];
}

/** Every root `desired` names: agents' own dirs under HOME, then registered projects' dirs. */
export function rootsOf(facts: AgentFacts, desired: DesiredState): Root[] {
  const home = resolveAgents(facts, desired.agents).roots;
  return [...home, ...resolveProjects(facts, desired.projects, home)];
}

function modelOf(world: World): Model {
  const agents = resolveAgents(world.facts, world.desired.agents);
  const roots = [
    ...agents.roots,
    ...resolveProjects(world.facts, world.desired.projects, agents.roots),
  ];
  const library = libraryMap(world.library);
  return {
    world,
    agents,
    roots,
    library,
    entries: reconcileAll(world.desired, library, world.listings, roots),
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function view(world: World): Snapshot {
  const { agents, roots, library, entries } = modelOf(world);
  const installed = agents.agents.filter((agent) => agent.installed && !agent.guarded);
  const byLocation = new Map(entries.map((entry) => [`${entry.root}\0${entry.name}`, entry]));
  const names = new Set<SkillName>([
    ...library.keys(),
    ...(Object.keys(world.desired.skills) as SkillName[]),
  ]);

  const skills = [...names].sort().map((name) => {
    const found = library.get(name);
    const record = world.desired.skills[name];
    const issues: SkillIssue[] = [...(found?.issues ?? [])];
    if (found !== undefined && record === undefined) issues.push({ kind: "untracked" });
    if (found === undefined) issues.push({ kind: "libraryMissing" });
    return {
      name,
      description: found?.description ?? null,
      dir: join(world.libraryDir, name) as AbsPath,
      hash: found?.hash ?? null,
      source: record?.source ?? null,
      installedAt: record?.installedAt ?? null,
      cells: installed.map((agent) => {
        const root = targetRootOf(agents.roots, agent.id);
        const entry = root === undefined ? undefined : byLocation.get(`${root.path}\0${name}`);
        return {
          agent: agent.id,
          enabled: record !== undefined && isEnabled(record.enabled, agent.id),
          verdict: entry?.verdict ?? ("off" as const),
        };
      }),
      issues,
    };
  });

  const readError = (agent: (typeof agents.agents)[number]): string | null => {
    if (agent.guarded) return "skills dir is inside ~/.gandalf";
    const root = agent.installed ? targetRootOf(agents.roots, agent.id) : undefined;
    const listing = root === undefined ? undefined : world.listings.get(root.path);
    return listing !== undefined && !listing.ok ? listing.error : null;
  };

  const watchPaths = new Set<AbsPath>();
  if (world.facts.realpaths.has(world.gandalfDir)) watchPaths.add(world.gandalfDir);
  if (world.libraryExists) watchPaths.add(world.libraryDir);
  for (const root of roots) {
    const listing = world.listings.get(root.path);
    if (listing?.ok === true && listing.exists) watchPaths.add(root.path);
  }
  for (const agent of installed) {
    for (const dir of agent.detectDirs) if (world.facts.realpaths.has(dir)) watchPaths.add(dir);
  }

  return {
    revision: world.desired.revision,
    libraryDir: world.libraryDir,
    agents: agents.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      installed: agent.installed,
      skillsDir: agent.skillsDir,
      builtInSkillsDir: agent.builtInSkillsDir,
      scanDirs: agent.scanDirs,
      projectDir: agent.projectDir,
      mode: agent.mode,
      overridden: agent.overridden,
      readError: readError(agent),
    })),
    roots,
    skills,
    projects: projectsOf(world, roots),
    entries,
    problems: problemsOf(entries, skills),
    watchPaths: [...watchPaths],
  };
}

function projectsOf(world: World, roots: readonly Root[]): ProjectView[] {
  return (Object.keys(world.desired.projects).sort() as AbsPath[]).map((path) => {
    const project = world.desired.projects[path]!;
    const errors = roots.flatMap((root) => {
      const listing = root.project === path ? world.listings.get(root.path) : undefined;
      return listing !== undefined && !listing.ok ? [listing.error] : [];
    });
    return {
      path,
      agents: project.agents,
      skills: project.skills,
      readError: errors[0] ?? null,
    };
  });
}

function problemsOf(
  entries: readonly Entry[],
  skills: readonly { readonly name: SkillName; readonly issues: readonly SkillIssue[] }[],
): Problem[] {
  const problems: Problem[] = [];
  for (const entry of entries) {
    const kind =
      entry.observed.kind === "link" && !entry.observed.resolves
        ? "brokenLink"
        : entry.observed.kind === "modifiedCopy"
          ? "modifiedCopy"
          : entry.verdict === "conflict" || entry.verdict === "blocked"
            ? entry.verdict
            : entry.verdict === "missing" || entry.verdict === "repair" || entry.verdict === "extra"
              ? "drift"
              : null;
    if (kind !== null) problems.push({ kind, entry });
  }
  for (const skill of skills) {
    if (skill.issues.some((issue) => issue.kind === "libraryMissing")) {
      problems.push({ kind: "libraryMissing", skill: skill.name });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Verdict -> steps. The only place slot steps are built.
// ---------------------------------------------------------------------------

type Removal = Extract<Step, { kind: "unlink" | "trashCopy" | "trashProjectCopy" }>;
type Creation = Extract<Step, { kind: "link" | "copy" | "projectCopy" }>;
type LibraryOp = Extract<
  Step,
  { kind: "libraryAdd" | "libraryReplace" | "libraryTrash" | "adoptMove" | "trashDuplicate" }
>;

/** Accepts only Owned evidence. No Unowned observation can reach a removal through this file. */
function removal(slot: Slot, observed: Owned, project: AbsPath | null): Removal {
  switch (observed.kind) {
    case "link":
      return { kind: "unlink", slot, skill: observed.skill };
    case "cleanCopy":
      return project === null
        ? { kind: "trashCopy", slot, hash: observed.hash }
        : { kind: "trashProjectCopy", slot, hash: observed.hash };
  }
}

function creation(
  slot: Slot,
  desired: Desired,
  libraryHash: ContentHash,
  symlinks: boolean,
  project: AbsPath | null,
): Creation {
  if (project !== null)
    return { kind: "projectCopy", slot, skill: desired.skill, hash: libraryHash };
  const mode = desired.mode === "auto" ? (symlinks ? "link" : "copy") : desired.mode;
  return mode === "link"
    ? { kind: "link", slot, skill: desired.skill }
    : { kind: "copy", slot, skill: desired.skill, hash: libraryHash };
}

/** missing -> create; repair -> remove + create; extra -> remove; every other verdict -> nothing. */
function slotSteps(
  entry: Entry,
  library: Library,
  symlinks: ReadonlyMap<AbsPath, boolean>,
): (Removal | Creation)[] {
  const slot = { root: entry.root, name: entry.name };
  const create = (desired: Desired): Creation =>
    creation(
      slot,
      desired,
      library.get(desired.skill)!.hash,
      symlinks.get(entry.root) ?? true,
      entry.project,
    );
  switch (entry.verdict) {
    case "missing":
      return [create(entry.desired)];
    case "repair":
      return [removal(slot, entry.observed, entry.project), create(entry.desired)];
    case "extra":
      return [removal(slot, entry.observed, entry.project)];
    default:
      return [];
  }
}

function needsCreation(entry: Entry): boolean {
  return (
    (entry.verdict === "missing" || entry.verdict === "repair") && entry.desired.mode === "auto"
  );
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

type Scope = "all" | ReadonlySet<SkillName>;

/** What one intent means, before the shared diff runs. */
interface Draft {
  readonly changes: readonly StateChange[];
  readonly libraryOps: readonly LibraryOp[];
  /** Entries whose skill (desired or observed) is in scope get slot steps and conflict reports. */
  readonly scope: Scope;
  /** When set, only roots under HOME these agents target before or after the change are diffed. */
  readonly targets?: ReadonlySet<AgentId>;
  /** When set, only this project's roots, before or after the change, are diffed. */
  readonly project?: AbsPath;
  readonly notDone: readonly NotDone[];
}

/**
 * Pure. `intent` arrives with pins already filled by gandalf.ts, so the same (intent, world) always
 * yields the same plan, which is what lets apply() re-derive it and compare fingerprints.
 */
export function planIntent(intent: Intent, world: World, resolved: Resolved): Planned {
  const model = modelOf(world);
  const draft = draftFor(intent, model, resolved);
  if ("kind" in draft) return { ok: false, error: draft };
  return finish(intent, model, draft);
}

function draftFor(intent: Intent, model: Model, resolved: Resolved): Draft | PlanError {
  switch (intent.kind) {
    case "sync":
      return {
        changes: [],
        libraryOps: [],
        scope: intent.skills === "all" ? "all" : new Set(intent.skills),
        notDone: [],
      };
    case "setEnabled":
      return draftSetEnabled(intent, model);
    case "adopt":
      return draftAdopt(intent, model);
    case "install":
      return draftInstall(intent, model, resolved);
    case "update":
      return draftUpdate(intent, model, resolved);
    case "remove":
      return draftRemove(intent, model);
    case "configureAgent":
      return {
        changes: [
          {
            kind: "setAgent",
            agent: intent.agent,
            skillsDir: intent.skillsDir,
            mode: intent.mode,
          },
        ],
        libraryOps: [],
        scope: "all",
        targets: new Set([intent.agent]),
        notDone: [],
      };
    case "configureProject":
      return draftConfigureProject(intent, model);
    case "removeProject":
      if (model.world.desired.projects[intent.path] === undefined) {
        return { kind: "unknownProject", path: intent.path };
      }
      return {
        changes: [{ kind: "untrackProject", project: intent.path }],
        libraryOps: [],
        scope: new Set(),
        project: intent.path,
        notDone: [],
      };
    case "setProjectSkills":
      return draftSetProjectSkills(intent, model);
  }
}

function draftConfigureProject(
  intent: Extract<Intent, { kind: "configureProject" }>,
  model: Model,
): Draft | PlanError {
  const home = new Set(model.agents.roots.map((root) => root.path));
  for (const agent of intent.agents) {
    const dir = projectSkillsDir(intent.path, agent);
    if (dir === null) return { kind: "noProjectDir", agent };
    if (projectDirBlocked(model.world.facts, dir, home)) {
      return { kind: "projectOverlaps", path: intent.path, agent, dir };
    }
  }
  return {
    changes: [{ kind: "setProject", project: intent.path, agents: intent.agents }],
    libraryOps: [],
    scope: "all",
    project: intent.path,
    notDone: [],
  };
}

/** A library skill nothing tracks yet is tracked, off for every agent, so it has a source. */
function draftSetProjectSkills(
  intent: Extract<Intent, { kind: "setProjectSkills" }>,
  model: Model,
): Draft | PlanError {
  if (model.world.desired.projects[intent.project] === undefined) {
    return { kind: "unknownProject", path: intent.project };
  }
  const changes: StateChange[] = [];
  for (const skill of [...new Set(intent.skills)].sort()) {
    const record = model.world.desired.skills[skill];
    if (intent.enabled && record === undefined) {
      if (!model.library.has(skill)) return { kind: "unknownSkill", skill };
      changes.push({
        kind: "track",
        skill,
        source: { kind: "local", path: null },
        enabled: { default: false, except: [] },
      });
    }
    changes.push({
      kind: "setProjectSkill",
      project: intent.project,
      skill,
      enabled: intent.enabled,
    });
  }
  return {
    changes,
    libraryOps: [],
    scope: new Set(intent.skills),
    project: intent.project,
    notDone: [],
  };
}

function notInstalled(model: Model, agents: "all" | readonly AgentId[]): PlanError | null {
  if (agents === "all") return null;
  const agent = agents.find(
    (id) => model.agents.agents.find((candidate) => candidate.id === id)?.installed !== true,
  );
  return agent === undefined ? null : { kind: "agentNotInstalled", agent };
}

function draftSetEnabled(
  intent: Extract<Intent, { kind: "setEnabled" }>,
  model: Model,
): Draft | PlanError {
  const record = model.world.desired.skills[intent.skill];
  if (record === undefined && !model.library.has(intent.skill)) {
    return { kind: "unknownSkill", skill: intent.skill };
  }
  const error = notInstalled(model, intent.agents);
  if (error !== null) return error;
  const change: StateChange =
    record === undefined
      ? {
          kind: "track",
          skill: intent.skill,
          source: { kind: "local", path: null },
          enabled: withAgents({ default: false, except: [] }, intent.agents, intent.enabled),
        }
      : {
          kind: "setEnabled",
          skill: intent.skill,
          enabled: withAgents(record.enabled, intent.agents, intent.enabled),
        };
  return { changes: [change], libraryOps: [], scope: new Set([intent.skill]), notDone: [] };
}

function locationOf(entry: Entry): EntryLocation {
  return {
    root: entry.root,
    role: entry.role,
    readers: entry.readers,
    project: entry.project,
    name: entry.name,
    path: entry.path,
  };
}

function draftAdopt(intent: Extract<Intent, { kind: "adopt" }>, model: Model): Draft | PlanError {
  const candidates = new Map<SkillName, (EntryLocation & { readonly hash: ContentHash })[]>();
  for (const entry of model.entries) {
    // A project's skills belong to the project, not to every agent.
    if (entry.observed.kind !== "skillDir" || entry.project !== null) continue;
    const name = intakeName(entry.observed.declaredName, entry.name);
    if (name === null) continue;
    candidates.set(name, [
      ...(candidates.get(name) ?? []),
      { ...locationOf(entry), hash: entry.observed.hash },
    ]);
  }
  const names = intent.names === "all" ? [...candidates.keys()].sort() : intent.names;
  const targetsOf = (location: EntryLocation): readonly AgentId[] =>
    model.agents.roots.find((root) => root.path === location.root)?.targets ?? [];
  // Target roots first, so the dir moved into the library comes from an agent's own skills dir.
  const preferTargets = (a: EntryLocation, b: EntryLocation): number =>
    Number(a.role === "scan") - Number(b.role === "scan") || a.path.localeCompare(b.path);

  const changes: StateChange[] = [];
  const libraryOps: LibraryOp[] = [];
  const notDone: NotDone[] = [];
  const scope = new Set<SkillName>();

  for (const name of names) {
    const found = [...(candidates.get(name) ?? [])].sort(preferTargets);
    const record = model.world.desired.skills[name];
    const inLibrary = model.library.get(name);
    let chosen: readonly (EntryLocation & { readonly hash: ContentHash })[];
    let source: SkillSource;

    if (inLibrary !== undefined) {
      chosen = found.filter((location) => location.hash === inLibrary.hash);
      for (const location of found.filter((l) => l.hash !== inLibrary.hash)) {
        notDone.push({ kind: "differsFromLibrary", name, at: stripHash(location) });
      }
      // A recorded adopt whose move already happened (a re-run after a crash) still finishes its
      // links, so it stays in scope with nothing left to move.
      if (chosen.length === 0 && record === undefined) {
        if (found.length === 0 && intent.names !== "all") return { kind: "nothingToAdopt", name };
        continue;
      }
      libraryOps.push(...chosen.map((location) => trashDuplicate(name, location)));
      source = { kind: "adopted", from: null };
    } else if (found.length === 0) {
      if (intent.names === "all") continue;
      return { kind: "nothingToAdopt", name };
    } else {
      const variants = groupVariants(found);
      const variant =
        variants.length === 1
          ? variants[0]
          : pickVariant(
              variants,
              intent.pick.find((pick) => pick.name === name),
              targetsOf,
            );
      if (variant === undefined) {
        notDone.push({ kind: "needsChoice", name, variants });
        continue;
      }
      for (const other of variants.filter((v) => v !== variant)) {
        for (const at of other.at) notDone.push({ kind: "differsFromLibrary", name, at });
      }
      chosen = found.filter((location) => location.hash === variant.hash);
      const [first, ...rest] = chosen;
      if (first === undefined) continue;
      libraryOps.push(
        { kind: "adoptMove", skill: name, from: stripHash(first), hash: first.hash },
        ...rest.map((location) => trashDuplicate(name, location)),
      );
      source = {
        kind: "adopted",
        from: first.role === "target" ? (targetsOf(first)[0] ?? null) : null,
      };
    }

    const readers = chosen.flatMap((location) => location.readers);
    changes.push(
      record === undefined
        ? {
            kind: "track",
            skill: name,
            source,
            enabled: withAgents({ default: false, except: [] }, readers, true),
          }
        : { kind: "setEnabled", skill: name, enabled: withAgents(record.enabled, readers, true) },
    );
    scope.add(name);
  }
  return { changes, libraryOps, scope, notDone };
}

function stripHash(location: EntryLocation & { readonly hash: ContentHash }): EntryLocation {
  const { root, role, readers, project, name, path } = location;
  return { root, role, readers, project, name, path };
}

function trashDuplicate(
  skill: SkillName,
  location: EntryLocation & { readonly hash: ContentHash },
): LibraryOp {
  return { kind: "trashDuplicate", skill, from: stripHash(location), hash: location.hash };
}

function groupVariants(
  locations: readonly (EntryLocation & { readonly hash: ContentHash })[],
): AdoptVariant[] {
  const byHash = new Map<ContentHash, EntryLocation[]>();
  for (const location of locations) {
    byHash.set(location.hash, [...(byHash.get(location.hash) ?? []), stripHash(location)]);
  }
  return [...byHash].sort(([a], [b]) => a.localeCompare(b)).map(([hash, at]) => ({ hash, at }));
}

/** By hash, or by agent: the one variant in that agent's own dir, else the one it reads. */
function pickVariant(
  variants: readonly AdoptVariant[],
  pick: AdoptPick | undefined,
  targetsOf: (location: EntryLocation) => readonly AgentId[],
): AdoptVariant | undefined {
  if (pick === undefined) return undefined;
  if (pick.kind === "hash") return variants.find((variant) => variant.hash === pick.hash);
  const only = (matches: AdoptVariant[]) => (matches.length === 1 ? matches[0] : undefined);
  return (
    only(variants.filter((v) => v.at.some((at) => targetsOf(at).includes(pick.agent)))) ??
    only(variants.filter((v) => v.at.some((at) => at.readers.includes(pick.agent))))
  );
}

function draftInstall(
  intent: Extract<Intent, { kind: "install" }>,
  model: Model,
  resolved: Resolved,
): Draft | PlanError {
  if (resolved.source === null) return { kind: "badSource", reason: "source was not resolved" };
  const error = notInstalled(model, intent.agents);
  if (error !== null) return error;
  const changes: StateChange[] = [];
  const libraryOps: LibraryOp[] = [];
  const scope = new Set<SkillName>();
  for (const source of [resolved.source, ...resolved.also]) {
    const name = source.name;
    // Two sources of one plan that name the same skill would each claim its library dir.
    if (scope.has(name)) return { kind: "nameTaken", skill: name };
    const record = model.world.desired.skills[name];
    const inLibrary = model.library.get(name);
    const recorded = sourceOf(source);
    if (record !== undefined && !sameOrigin(record.source, recorded)) {
      return { kind: "nameTaken", skill: name };
    }
    if (record === undefined && inLibrary !== undefined && inLibrary.hash !== source.hash) {
      return { kind: "nameTaken", skill: name };
    }
    changes.push({
      kind: "track",
      skill: name,
      source: recorded,
      enabled:
        intent.agents === "all"
          ? { default: true, except: [] }
          : withAgents({ default: false, except: [] }, intent.agents, true),
    });
    if (inLibrary === undefined) {
      libraryOps.push({
        kind: "libraryAdd",
        skill: name,
        description: source.description,
        from: source.materialize,
        hash: source.hash,
      });
    }
    scope.add(name);
  }
  return { changes, libraryOps, scope, notDone: [] };
}

function sourceOf(source: ResolvedSource): SkillSource {
  const spec = source.spec;
  if (spec.kind === "local") return { kind: "local", path: spec.path };
  if (spec.commit === null)
    throw new Error("git source reached the planner without a pinned commit");
  return { kind: "git", url: spec.url, ref: spec.ref, subpath: spec.subpath, commit: spec.commit };
}

/** Where a skill comes from, ignoring the commit: re-installing a git skill is not a name clash. */
export function sameOrigin(a: SkillSource, b: SkillSource): boolean {
  if (a.kind === "git" && b.kind === "git") {
    return a.url === b.url && a.ref === b.ref && a.subpath === b.subpath;
  }
  return canonicalJson(a) === canonicalJson(b);
}

function draftUpdate(
  intent: Extract<Intent, { kind: "update" }>,
  model: Model,
  resolved: Resolved,
): Draft | PlanError {
  const skills = model.world.desired.skills;
  const names =
    intent.skills === "all"
      ? (Object.keys(skills) as SkillName[]).filter((name) => skills[name]?.source.kind === "git")
      : intent.skills;
  const changes: StateChange[] = [];
  const libraryOps: LibraryOp[] = [];
  const notDone: NotDone[] = [];
  const scope = new Set<SkillName>();
  for (const name of [...names].sort()) {
    const record = skills[name];
    if (record === undefined) return { kind: "unknownSkill", skill: name };
    if (record.source.kind !== "git") return { kind: "notGitSourced", skill: name };
    const update = resolved.updates.get(name);
    if (update === undefined) return { kind: "badSource", reason: `${name} was not resolved` };
    const next = sourceOf(update.target);
    if (next.kind !== "git" || next.commit === record.source.commit) continue;
    const inLibrary = model.library.get(name);
    const setSource: StateChange = { kind: "setSource", skill: name, source: next };
    const materialize = update.target.materialize;
    if (inLibrary === undefined) {
      libraryOps.push({
        kind: "libraryAdd",
        skill: name,
        description: update.target.description,
        from: materialize,
        hash: update.target.hash,
      });
    } else if (inLibrary.hash === update.target.hash) {
      // Already replaced by a run that crashed before recording the commit.
    } else if (inLibrary.hash === update.pristine) {
      libraryOps.push({
        kind: "libraryReplace",
        skill: name,
        expect: inLibrary.hash,
        from: materialize,
        hash: update.target.hash,
      });
    } else {
      notDone.push({ kind: "locallyModified", skill: name });
      continue;
    }
    changes.push(setSource);
    scope.add(name);
  }
  return { changes, libraryOps, scope, notDone };
}

function draftRemove(intent: Extract<Intent, { kind: "remove" }>, model: Model): Draft | PlanError {
  const record = model.world.desired.skills[intent.skill];
  const inLibrary = model.library.get(intent.skill);
  const linked = model.entries.some(
    (entry) => isOwned(entry.observed) && entry.observed.skill === intent.skill,
  );
  if (record === undefined && inLibrary === undefined && !linked) {
    return { kind: "unknownSkill", skill: intent.skill };
  }
  const projects = Object.keys(model.world.desired.projects).sort() as AbsPath[];
  return {
    changes: [
      ...(record === undefined ? [] : [{ kind: "untrack", skill: intent.skill } as const]),
      ...projects
        .filter((project) => model.world.desired.projects[project]?.skills.includes(intent.skill))
        .map((project): StateChange => ({
          kind: "setProjectSkill",
          project,
          skill: intent.skill,
          enabled: false,
        })),
    ],
    libraryOps:
      inLibrary === undefined
        ? []
        : [{ kind: "libraryTrash", skill: intent.skill, expect: inLibrary.hash }],
    scope: new Set([intent.skill]),
    notDone: [],
  };
}

// ---------------------------------------------------------------------------
// Simulate the draft, diff the result, order the steps
// ---------------------------------------------------------------------------

/** The time never reaches a step: commitState carries changes, and apply stamps its own clock. */
const SIMULATED_TIME = "1970-01-01T00:00:00.000Z" as IsoTime;

function simulateLibrary(model: Model, ops: readonly LibraryOp[]): Library {
  const library = new Map(model.library);
  for (const op of ops) {
    if (op.kind === "libraryTrash") library.delete(op.skill);
    if (op.kind === "libraryAdd" || op.kind === "adoptMove" || op.kind === "libraryReplace") {
      library.set(op.skill, {
        name: op.skill,
        dir: join(model.world.libraryDir, op.skill) as AbsPath,
        hash: op.hash,
        valid: true,
        description: null,
        issues: [],
      });
    }
  }
  return library;
}

function simulateListings(
  listings: ReadonlyMap<AbsPath, RootListing>,
  ops: readonly LibraryOp[],
): ReadonlyMap<AbsPath, RootListing> {
  const next = new Map(listings);
  for (const op of ops) {
    if (op.kind !== "adoptMove" && op.kind !== "trashDuplicate") continue;
    const listing = next.get(op.from.root);
    if (listing === undefined || !listing.ok) continue;
    const entries = new Map(listing.entries);
    entries.delete(op.from.name);
    next.set(op.from.root, { ...listing, entries });
  }
  return next;
}

function inScope(entry: Entry, scope: Scope): boolean {
  if (scope === "all") return true;
  const observedSkill = "skill" in entry.observed ? entry.observed.skill : null;
  return (
    (entry.desired !== null && scope.has(entry.desired.skill)) ||
    (observedSkill !== null && scope.has(observedSkill)) ||
    scope.has(entry.name as SkillName)
  );
}

function finish(intent: Intent, model: Model, draft: Draft): Planned {
  const { world } = model;
  const next = applyChanges(world.desired, draft.changes, SIMULATED_TIME);
  const library = simulateLibrary(model, draft.libraryOps);
  const listings = simulateListings(world.listings, draft.libraryOps);
  const nextRoots = rootsOf(world.facts, next);
  // A dir that stops being anyone's target stays in the diff as a target nobody desires, so the
  // entries gandalf owns there come out as `extra`. A project that is forgotten keeps its copies.
  const retired = model.roots
    .filter((root) => root.role === "target")
    .filter((root) => root.project === null || next.projects[root.project] !== undefined)
    .filter((root) => !nextRoots.some((nextRoot) => nextRoot.path === root.path))
    .map((root): Root => ({ ...root, targets: [] }));
  const { targets, project } = draft;
  const before = new Map(model.roots.map((root) => [root.path, root]));
  const diffed = (path: AbsPath): boolean => {
    const roots = [before.get(path), nextRoots.find((root) => root.path === path)];
    if (targets !== undefined) {
      return roots.some(
        (root) => root?.project === null && root.targets.some((agent) => targets.has(agent)),
      );
    }
    return project === undefined || roots.some((root) => root?.project === project);
  };
  const entries = reconcileAll(next, library, listings, [...nextRoots, ...retired]).filter(
    (entry) => entry.role === "target" && inScope(entry, draft.scope) && diffed(entry.root),
  );

  const unprobed = [...new Set(entries.filter(needsCreation).map((entry) => entry.root))].filter(
    (root) => !world.symlinks.has(root),
  );
  if (unprobed.length > 0) return { probe: unprobed };

  const slot = entries.flatMap((entry) => slotSteps(entry, library, world.symlinks));
  const changes = [...draft.changes, ...copyChanges(world, next, slot, diffed)];
  const commit: Step[] = isNoop(world.desired, changes)
    ? []
    : [{ kind: "commitState", from: world.desired.revision, changes }];

  const ensure = new Set<AbsPath>();
  for (const step of slot) {
    if (step.kind !== "link" && step.kind !== "copy" && step.kind !== "projectCopy") continue;
    const listing = listings.get(step.slot.root);
    if (listing?.ok === true && !listing.exists) ensure.add(step.slot.root);
  }
  const adds = draft.libraryOps.some((op) => op.kind === "libraryAdd" || op.kind === "adoptMove");
  if (adds && !world.libraryExists) ensure.add(world.libraryDir);

  const notDone: NotDone[] = [...draft.notDone];
  for (const entry of entries) {
    if (entry.verdict === "conflict") notDone.push({ kind: "conflict", entry });
  }
  const blocked = new Set(
    entries.flatMap((entry) => (entry.verdict === "blocked" ? [entry.desired.skill] : [])),
  );
  for (const skill of [...blocked].sort()) notDone.push({ kind: "libraryMissing", skill });
  for (const root of nextRoots) {
    const listing = listings.get(root.path);
    if (root.role === "target" && diffed(root.path) && listing !== undefined && !listing.ok) {
      notDone.push({ kind: "rootUnreadable", root: root.path, error: listing.error });
    }
  }

  const steps = sortSteps([
    ...commit,
    ...[...ensure].map((dir): Step => ({ kind: "ensureDir", dir })),
    ...draft.libraryOps,
    ...slot,
  ]);
  return { ok: true, plan: { intent, steps, notDone, fingerprint: fingerprint(intent, steps) } };
}

/**
 * The copy records a plan's project steps imply. Each copy is recorded in the commit before it is
 * placed, and each record is dropped in the commit after its copy is trashed, so a crash in between
 * leaves a record for a slot that is empty. Such records, in the projects the plan diffs, are dropped.
 */
function copyChanges(
  world: World,
  next: DesiredState,
  slot: readonly Step[],
  diffed: (root: AbsPath) => boolean,
): StateChange[] {
  const changes: StateChange[] = [];
  const stepped = new Set<AbsPath>();
  const projectOf = new Map(
    [...rootsOf(world.facts, world.desired), ...rootsOf(world.facts, next)].map((root) => [
      root.path,
      root.project,
    ]),
  );
  for (const step of slot) {
    if (step.kind !== "projectCopy" && step.kind !== "trashProjectCopy") continue;
    const path = join(step.slot.root, step.slot.name) as AbsPath;
    stepped.add(path);
    const project = projectOf.get(step.slot.root);
    if (project == null) continue;
    changes.push(
      step.kind === "projectCopy"
        ? { kind: "recordCopy", project, path, skill: step.skill, hash: step.hash }
        : { kind: "forgetCopy", project, path },
    );
  }
  for (const project of Object.keys(next.projects).sort() as AbsPath[]) {
    for (const path of Object.keys(next.projects[project]?.copies ?? {}).sort() as AbsPath[]) {
      const listing = world.listings.get(dirname(path) as AbsPath);
      if (stepped.has(path) || !diffed(dirname(path) as AbsPath)) continue;
      if (listing?.ok === true && !listing.entries.has(basename(path))) {
        changes.push({ kind: "forgetCopy", project, path });
      }
    }
  }
  return changes;
}

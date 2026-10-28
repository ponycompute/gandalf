// Recorded intent, and ~/.gandalf/state.json, where gandalf kept it before state.db (stateDb.ts).
// Never evidence of ownership.
//
// The intent says what the user wants: which skills are tracked, where each came from, where each
// is enabled, and per-agent overrides. Whether an entry on disk belongs to gandalf is decided only by
// evidence on the entry (disk.ts). Losing or corrupting the intent can make gandalf do less. It can
// never make gandalf touch something it did not create.
//
// state.json's storage schema, also the shape state.db's rows are rebuilt into for parseState
// (private; parseState is the only reader, serializeState the only writer):
//
//   {
//     "schema": 1,
//     "revision": 42,
//     "skills": {
//       "pdf-tools": {
//         "source": { "kind": "git", "url": "https://...", "ref": "main", "subpath": "skills/pdf", "commit": "<40 hex>" },
//         "installedAt": "2026-10-24T09:00:00.000Z",
//         "enabled": { "default": true, "except": ["codex"] }
//       }
//     },
//     "agents": {
//       "cursor": { "skillsDir": "/Users/me/work/cursor-skills", "mode": null }
//     },
//     "projects": {
//       "/Users/me/work/api": {
//         "agents": ["claude_code"],
//         "skills": ["pdf-tools"],
//         "copies": {
//           "/Users/me/work/api/.claude/skills/pdf-tools": { "skill": "pdf-tools", "hash": "sha256:<hex>" }
//         }
//       }
//     }
//   }
//
// "projects" is left out while there are none. A copy in a project carries no marker, since the
// project is usually committed and shared, so its entry under "copies" is the one piece of ownership
// evidence kept here. It counts only together with the content: a copy is gandalf's while it still
// hashes to the recorded hash. Losing the file still only makes gandalf do less.

import {
  AGENT_IDS,
  byRegistryOrder,
  isAgentId,
  type AgentId,
  type AgentOverride,
  type AgentOverrides,
} from "./agents.js";
import type { Fs, Layout } from "./env.js";
import { canonicalJson, sortKeys } from "./json.js";
import { parseAbsPath, parseContentHash, parseSkillName } from "./parse.js";
import type {
  AbsPath,
  ContentHash,
  Enablement,
  GitCommit,
  IsoTime,
  ModeSetting,
  Revision,
  Selection,
  SkillName,
  SkillSource,
  StateChange,
} from "./types.js";

export interface SkillRecord {
  readonly source: SkillSource;
  readonly installedAt: IsoTime;
  readonly enabled: Enablement;
}

export interface CopyRecord {
  readonly skill: SkillName;
  readonly hash: ContentHash;
}

export interface ProjectRecord {
  /** In registry order. */
  readonly agents: readonly AgentId[];
  /** Sorted. */
  readonly skills: readonly SkillName[];
  /** The copies gandalf placed in the project, by path. */
  readonly copies: Readonly<Partial<Record<AbsPath, CopyRecord>>>;
}

export interface DesiredState {
  readonly revision: Revision;
  readonly skills: Readonly<Partial<Record<SkillName, SkillRecord>>>;
  readonly agents: AgentOverrides;
  readonly projects: Readonly<Partial<Record<AbsPath, ProjectRecord>>>;
}

export const EMPTY_STATE: DesiredState = {
  revision: 0 as Revision,
  skills: {},
  agents: {},
  projects: {},
};

export class StateCorruptError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(
      `${path} is unreadable (${reason}). gandalf will not write until it is fixed or moved aside.`,
    );
  }
}

/** ENOENT yields the empty state at revision 0. Anything unparseable throws StateCorruptError. */
export async function readState(fs: Fs, paths: Layout): Promise<DesiredState> {
  const bytes = await fs.readFile(paths.stateFile);
  if (bytes === null) return EMPTY_STATE;
  try {
    return parseState(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    throw new StateCorruptError(
      paths.stateFile,
      error instanceof Error ? error.message : "invalid",
    );
  }
}

/** Boundary parse. Unknown agent ids (an agent dropped from the registry) are ignored, not fatal. */
export function parseState(raw: unknown): DesiredState {
  const root = object(raw, "state");
  if (root.schema !== 1) throw new Error(`unsupported schema ${String(root.schema)}`);
  const revision = root.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    throw new Error("revision must be a non-negative integer");
  }
  const skills: Partial<Record<SkillName, SkillRecord>> = {};
  for (const [key, value] of Object.entries(object(root.skills, "skills"))) {
    const name = parseSkillName(key);
    if (name === null) throw new Error(`invalid skill name ${JSON.stringify(key)}`);
    const record = object(value, `skills.${key}`);
    if (typeof record.installedAt !== "string") throw new Error(`skills.${key}.installedAt`);
    skills[name] = {
      source: parseSource(record.source, `skills.${key}.source`),
      installedAt: record.installedAt as IsoTime,
      enabled: parseEnablement(record.enabled, `skills.${key}.enabled`),
    };
  }
  const agents: Partial<Record<AgentId, AgentOverride>> = {};
  for (const [key, value] of Object.entries(object(root.agents, "agents"))) {
    if (!isAgentId(key)) continue;
    const override = object(value, `agents.${key}`);
    const skillsDir = nullable(override.skillsDir, (dir) =>
      typeof dir === "string" ? parseAbsPath(dir) : null,
    );
    const mode = nullable(override.mode, (mode) => (isModeSetting(mode) ? mode : null));
    if (skillsDir === undefined || mode === undefined) throw new Error(`agents.${key}`);
    if (skillsDir !== null || mode !== null) agents[key] = { skillsDir, mode };
  }
  const projects: Partial<Record<AbsPath, ProjectRecord>> = {};
  for (const [key, value] of Object.entries(object(root.projects ?? {}, "projects"))) {
    const path = parseAbsPath(key);
    if (path === null) throw new Error(`invalid project path ${JSON.stringify(key)}`);
    projects[path] = parseProject(value, `projects.${key}`);
  }
  return { revision: revision as Revision, skills, agents, projects };
}

export function serializeState(state: DesiredState): string {
  const skills = Object.fromEntries(
    Object.keys(state.skills)
      .sort()
      .map((name) => [name, sortKeys(state.skills[name as SkillName])]),
  );
  const agents = Object.fromEntries(
    AGENT_IDS.flatMap((id) => {
      const override = state.agents[id];
      return override === undefined
        ? []
        : [[id, { skillsDir: override.skillsDir, mode: override.mode }]];
    }),
  );
  const paths = Object.keys(state.projects).sort() as AbsPath[];
  const projects = Object.fromEntries(
    paths.map((path) => {
      const project = state.projects[path]!;
      const copies = Object.fromEntries(
        (Object.keys(project.copies).sort() as AbsPath[]).map((copy) => [
          copy,
          sortKeys(project.copies[copy]),
        ]),
      );
      return [path, { agents: project.agents, skills: project.skills, copies }];
    }),
  );
  const document = {
    schema: 1,
    revision: state.revision,
    skills,
    agents,
    ...(paths.length === 0 ? {} : { projects }),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Pure. Idempotent: applyChanges(applyChanges(s, c), c) equals applyChanges(s, c). The revision is
 * left alone; the commitState step bumps it. `track` keeps the existing installedAt when the record
 * already has the same source, so a re-run after a crash does not rewrite history.
 */
export function applyChanges(
  state: DesiredState,
  changes: readonly StateChange[],
  now: IsoTime,
): DesiredState {
  const skills = { ...state.skills };
  const agents: Partial<Record<AgentId, AgentOverride>> = { ...state.agents };
  const projects: Partial<Record<AbsPath, ProjectRecord>> = { ...state.projects };
  for (const change of changes) {
    const record = "skill" in change ? skills[change.skill] : undefined;
    const project = "project" in change ? projects[change.project] : undefined;
    switch (change.kind) {
      case "track":
        skills[change.skill] = {
          source: change.source,
          installedAt:
            record !== undefined && canonicalJson(record.source) === canonicalJson(change.source)
              ? record.installedAt
              : now,
          enabled: normalize(change.enabled),
        };
        break;
      case "untrack":
        delete skills[change.skill];
        break;
      case "setEnabled":
        if (record !== undefined) skills[change.skill] = { ...record, enabled: change.enabled };
        break;
      case "setSource":
        if (record !== undefined) skills[change.skill] = { ...record, source: change.source };
        break;
      case "setAgent":
        if (change.skillsDir === null && change.mode === null) delete agents[change.agent];
        else agents[change.agent] = { skillsDir: change.skillsDir, mode: change.mode };
        break;
      case "setProject":
        projects[change.project] = {
          agents: byRegistryOrder(change.agents),
          skills: project?.skills ?? [],
          copies: project?.copies ?? {},
        };
        break;
      case "untrackProject":
        delete projects[change.project];
        break;
      case "setProjectSkill":
        if (project !== undefined) {
          const others = project.skills.filter((skill) => skill !== change.skill);
          projects[change.project] = {
            ...project,
            skills: (change.enabled ? [...others, change.skill] : others).sort(),
          };
        }
        break;
      case "recordCopy":
        if (project !== undefined) {
          projects[change.project] = {
            ...project,
            copies: {
              ...project.copies,
              [change.path]: { skill: change.skill, hash: change.hash },
            },
          };
        }
        break;
      case "forgetCopy":
        if (project !== undefined) {
          const copies = { ...project.copies };
          delete copies[change.path];
          projects[change.project] = { ...project, copies };
        }
        break;
    }
  }
  return { revision: state.revision, skills, agents, projects };
}

/** True when applying `changes` would leave `state` as it is. Planners emit no commitState then. */
export function isNoop(state: DesiredState, changes: readonly StateChange[]): boolean {
  const unused = "1970-01-01T00:00:00.000Z" as IsoTime;
  return serializeState(applyChanges(state, changes, unused)) === serializeState(state);
}

export function isEnabled(enablement: Enablement, agent: AgentId): boolean {
  return enablement.default !== enablement.except.includes(agent);
}

/**
 * Turn `agents` on or off and renormalize. "all" resets to { default: on, except: [] }.
 * A list toggles membership in `except` so that only agents differing from `default` remain.
 */
export function withAgents(
  enablement: Enablement,
  agents: Selection<AgentId>,
  on: boolean,
): Enablement {
  if (agents === "all") return { default: on, except: [] };
  const except = new Set(enablement.except);
  for (const agent of agents) {
    if (on === enablement.default) except.delete(agent);
    else except.add(agent);
  }
  return { default: enablement.default, except: byRegistryOrder(except) };
}

/** What a commit found: written, already in effect, or another revision in the way. */
export type CommitOutcome =
  | { readonly kind: "done" | "alreadyDone" }
  | { readonly kind: "moved"; readonly revision: Revision };

/**
 * Where recorded intent lives. Everything that reads or writes it goes through this port, so the
 * backing store can change without touching the planner or apply. Whatever the store, it holds
 * intent only: ownership stays decided by evidence on disk (disk.ts).
 */
export interface StateStore {
  /** Where the intent is kept, for messages. */
  readonly location: string;
  /** The empty state at revision 0 when nothing is recorded. Throws StateCorruptError. */
  read(): Promise<DesiredState>;
  /**
   * The commitState step. Compare-and-swap on the revision: `changes` land as revision from + 1
   * only while the store is at `from`. Changes already in effect are alreadyDone at any revision.
   * Caller holds the apply lock.
   */
  commit(from: Revision, changes: readonly StateChange[], now: IsoTime): Promise<CommitOutcome>;
}

/** ~/.gandalf/state.json, the store before state.db. */
export function jsonStateStore(fs: Fs, paths: Layout): StateStore {
  return {
    location: paths.stateFile,
    read: () => readState(fs, paths),
    commit: async (from, changes, now) => {
      const state = await readState(fs, paths);
      if (isNoop(state, changes)) return { kind: "alreadyDone" };
      if (state.revision !== from) return { kind: "moved", revision: state.revision };
      const next = applyChanges(state, changes, now);
      await writeState(fs, paths, { ...next, revision: (from + 1) as Revision });
      return { kind: "done" };
    },
  };
}

/**
 * Atomic replace: write the bytes to a fresh staging file, then rename over state.json.
 * Caller holds the apply lock and has checked the on-disk revision.
 */
export async function writeState(fs: Fs, paths: Layout, next: DesiredState): Promise<void> {
  await fs.mkdir(paths.stagingDir);
  const staged = paths.staging("state.json");
  await fs.writeFile(staged, serializeState(next));
  await fs.rename(staged, paths.stateFile);
}

function normalize(enablement: Enablement): Enablement {
  return { default: enablement.default, except: byRegistryOrder(enablement.except) };
}

function parseEnablement(raw: unknown, field: string): Enablement {
  const enabled = object(raw, field);
  if (typeof enabled.default !== "boolean" || !Array.isArray(enabled.except)) {
    throw new Error(field);
  }
  const except = enabled.except.filter(
    (agent): agent is AgentId => typeof agent === "string" && isAgentId(agent),
  );
  return { default: enabled.default, except: byRegistryOrder(except) };
}

function parseProject(raw: unknown, field: string): ProjectRecord {
  const project = object(raw, field);
  if (!Array.isArray(project.agents) || !Array.isArray(project.skills)) throw new Error(field);
  const agents = project.agents.filter(
    (agent): agent is AgentId => typeof agent === "string" && isAgentId(agent),
  );
  const skills = project.skills.map((raw) => {
    const name = typeof raw === "string" ? parseSkillName(raw) : null;
    if (name === null) throw new Error(`${field}.skills`);
    return name;
  });
  const copies: Partial<Record<AbsPath, CopyRecord>> = {};
  for (const [key, value] of Object.entries(object(project.copies ?? {}, `${field}.copies`))) {
    const path = parseAbsPath(key);
    const copy = object(value, `${field}.copies`);
    const skill = typeof copy.skill === "string" ? parseSkillName(copy.skill) : null;
    const hash = parseContentHash(copy.hash);
    if (path === null || skill === null || hash === null) throw new Error(`${field}.copies`);
    copies[path] = { skill, hash };
  }
  return { agents: byRegistryOrder(agents), skills: [...new Set(skills)].sort(), copies };
}

function parseSource(raw: unknown, field: string): SkillSource {
  const source = object(raw, field);
  switch (source.kind) {
    case "local": {
      const path = nullable(source.path, (path) =>
        typeof path === "string" ? parseAbsPath(path) : null,
      );
      const hash = source.hash === undefined ? null : nullable(source.hash, parseContentHash);
      if (path === undefined || hash === undefined) throw new Error(field);
      return { kind: "local", path, hash };
    }
    case "git": {
      const ref = nullable(source.ref, (ref) => (typeof ref === "string" ? ref : null));
      const subpath = nullable(source.subpath, (sub) => (typeof sub === "string" ? sub : null));
      if (
        typeof source.url !== "string" ||
        source.url === "" ||
        ref === undefined ||
        subpath === undefined ||
        typeof source.commit !== "string" ||
        !/^[0-9a-f]{40}$/.test(source.commit)
      ) {
        throw new Error(field);
      }
      return { kind: "git", url: source.url, ref, subpath, commit: source.commit as GitCommit };
    }
    case "adopted":
      return {
        kind: "adopted",
        from: typeof source.from === "string" && isAgentId(source.from) ? source.from : null,
      };
    default:
      throw new Error(`${field}.kind`);
  }
}

function object(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${field} must be an object`);
  }
  return raw as Record<string, unknown>;
}

/** null stays null; a value parses or yields undefined, which callers report as corrupt. */
function nullable<T>(raw: unknown, parse: (raw: unknown) => T | null): T | null | undefined {
  if (raw === null) return null;
  return parse(raw) ?? undefined;
}

function isModeSetting(raw: unknown): raw is ModeSetting {
  return raw === "auto" || raw === "link" || raw === "copy";
}

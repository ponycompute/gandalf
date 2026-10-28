import type {
  AbsPath,
  AgentId,
  AgentView,
  Entry,
  SkillName,
  SkillView,
  Snapshot,
} from "@gandalf/skills";
import { discoverModel } from "../discover/model";

/** The agents a skill can be turned on for, and the toolbar counts. */
export function libraryAgents(snapshot: Snapshot): readonly AgentView[] {
  return snapshot.agents.filter((agent) => agent.installed && agent.readError === null);
}

/** One choice in the Library's agent filter, with how many library skills the agent has. */
export interface FilterChoice {
  readonly agent: AgentId;
  readonly count: number;
}

/** The skills an agent has: the ones turned on for it, problems and all. */
export function skillsIn(snapshot: Snapshot, agent: AgentId): readonly SkillView[] {
  return snapshot.skills.filter((skill) =>
    skill.cells.some((cell) => cell.agent === agent && cell.enabled),
  );
}

/** Every agent the Library can be filtered to, in the order the app lists them. */
export function filterChoices(snapshot: Snapshot): readonly FilterChoice[] {
  return libraryAgents(snapshot).map((agent) => ({
    agent: agent.id,
    count: skillsIn(snapshot, agent.id).length,
  }));
}

/** The filter as it stands: an agent that went away, or can no longer be filtered to, is none. */
export function currentFilter(snapshot: Snapshot, agent: AgentId | null): AgentId | null {
  if (agent === null) return null;
  return libraryAgents(snapshot).some((view) => view.id === agent) ? agent : null;
}

/** A skill placed in one of the agent's own folders that the library does not manage. */
export interface UnmanagedSkill {
  readonly name: SkillName;
  /** The copy in the agent's folder; Adopt takes every copy of the name. */
  readonly entry: Entry;
}

/** The folders under HOME the agent reads skills from. */
function homeRoots(snapshot: Snapshot, agent: AgentId): ReadonlySet<AbsPath> {
  return new Set(
    snapshot.roots
      .filter((root) => root.project === null && root.readers.includes(agent))
      .map((root) => root.path),
  );
}

/** What Discover lists as Not managed, narrowed to the copies the agent reads. */
export function unmanagedIn(snapshot: Snapshot, agent: AgentId): readonly UnmanagedSkill[] {
  const roots = homeRoots(snapshot, agent);
  return discoverModel(snapshot).notManaged.flatMap((skill) => {
    const entry = skill.copies.find((copy) => roots.has(copy.root));
    return entry === undefined ? [] : [{ name: skill.name, entry }];
  });
}

/** The agent's own skills folder under HOME, the one gandalf writes, when it has one. */
export function ownFolder(snapshot: Snapshot, agent: AgentId): AbsPath | null {
  return (
    snapshot.roots.find((root) => root.project === null && root.targets.includes(agent))?.path ??
    null
  );
}

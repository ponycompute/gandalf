import type {
  AbsPath,
  AgentId,
  AgentView,
  Intent,
  ProjectView,
  SkillName,
  Snapshot,
  Verdict,
} from "@gandalf/skills";

/** One skills folder in a project, with the agents that read it. Shared folders show once. */
export interface ProjectColumn {
  readonly root: AbsPath;
  readonly agents: readonly AgentId[];
}

export interface ProjectCell {
  readonly root: AbsPath;
  readonly verdict: Verdict;
}

export interface ProjectRow {
  readonly skill: SkillName;
  /** One per column, in the columns' order. */
  readonly cells: readonly ProjectCell[];
}

export interface ProjectModel {
  readonly project: ProjectView;
  readonly columns: readonly ProjectColumn[];
  readonly rows: readonly ProjectRow[];
  /** Library skills the project does not get yet, which Add Skill offers. */
  readonly addable: readonly SkillName[];
}

/**
 * Every project with its skills folders and what each holds. A desired copy always has an entry,
 * so a cell without one is a folder gandalf could not read, which the project's error explains.
 */
export function projectModels(snapshot: Snapshot): readonly ProjectModel[] {
  return snapshot.projects.map((project) => {
    const columns = snapshot.roots
      .filter((root) => root.project === project.path)
      .map((root) => ({ root: root.path, agents: root.targets }));
    const rows = project.skills.map((skill) => ({
      skill,
      cells: columns.map(({ root }) => ({
        root,
        verdict:
          snapshot.entries.find((entry) => entry.root === root && entry.name === skill)?.verdict ??
          "blocked",
      })),
    }));
    const addable = snapshot.skills
      .map((skill) => skill.name)
      .filter((name) => !project.skills.includes(name));
    return { project, columns, rows, addable };
  });
}

/** Agents gandalf can write project skills for, installed or not, in registry order. */
export function projectAgents(snapshot: Snapshot): readonly AgentView[] {
  return snapshot.agents.filter((agent) => agent.projectDir !== null);
}

/** The agents a new project starts with: the installed ones that read project skills. */
export function defaultAgents(snapshot: Snapshot): readonly AgentId[] {
  return projectAgents(snapshot)
    .filter((agent) => agent.installed)
    .map((agent) => agent.id);
}

/** configureProject with `agent` turned on or off, the rest kept in registry order. */
export function toggleAgent(
  snapshot: Snapshot,
  project: ProjectView,
  agent: AgentId,
  on: boolean,
): Intent {
  const agents = projectAgents(snapshot)
    .map((view) => view.id)
    .filter((id) => (id === agent ? on : project.agents.includes(id)));
  return { kind: "configureProject", path: project.path, agents };
}

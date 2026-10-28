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
  /** The folder inside the project, such as .claude/skills. */
  readonly dir: string;
  readonly agents: readonly AgentId[];
  /** How many of the project's skills this folder holds a good copy of. */
  readonly copies: number;
}

export interface ProjectCell {
  readonly root: AbsPath;
  readonly verdict: Verdict;
}

export interface ProjectRow {
  readonly skill: SkillName;
  /** The library skill's description, which the row shows under its name. */
  readonly description: string | null;
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
    const roots = snapshot.roots.filter((root) => root.project === project.path);
    const rows = project.skills.map((skill) => ({
      skill,
      description: snapshot.skills.find((view) => view.name === skill)?.description ?? null,
      cells: roots.map(({ path: root }) => ({
        root,
        verdict:
          snapshot.entries.find((entry) => entry.root === root && entry.name === skill)?.verdict ??
          "blocked",
      })),
    }));
    const columns = roots.map((root, at) => ({
      root: root.path,
      dir: root.path.slice(project.path.length + 1),
      agents: root.targets,
      copies: rows.filter((row) => row.cells[at]?.verdict === "ok").length,
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

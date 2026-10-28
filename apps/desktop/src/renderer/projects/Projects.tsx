import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import type { AbsPath, Intent, SkillName, Snapshot } from "@gandalf/skills";
import type { AppError } from "../../shared/ipc";
import { AppliedSummary } from "../changes/AppliedSummary";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { AgentMarks } from "../design/AgentMarks";
import { Button } from "../design/Button";
import { Menu, type MenuItem } from "../design/Menu";
import { PathText } from "../design/PathText";
import { invoke } from "../invoke";
import { errorText } from "../settings/General";
import { SettingRow, SettingsGroup, SettingsPage } from "../settings/SettingsGroup";
import { projectName, verdictWord, type Names } from "../vocabulary";
import {
  defaultAgents,
  projectAgents,
  projectModels,
  toggleAgent,
  type ProjectModel,
  type ProjectRow,
} from "./model";

interface ProjectPaneProps {
  readonly snapshot: Snapshot;
  readonly flow: Flow;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
  readonly project: AbsPath;
}

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

interface ProjectProps {
  readonly model: ProjectModel;
  readonly snapshot: Snapshot;
  readonly names: Names;
  readonly plan: (intent: Intent) => void;
}

/** "Copied" once every folder holds the skill, or what is wrong in the first one that doesn't. */
function rowStatus(row: ProjectRow, names: Names): string {
  const bad = row.cells.find((cell) => cell.verdict !== "ok");
  if (bad !== undefined) return `${verdictWord(bad.verdict, "copy")} in ${names.folder(bad.root)}`;
  return row.cells.length === 0 ? "In no folder yet" : verdictWord("ok", "copy");
}

/**
 * One project, in three groups: the skills it gets, the agents' folders they are copied into, and
 * the project folder itself. The folders are the agents' own, such as .claude/skills, so the
 * skills travel with the repo.
 */
function Project({ model, snapshot, names, plan }: ProjectProps) {
  const { project, columns, rows, addable } = model;
  const name = projectName(project.path);
  const [revealError, setRevealError] = useState<string | null>(null);
  const setSkill = (skill: SkillName, enabled: boolean): Intent => ({
    kind: "setProjectSkills",
    project: project.path,
    skills: [skill],
    enabled,
  });
  const addItems: readonly MenuItem[] =
    addable.length === 0
      ? [{ label: "Every library skill is in this project", onSelect: () => {}, disabled: true }]
      : addable.map((skill) => ({ label: skill, onSelect: () => plan(setSkill(skill, true)) }));
  const choices = projectAgents(snapshot);
  const agentItems: readonly MenuItem[] = [
    ...choices.filter((agent) => agent.installed),
    ...choices.filter((agent) => !agent.installed),
  ].map((agent, at, all) => ({
    label: agent.installed ? agent.displayName : `${agent.displayName} (not installed)`,
    icon: <AgentLogo agent={agent.id} size={16} />,
    checked: project.agents.includes(agent.id),
    separated: at > 0 && !agent.installed && all[at - 1]?.installed === true,
    onSelect: () =>
      plan(toggleAgent(snapshot, project, agent.id, !project.agents.includes(agent.id))),
  }));
  const reveal = async () => {
    const result = await invoke(() => window.gandalf.revealProject(project.path));
    setRevealError(result.ok ? null : `gandalf could not show ${name}${errorText(result.error)}.`);
  };

  return (
    <>
      <SettingsGroup
        title={rows.length === 0 ? "Skills" : `Skills · ${rows.length}`}
        label={`Skills in ${name}`}
        action={
          <Menu label={`Add a skill to ${name}`} face={{ text: "Add Skill…" }} items={addItems} />
        }
      >
        {rows.length === 0 ? (
          <li className="flex flex-col items-center gap-1 px-3.5 py-7 text-center">
            <span className="font-semibold">No skills in {name} yet</span>
            <span className="text-callout text-label-secondary">
              Add a library skill and gandalf copies it into each agent&apos;s folder below.
            </span>
          </li>
        ) : (
          rows.map((row) => {
            const status = rowStatus(row, names);
            const copied = row.cells.every((cell) => cell.verdict === "ok");
            const agents = columns
              .filter((_column, at) => row.cells[at]?.verdict === "ok")
              .flatMap((column) => column.agents);
            return (
              <li
                key={row.skill}
                aria-label={row.skill}
                className="flex items-center gap-3 px-3.5 py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-semibold">{row.skill}</span>
                  {row.description === null ? null : (
                    <span className="truncate text-callout text-label-secondary">
                      {row.description}
                    </span>
                  )}
                </span>
                <AgentMarks agents={agents} />
                <span
                  className={`text-callout whitespace-nowrap ${copied ? "text-label-secondary" : "text-status-conflict"}`}
                >
                  {status}
                </span>
                <Menu
                  label={`More actions for ${row.skill}`}
                  face={{ icon: <HugeiconsIcon icon={MoreHorizontalIcon} size={16} aria-hidden /> }}
                  items={[
                    {
                      label: `Remove from ${name}`,
                      destructive: true,
                      onSelect: () => plan(setSkill(row.skill, false)),
                    },
                  ]}
                />
              </li>
            );
          })
        )}
      </SettingsGroup>
      <SettingsGroup
        title="Agents"
        label={`Agents in ${name}`}
        action={
          <Menu label={`Choose agents for ${name}`} face={{ text: "Edit…" }} items={agentItems} />
        }
      >
        {columns.length === 0 ? (
          <li className="px-3.5 py-2.5 text-callout text-label-secondary">
            No agent gets skills in {name}. Pick some with Edit….
          </li>
        ) : (
          columns.map((column) => {
            const readers = AND.format(column.agents.map(names.agent));
            return (
              <li
                key={column.root}
                aria-label={readers}
                className="flex items-center gap-3 px-3.5 py-2.5"
              >
                <AgentMarks agents={column.agents} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{readers}</span>
                  <span className="truncate font-mono text-callout text-label-secondary">
                    {column.dir}
                  </span>
                </span>
                <span className="text-callout whitespace-nowrap text-label-secondary">
                  {column.copies === 0
                    ? "Empty"
                    : `${column.copies} ${column.copies === 1 ? "skill" : "skills"}`}
                </span>
              </li>
            );
          })
        )}
      </SettingsGroup>
      <SettingsGroup title="Project" label={`Project ${name}`}>
        <SettingRow
          label="Folder"
          hint={
            <span className="flex flex-col gap-0.5">
              <PathText wrap path={project.path} />
              {project.readError === null ? null : (
                <span className="text-status-conflict select-text">{project.readError}</span>
              )}
            </span>
          }
        >
          <Button size="small" onClick={() => void reveal()}>
            Show in Finder
          </Button>
        </SettingRow>
        <SettingRow
          label={`Forget ${name}`}
          hint="gandalf stops managing skills here. The copies stay in the project's folders."
        >
          <Button
            size="small"
            variant="destructive"
            aria-label={`Forget ${name}`}
            onClick={() => plan({ kind: "removeProject", path: project.path })}
          >
            Forget…
          </Button>
        </SettingRow>
      </SettingsGroup>
      {revealError === null ? null : (
        <p role="alert" className="text-callout text-status-conflict select-text">
          {revealError}
        </p>
      )}
    </>
  );
}

/**
 * One project's screen, which its row in the sidebar opens. Every change plans through the sync
 * sheet, so the copies that move show before anything is written.
 */
export function ProjectPane({ snapshot, flow, names, dispatch, project }: ProjectPaneProps) {
  const model = useMemo(
    () => projectModels(snapshot).find((candidate) => candidate.project.path === project),
    [snapshot, project],
  );
  const plan = (intent: Intent) => dispatch({ kind: "plan", intent });
  return (
    <>
      <div role="status" className="sticky left-0">
        {flow.kind === "applied" ? <AppliedSummary results={flow.results} names={names} /> : null}
      </div>
      <SettingsPage>
        {model === undefined ? (
          <p className="px-1 py-6 text-center text-label-secondary">
            {projectName(project)} is no longer one of your projects.
          </p>
        ) : (
          <Project model={model} snapshot={snapshot} names={names} plan={plan} />
        )}
      </SettingsPage>
    </>
  );
}

/**
 * Asks for a folder and plans it as a project for the installed agents that read project skills.
 * Resolves to the panel's error, or null once there is nothing to report.
 */
export async function addProject(
  snapshot: Snapshot,
  dispatch: (event: FlowEvent) => void,
): Promise<AppError | null> {
  const result = await invoke(() => window.gandalf.chooseFolder());
  if (!result.ok) return result.error;
  if (result.value === null) return null;
  // The folder panel returns an absolute path; main parses the intent again before planning.
  const path = result.value as AbsPath;
  dispatch({
    kind: "plan",
    intent: { kind: "configureProject", path, agents: defaultAgents(snapshot) },
  });
  return null;
}

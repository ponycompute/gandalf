import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import type { AbsPath, Intent, SkillName, Snapshot } from "@gandalf/skills";
import type { AppError } from "../../shared/ipc";
import { AppliedSummary } from "../changes/AppliedSummary";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { Button } from "../design/Button";
import { Checkbox } from "../design/Checkbox";
import { Menu } from "../design/Menu";
import { PathText } from "../design/PathText";
import { invoke } from "../invoke";
import { StatusGlyph } from "../library/StatusGlyph";
import { SettingsGroup, SettingsPage } from "../settings/SettingsGroup";
import { projectName, verdictWord, type Names } from "../vocabulary";
import {
  defaultAgents,
  projectAgents,
  projectModels,
  toggleAgent,
  type ProjectModel,
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

/**
 * One project: which agents get skills in it, then each skill with a mark per skills folder. The
 * folders are the agents' own project folders, such as .claude/skills, so they travel with the repo.
 */
function Project({ model, snapshot, names, plan }: ProjectProps) {
  const { project, columns, rows, addable } = model;
  const name = projectName(project.path);
  // Every row is its own grid, so each column has a fixed width to line up under its header.
  const grid = { gridTemplateColumns: `minmax(0,1fr) repeat(${columns.length}, 2.5rem) 5rem` };
  const setSkill = (skill: SkillName, enabled: boolean): Intent => ({
    kind: "setProjectSkills",
    project: project.path,
    skills: [skill],
    enabled,
  });
  return (
    <SettingsGroup title={name} label={`Project ${name}`}>
      <li className="flex items-center gap-3 px-3.5 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <PathText wrap path={project.path} />
          {project.readError === null ? null : (
            <span className="text-callout text-status-conflict select-text">
              {project.readError}
            </span>
          )}
        </span>
        <Menu
          label={`Add a skill to ${name}`}
          icon={<HugeiconsIcon icon={Add01Icon} size={16} aria-hidden />}
          items={
            addable.length === 0
              ? [
                  {
                    label: "Every library skill is in this project",
                    onSelect: () => {},
                    disabled: true,
                  },
                ]
              : addable.map((skill) => ({
                  label: skill,
                  onSelect: () => plan(setSkill(skill, true)),
                }))
          }
        />
        <Button
          size="small"
          variant="destructive"
          aria-label={`Forget ${name}`}
          onClick={() => plan({ kind: "removeProject", path: project.path })}
        >
          Forget
        </Button>
      </li>
      <li
        aria-label={`Agents in ${name}`}
        className="flex flex-wrap gap-x-4 gap-y-1.5 px-3.5 py-2.5"
      >
        {projectAgents(snapshot).map((agent) => (
          <label
            key={agent.id}
            title={agent.projectDir ?? undefined}
            className="flex items-center gap-1.5"
          >
            <Checkbox
              checked={project.agents.includes(agent.id)}
              onChange={(event) =>
                plan(toggleAgent(snapshot, project, agent.id, event.target.checked))
              }
            />
            <AgentLogo agent={agent.id} size={16} />
            <span className={agent.installed ? undefined : "text-label-secondary"}>
              {agent.displayName}
            </span>
          </label>
        ))}
      </li>
      {rows.length === 0 ? (
        <li className="px-3.5 py-2.5 text-callout text-label-secondary">
          No skills yet. Add one with the + button.
        </li>
      ) : (
        <>
          <li aria-hidden className="grid items-center gap-x-2 px-3.5 py-1.5" style={grid}>
            <span className="text-subheadline text-label-secondary">Skill</span>
            {columns.map((column) => (
              <span
                key={column.root}
                title={AND.format(column.agents.map(names.agent))}
                className="flex justify-center -space-x-1"
              >
                {column.agents.map((agent) => (
                  <AgentLogo key={agent} agent={agent} size={16} />
                ))}
              </span>
            ))}
            <span />
          </li>
          {rows.map((row) => (
            <li
              key={row.skill}
              aria-label={row.skill}
              className="grid items-center gap-x-2 px-3.5 py-2"
              style={grid}
            >
              <span className="truncate font-semibold">{row.skill}</span>
              {row.cells.map((cell) => (
                <span key={cell.root} className="flex justify-center">
                  <StatusGlyph
                    verdict={cell.verdict}
                    mode="copy"
                    word={`${verdictWord(cell.verdict, "copy")} in ${names.folder(cell.root)}`}
                  />
                </span>
              ))}
              <Button
                size="small"
                variant="borderless"
                className="justify-self-end"
                aria-label={`Remove ${row.skill} from ${name}`}
                onClick={() => plan(setSkill(row.skill, false))}
              >
                Remove
              </Button>
            </li>
          ))}
        </>
      )}
    </SettingsGroup>
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
        <p className="px-1 text-callout text-label-secondary">
          A project gets copies of library skills in its agents' own folders, such as
          .claude/skills, so they go along with the code.
        </p>
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

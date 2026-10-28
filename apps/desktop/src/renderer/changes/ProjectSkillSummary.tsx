import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import type { AbsPath, AgentId, Plan, SkillName, Snapshot, Step } from "@gandalf/skills";
import { AgentMarks } from "../design/AgentMarks";
import { PathText } from "../design/PathText";
import {
  NOT_DONE,
  STEP_WORD,
  VERDICT_WORD,
  libraryPath,
  notDoneReason,
  projectName,
  stepPath,
  stepSentence,
  tilde,
  type Names,
} from "../vocabulary";
import { GROUP_OF, type Group } from "./ChangeList";

/** One agent folder in the project that gets the skills. */
interface ProjectFolder {
  readonly root: AbsPath;
  /** The folder inside the project, such as .claude/skills. */
  readonly dir: string;
  readonly agents: readonly AgentId[];
}

export interface ProjectSkillFacts {
  readonly project: AbsPath;
  readonly skills: readonly { readonly name: SkillName; readonly description: string | null }[];
  /** The folders that get a copy, in the order the plan writes them. */
  readonly folders: readonly ProjectFolder[];
  /** The folders the plan makes before it copies, inside the project. */
  readonly creates: readonly string[];
  /** The rows the change list shows. */
  readonly changes: number;
}

/**
 * What a plan that adds library skills to a project does, in the words of its summary. Null for
 * any other plan, taking skills out included.
 */
export function projectSkillFacts(plan: Plan, snapshot: Snapshot): ProjectSkillFacts | null {
  const { intent } = plan;
  if (intent.kind !== "setProjectSkills" || !intent.enabled) return null;
  const inside = (path: AbsPath) => path.slice(intent.project.length + 1);
  const roots = [
    ...new Set(plan.steps.flatMap((step) => (step.kind === "projectCopy" ? [step.slot.root] : []))),
  ];
  return {
    project: intent.project,
    skills: intent.skills.map((name) => ({
      name,
      description: snapshot.skills.find((view) => view.name === name)?.description ?? null,
    })),
    folders: roots.map((root) => ({
      root,
      dir: inside(root),
      agents: snapshot.roots.find((view) => view.path === root)?.targets ?? [],
    })),
    creates: plan.steps.flatMap((step) => (step.kind === "ensureDir" ? [inside(step.dir)] : [])),
    changes: plan.steps.length + plan.notDone.length,
  };
}

/** The sheet's title: the skill by name, or how many, and the project they go to. */
export function projectSkillTitle(facts: ProjectSkillFacts): string {
  const [only] = facts.skills;
  const what =
    facts.skills.length === 1 && only !== undefined ? only.name : `${facts.skills.length} skills`;
  return `Add ${what} to ${projectName(facts.project)}?`;
}

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const OR = new Intl.ListFormat("en", { style: "long", type: "disjunction" });

/** "the skills folder", "both skills folders", "3 skills folders". */
function foldersWord(count: number): string {
  if (count === 1) return "the skills folder";
  return count === 2 ? "both skills folders" : `${count} skills folders`;
}

/** Each kind of change marked as a diff does, in the order the list reads. */
const MARK = {
  remove: { glyph: "−", ink: "text-status-conflict", order: 0 },
  add: { glyph: "+", ink: "text-status-linked", order: 1 },
  update: { glyph: "~", ink: "text-status-change", order: 2 },
} as const satisfies Record<Group, { glyph: string; ink: string; order: number }>;

/** What a step does here, shorter than the change list's word where adding a skill says more. */
function diskWord(step: Step): string {
  switch (step.kind) {
    case "ensureDir":
      return "New folder";
    case "commitState":
      return "Records the copies";
    default:
      return STEP_WORD[step.kind].app;
  }
}

interface DiskRow {
  readonly glyph: string;
  readonly ink: string;
  readonly path: string | null;
  readonly word: string;
  /** The change in a sentence, for a screen reader. */
  readonly sentence: string;
}

/** The plan's changes one line each, removals first and the state file last. */
function diskRows(plan: Plan, names: Names): readonly DiskRow[] {
  const steps = [...plan.steps]
    .sort((a, b) => MARK[GROUP_OF[a.kind]].order - MARK[GROUP_OF[b.kind]].order)
    .map((step) => ({
      ...MARK[GROUP_OF[step.kind]],
      path: stepPath(step, names).path,
      word: diskWord(step),
      sentence: stepSentence(step, names),
    }));
  const notDone = plan.notDone.map((item) => ({
    glyph: "!",
    ink: "text-status-conflict",
    path: "entry" in item ? item.entry.path : null,
    word: VERDICT_WORD[NOT_DONE[item.kind].verdict],
    sentence: notDoneReason(item, names),
  }));
  return [...steps, ...notDone];
}

interface ProjectSkillSummaryProps {
  readonly plan: Plan;
  readonly facts: ProjectSkillFacts;
  readonly names: Names;
}

/**
 * A plan that adds library skills to a project, said as what it means: the skills, the agents'
 * folders they are copied into, and the folders it makes first. The steps on disk stay one click
 * away, and open by themselves when the plan leaves something undone.
 */
export function ProjectSkillSummary({ plan, facts, names }: ProjectSkillSummaryProps) {
  const [open, setOpen] = useState(plan.notDone.length > 0);
  const changes = useId();
  const { skills, folders, creates } = facts;
  const name = projectName(facts.project);
  const it = skills.length === 1 ? "it" : "them";
  const agents = [...new Set(folders.flatMap((folder) => folder.agents))];

  return (
    <div className="flex flex-col gap-3 px-5">
      <ul
        aria-label={`Skills to add to ${name}`}
        className="overflow-hidden rounded-[10px] bg-row-alt [&>li+li]:border-t [&>li+li]:border-separator"
      >
        {skills.map((skill) => (
          <li key={skill.name} className="flex min-w-0 flex-col gap-0.5 p-3">
            <span className="truncate text-headline">{skill.name}</span>
            {skill.description === null ? null : (
              <span className="text-callout text-label-secondary select-text">
                {skill.description}
              </span>
            )}
            <span className="text-callout [overflow-wrap:anywhere] text-label-secondary select-text">
              In your library · {tilde(libraryPath(names, skill.name), names)}
            </span>
          </li>
        ))}
      </ul>
      <ul className="flex flex-col pb-2 [&>li]:border-t [&>li]:border-separator">
        <li className="flex items-center gap-3 py-2.5">
          <span className="flex min-w-0 flex-1 flex-col">
            <span>
              {folders.length === 0
                ? `No agent gets ${it} in ${name} yet`
                : `Copies ${it} into ${AND.format(agents.map(names.agent))}`}
            </span>
            {folders.length === 0 ? (
              <span className="text-callout text-label-secondary">
                Choose agents for {name} and gandalf copies {it} into their folders.
              </span>
            ) : (
              <span className="font-mono text-path [overflow-wrap:anywhere] text-label-secondary select-text">
                {AND.format(folders.map((folder) => folder.dir))} in {tilde(facts.project, names)}
              </span>
            )}
          </span>
          <AgentMarks agents={agents} />
        </li>
        {creates.length === 0 ? null : (
          <li className="flex items-center gap-3 py-2.5">
            <span className="flex min-w-0 flex-col">
              <span>Makes {foldersWord(creates.length)} first</span>
              <span className="text-callout text-label-secondary">
                {name} has no {OR.format(creates)} yet.
              </span>
            </span>
          </li>
        )}
        <li>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={changes}
            onClick={() => setOpen(!open)}
            className="flex w-full items-center gap-1.5 pt-2.5 pb-1 text-callout text-label-secondary"
          >
            <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} aria-hidden />
            {open ? "Hide" : "Show"} the {facts.changes}{" "}
            {facts.changes === 1 ? "change" : "changes"} on disk
          </button>
          <ul
            id={changes}
            hidden={!open}
            aria-label="Changes on disk"
            className="mt-1.5 flex flex-col rounded-lg bg-row-alt px-2.5 py-1.5 text-callout"
          >
            {diskRows(plan, names).map((row, at) => (
              <li key={at} className="flex items-center gap-2 py-[3px]">
                <span aria-hidden="true" className={`font-mono text-path ${row.ink}`}>
                  {row.glyph}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  {row.path === null ? null : <PathText path={row.path} />}
                </span>
                <span className="whitespace-nowrap text-label-secondary">{row.word}</span>
                <span className="sr-only">{row.sentence}</span>
              </li>
            ))}
          </ul>
        </li>
      </ul>
    </div>
  );
}

import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import type { AgentId, Intent, Plan, SkillName, SkillSource } from "@gandalf/skills";
import { OwnerAvatar } from "../design/OwnerAvatar";
import { gitHubRepository, libraryPath, tilde, type Names } from "../vocabulary";
import { ChangeList } from "./ChangeList";

/** One skill an install plan puts in the library. */
export interface InstalledSkill {
  readonly name: SkillName;
  readonly source: SkillSource;
  /** False when the library holds it already, as for a re-install. */
  readonly adds: boolean;
}

export interface InstallFacts {
  readonly skills: readonly InstalledSkill[];
  /** The agents it is turned on for, in the order the app lists them. */
  readonly agents: readonly AgentId[];
  /** True when some agent gets a copy rather than a link. */
  readonly copies: boolean;
  /** The rows the change list shows. */
  readonly changes: number;
}

/** What an install plan does, in the words of its summary. Null for any other plan. */
export function installFacts(plan: Plan, installed: readonly AgentId[]): InstallFacts | null {
  const { intent } = plan;
  if (intent.kind !== "install") return null;
  const added = new Set(
    plan.steps.flatMap((step) => (step.kind === "libraryAdd" ? [step.skill] : [])),
  );
  const skills = plan.steps.flatMap((step) =>
    step.kind === "commitState"
      ? step.changes.flatMap((change) =>
          change.kind === "track"
            ? [{ name: change.skill, source: change.source, adds: added.has(change.skill) }]
            : [],
        )
      : [],
  );
  return {
    skills,
    agents: agentsOf(intent, installed),
    copies: plan.steps.some((step) => step.kind === "copy"),
    changes: plan.steps.length + plan.notDone.length,
  };
}

function agentsOf(intent: Extract<Intent, { kind: "install" }>, installed: readonly AgentId[]) {
  return intent.agents === "all"
    ? installed
    : installed.filter((agent) => intent.agents.includes(agent));
}

/** The sheet's title for an install plan: the skill by name, or how many. */
export function installTitle(facts: InstallFacts): string {
  const [only] = facts.skills;
  return facts.skills.length === 1 && only !== undefined
    ? `Install ${only.name}?`
    : `Install ${facts.skills.length} skills?`;
}

function sourceLine(source: SkillSource, names: Names): string {
  switch (source.kind) {
    case "git": {
      const where = gitHubRepository(source.url) ?? tilde(source.url, names);
      const parts = [where, source.subpath, source.commit.slice(0, 7)];
      return parts.filter((part) => part !== null).join(" · ");
    }
    case "local":
      return source.path === null ? "A folder on this Mac" : tilde(source.path, names);
    case "adopted":
      return "Adopted from an agent";
  }
}

function SkillTile({ skill, names }: { readonly skill: InstalledSkill; readonly names: Names }) {
  const owner =
    skill.source.kind === "git"
      ? (gitHubRepository(skill.source.url)?.split("/")[0] ?? null)
      : null;
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <OwnerAvatar owner={owner} fallback={skill.name} size="size-9" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold">{skill.name}</span>
        <span className="text-callout [overflow-wrap:anywhere] text-label-secondary select-text">
          {sourceLine(skill.source, names)}
        </span>
      </span>
    </li>
  );
}

/** "Claude Code", "Claude Code and Cursor", "Claude Code, Codex and Cursor". */
function listed(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

interface InstallSummaryProps {
  readonly plan: Plan;
  readonly facts: InstallFacts;
  readonly names: Names;
}

/**
 * An install plan said as what it means: the skills it brings, that the library gets them, and the
 * agents that link to them. The steps on disk stay one click away, and open by themselves when the
 * plan leaves something undone.
 */
export function InstallSummary({ plan, facts, names }: InstallSummaryProps) {
  const [open, setOpen] = useState(plan.notDone.length > 0);
  const changes = useId();
  const { skills, agents } = facts;
  const one = skills.length === 1;
  const it = one ? "it" : "them";
  const [only] = skills;
  const adds = skills.filter((skill) => skill.adds);
  const agentNames = agents.map((agent) => names.agent(agent));

  return (
    <div className="flex flex-col gap-3 px-5">
      <ul
        aria-label="Skills to install"
        className="overflow-hidden rounded-[10px] bg-window [&>li+li]:border-t [&>li+li]:border-separator"
      >
        {skills.map((skill) => (
          <SkillTile key={skill.name} skill={skill} names={names} />
        ))}
      </ul>
      <ul className="flex flex-col [&>li]:border-t [&>li]:border-separator">
        <li className="flex items-center gap-3 py-2.5">
          <span className="flex min-w-0 flex-col">
            <span>
              {adds.length === 0
                ? `Your library has ${it} already`
                : adds.length === skills.length
                  ? `Adds ${it} to your library`
                  : `Adds ${adds.length} of ${it} to your library`}
            </span>
            <span className="font-mono text-path [overflow-wrap:anywhere] text-label-secondary select-text">
              {one && only !== undefined
                ? tilde(libraryPath(names, only.name), names)
                : `${tilde(names.libraryDir, names)}/`}
            </span>
          </span>
        </li>
        <li className="flex items-center gap-3 py-2.5">
          <span className="flex min-w-0 flex-col">
            <span>
              {agents.length === 0
                ? "No agent gets it yet"
                : `${facts.copies ? "Copies" : "Links"} ${it} into ${listed(agentNames)}`}
            </span>
            <span className="text-callout text-label-secondary">
              {agents.length === 0
                ? "Agents you install later get it."
                : facts.copies
                  ? "An agent that cannot follow a link gets its own copy, which gandalf keeps in step."
                  : `Each agent reads the library copy, so updates reach ${agents.length === 1 ? "it" : agents.length === 2 ? "both" : `all ${agents.length}`}.`}
            </span>
          </span>
        </li>
        <li>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={changes}
            onClick={() => setOpen(!open)}
            className="flex w-full items-center gap-1.5 py-2.5 text-callout text-label-secondary"
          >
            <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} aria-hidden />
            {open ? "Hide" : "Show"} the {facts.changes}{" "}
            {facts.changes === 1 ? "change" : "changes"} on disk
          </button>
          <div id={changes} hidden={!open} className="-mx-5">
            <ChangeList plan={plan} names={names} />
          </div>
        </li>
      </ul>
    </div>
  );
}

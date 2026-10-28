import type { AgentId, Plan, SkillName, SkillSource, Snapshot } from "@gandalf/skills";
import { AgentMarks } from "../design/AgentMarks";
import { canUpdate } from "../library/updates";
import { gitHubRepository, tilde, type Names } from "../vocabulary";
import { DiskChanges } from "./DiskChanges";

/** One skill an update plan moves to a new version. */
export interface UpdatedSkill {
  readonly name: SkillName;
  /** The source the library has it from now, null when the snapshot no longer has it. */
  readonly before: SkillSource | null;
  readonly after: SkillSource;
}

export interface UpdateFacts {
  readonly skills: readonly UpdatedSkill[];
  /** Skills with a newer version that stay as they are, since the user edited their library copy. */
  readonly kept: readonly SkillName[];
  /** The agents that have any of the skills on, in the order the snapshot lists them. */
  readonly agents: readonly AgentId[];
  /** True when some agent gets a copy rather than a link. */
  readonly copies: boolean;
  /** True for Update All, false for the skills it names. */
  readonly all: boolean;
  /** The skills the plan looked at: every skill from git or a folder, or the ones it names. */
  readonly checked: readonly SkillName[];
}

/** What an update plan does, in the words of its summary. Null for any other plan. */
export function updateFacts(plan: Plan, snapshot: Snapshot): UpdateFacts | null {
  const { intent } = plan;
  if (intent.kind !== "update") return null;
  const view = (name: SkillName) => snapshot.skills.find((candidate) => candidate.name === name);
  const skills = plan.steps.flatMap((step) =>
    step.kind === "commitState"
      ? step.changes.flatMap((change) =>
          change.kind === "setSource"
            ? [{ name: change.skill, before: view(change.skill)?.source ?? null, after: change.source }]
            : [],
        )
      : [],
  );
  const updated = new Set(skills.map((skill) => skill.name));
  const agents = snapshot.agents
    .map((agent) => agent.id)
    .filter((agent) =>
      snapshot.skills.some(
        (skill) =>
          updated.has(skill.name) &&
          skill.cells.some((cell) => cell.agent === agent && cell.enabled),
      ),
    );
  return {
    skills,
    kept: plan.notDone.flatMap((item) => (item.kind === "locallyModified" ? [item.skill] : [])),
    agents,
    copies: plan.steps.some((step) => step.kind === "copy" || step.kind === "projectCopy"),
    all: intent.skills === "all",
    checked:
      intent.skills === "all"
        ? snapshot.skills.filter(canUpdate).map((skill) => skill.name)
        : intent.skills,
  };
}

/** True when the plan found nothing newer anywhere it looked. */
export function upToDate(facts: UpdateFacts): boolean {
  return facts.skills.length === 0 && facts.kept.length === 0;
}

/** The sheet's title: a question while there is something to update, an answer when there is not. */
export function updateTitle(facts: UpdateFacts): string {
  const [only] = facts.skills;
  const [one] = facts.checked;
  if (upToDate(facts)) {
    return facts.all || one === undefined ? "Every skill is up to date" : `${one} is up to date`;
  }
  if (only === undefined) return "Nothing to update";
  return facts.skills.length === 1 ? `Update ${only.name}?` : `Update ${facts.skills.length} skills?`;
}

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** Where a skill comes from, short: owner/repo for GitHub, the URL or folder otherwise. */
function origin(source: SkillSource, names: Names): string {
  if (source.kind === "git") return gitHubRepository(source.url) ?? tilde(source.url, names);
  return source.kind === "local" && source.path !== null ? tilde(source.path, names) : "";
}

/** What changed: the commit it moves from and to, or that its folder changed. */
function change({ before, after }: UpdatedSkill, names: Names): string {
  if (after.kind === "git") {
    const from = before?.kind === "git" ? `${before.commit.slice(0, 7)} → ` : "";
    return `${origin(after, names)} · ${from}${after.commit.slice(0, 7)}`;
  }
  return `${origin(after, names)} · the folder changed`;
}

interface UpdateSummaryProps {
  readonly plan: Plan;
  readonly facts: UpdateFacts;
  readonly names: Names;
}

/**
 * An update plan, said as what it means: each skill with what changed at its source, that the
 * library copies take the new versions, and which edited copies stay as they are. With nothing
 * newer, it says what gandalf checked.
 */
export function UpdateSummary({ plan, facts, names }: UpdateSummaryProps) {
  const { skills, kept, agents } = facts;
  if (upToDate(facts)) {
    const [one] = facts.checked;
    const count = facts.checked.length;
    return (
      <p className="px-5 pb-2 text-callout text-label-secondary">
        {!facts.all && count === 1 && one !== undefined
          ? `gandalf checked ${one} at its source. It has no newer version.`
          : `gandalf checked ${count} ${count === 1 ? "skill" : "skills"} from git and folders. None has a newer version.`}
      </p>
    );
  }
  const many = skills.length > 1;
  return (
    <div className="flex flex-col gap-3 px-5">
      {skills.length === 0 ? null : (
        <ul
          aria-label="Skills to update"
          className="flex flex-col gap-2.5 rounded-[10px] bg-row-alt p-3"
        >
          {skills.map((skill) => (
            <li key={skill.name} className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-headline">{skill.name}</span>
              <span className="text-callout [overflow-wrap:anywhere] text-label-secondary select-text">
                {change(skill, names)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <ul className="flex flex-col pb-2 [&>li]:border-t [&>li]:border-separator">
        {skills.length === 0 ? null : (
          <li className="flex items-center gap-3 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span>
                {many
                  ? "Replaces each library copy with the new version"
                  : "Replaces the library copy with the new version"}
              </span>
              <span className="text-callout text-label-secondary">
                {agents.length === 0
                  ? `No agent has ${many ? "them" : "it"} turned on.`
                  : facts.copies
                    ? `gandalf copies the new ${many ? "versions" : "version"} into ${AND.format(agents.map(names.agent))}`
                    : `Your agents read the new ${many ? "versions" : "version"} through their links`}
              </span>
            </span>
            <AgentMarks agents={agents} />
          </li>
        )}
        {kept.map((name) => (
          <li key={name} className="flex flex-col py-2.5">
            <span>Leaves {name} as you edited it</span>
            <span className="text-callout text-label-secondary">
              Its library copy changed after gandalf took it, so it keeps yours.
            </span>
          </li>
        ))}
        {plan.steps.length === 0 ? null : (
          <DiskChanges
            plan={plan}
            names={names}
            recorded="Records the new versions"
            open={plan.notDone.some((item) => item.kind !== "locallyModified")}
          />
        )}
      </ul>
    </div>
  );
}

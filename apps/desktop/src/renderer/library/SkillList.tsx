import { useState, type FocusEvent, type KeyboardEvent } from "react";
import type { AgentId, SkillName, SkillView, Snapshot } from "@gandalf/skills";
import { Alert02Icon, ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AgentLogo } from "../design/AgentLogo";
import type { PlacedSkill } from "../manage/model";
import type { Names } from "../vocabulary";
import { skillsIn } from "./agentFilter";
import { modeOf, type Modes } from "./modes";
import { pillOf, problemsOf, type Pill } from "./problems";

interface SkillListProps {
  readonly snapshot: Snapshot;
  readonly names: Names;
  readonly windowFocused: boolean;
  /** The row Skill detail shows, selected by clicking the row or moving key focus onto it. */
  readonly selected: SkillName | null;
  readonly onSelect: (skill: SkillName | null) => void;
  /** The agent the list is filtered to, whose skills it shows alone, or null for every skill. */
  readonly agent: AgentId | null;
  readonly modes: Modes;
  /** The skills with a newer version, whose rows offer it. */
  readonly updates: ReadonlySet<SkillName>;
  /** Plans the update of one skill, from its row's New version badge. */
  readonly onUpdate: (skill: SkillName) => void;
  /** Skills whose copies differ, listed among the library's until the user keeps one version. */
  readonly waiting: readonly PlacedSkill[];
}

/** How many marks a row shows before it sums up the rest as +N. */
const STACK = 4;

function AgentStack({ agents }: { readonly agents: readonly AgentId[] }) {
  const on = agents;
  if (on.length === 0) {
    return <span className="text-callout text-label-secondary">Not in any agent</span>;
  }
  const shown = on.slice(0, STACK);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="flex items-center">
        {shown.map((agent) => (
          <span
            key={agent}
            className="-ml-1.5 grid size-6 place-items-center rounded-full border border-separator bg-content text-label first:ml-0"
          >
            <AgentLogo agent={agent} size={14} />
          </span>
        ))}
        {on.length > shown.length ? (
          <span className="ml-1 text-subheadline text-label-secondary group-data-[selection=active]:text-on-accent">
            +{on.length - shown.length}
          </span>
        ) : null}
      </span>
      {/* One width for "1 agent" and "12 agents", so the marks line up down the list. */}
      <span className="w-[9ch] text-callout whitespace-nowrap text-label-secondary tabular-nums group-data-[selection=active]:text-on-accent">
        {on.length} {on.length === 1 ? "agent" : "agents"}
      </span>
    </span>
  );
}

const MODE_WORD = { link: "Linked", copy: "Copy" } as const;

/** How the agent the list is filtered to has the skill; a problem says itself on the pill. */
function AgentHas({ word }: { readonly word: string }) {
  return (
    <span className="text-callout whitespace-nowrap text-label-secondary group-data-[selection=active]:text-on-accent">
      {word}
    </span>
  );
}

const PILL_INK = {
  sync: "bg-change-tint text-status-change",
  review: "bg-conflict-tint text-status-conflict",
} as const;

function ProblemPill({ pill }: { readonly pill: Pill }) {
  return (
    <span
      className={`flex items-center gap-1 rounded-full px-2 text-subheadline leading-5 whitespace-nowrap ${PILL_INK[pill.tone]}`}
    >
      <HugeiconsIcon icon={Alert02Icon} size={12} aria-hidden />
      {pill.text}
    </span>
  );
}

/**
 * Says a skill has a newer version, and updates it when clicked; hovered, it says Update. The click
 * does not select the row. A keyboard reaches the same update from the detail's menu.
 */
function UpdateBadge({
  skill,
  onUpdate,
}: {
  readonly skill: SkillName;
  readonly onUpdate: (skill: SkillName) => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`Update ${skill}`}
      onClick={(event) => {
        event.stopPropagation();
        onUpdate(skill);
      }}
      className="group/update flex items-center gap-1 rounded-full bg-accent/10 px-2 text-subheadline leading-5 whitespace-nowrap text-accent hover:bg-accent/20 group-data-[selection=active]:bg-on-accent/20 group-data-[selection=active]:text-on-accent"
    >
      <HugeiconsIcon icon={ArrowUp02Icon} size={12} aria-hidden />
      <span className="group-hover/update:hidden">New version</span>
      <span className="hidden group-hover/update:inline">Update</span>
    </button>
  );
}

/** Options focused by focusSkill, whose focus must not select them again. */
const quiet = new WeakSet<EventTarget>();

/**
 * Puts key focus on `skill`'s row without selecting it: where focus goes back when Skill detail
 * closes, or after a remove, to the row that took its place.
 */
export function focusSkill(skill: SkillName): boolean {
  const option = document.querySelector<HTMLElement>(
    `[role="listbox"][aria-label="Skills"] [data-skill="${CSS.escape(skill)}"]`,
  );
  if (option === null) return false;
  quiet.add(option);
  option.focus();
  quiet.delete(option);
  return true;
}

function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  const at = options.findIndex((option) => option === document.activeElement);
  const to = {
    ArrowDown: Math.min(at + 1, options.length - 1),
    ArrowUp: Math.max(at - 1, 0),
    Home: 0,
    End: options.length - 1,
  }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  options[to]?.focus();
}

/** One row: a library skill, or a skill whose copies differ that waits for a version to be kept. */
type Row =
  | { readonly kind: "skill"; readonly name: SkillName; readonly skill: SkillView }
  | { readonly kind: "waiting"; readonly name: SkillName; readonly skill: PlacedSkill };

/** The library's skills and the waiting ones in one list by name, narrowed to `agent` when set. */
function rowsOf(
  snapshot: Snapshot,
  waiting: readonly PlacedSkill[],
  agent: AgentId | null,
): readonly Row[] {
  const skills = agent === null ? snapshot.skills : skillsIn(snapshot, agent);
  return [
    ...skills.map((skill): Row => ({ kind: "skill", name: skill.name, skill })),
    ...waiting
      .filter((skill) => agent === null || readersOf(skill).includes(agent))
      .map((skill): Row => ({ kind: "waiting", name: skill.name, skill })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every agent that reads a copy of a waiting skill, in the order the copies are listed. */
export function readersOf(skill: PlacedSkill): readonly AgentId[] {
  return [...new Set(skill.copies.flatMap((copy) => copy.readers))];
}

const TWO_VERSIONS: Pill = { text: "Two versions", tone: "review" };

/**
 * The library, one row per skill: what it is, which agents have it, and a warning when something
 * needs fixing. Turning a skill on or off for an agent happens in its detail, beside the row. A
 * skill whose copies differ is listed too, with Two versions, until the user keeps one.
 */
export function SkillList({
  snapshot,
  names,
  windowFocused,
  selected,
  onSelect,
  agent,
  modes,
  updates,
  onUpdate,
  waiting,
}: SkillListProps) {
  const [focusInside, setFocusInside] = useState(false);
  const [lastFocused, setLastFocused] = useState<SkillName | null>(null);
  const rows = rowsOf(snapshot, waiting, agent);
  const tabStop = rows.some((row) => row.name === (selected ?? lastFocused))
    ? (selected ?? lastFocused)
    : (rows[0]?.name ?? null);
  return (
    <div
      role="listbox"
      aria-label="Skills"
      onKeyDown={(event) => {
        if (event.key === "Escape" && selected !== null) {
          event.preventDefault();
          onSelect(null);
        } else moveFocus(event);
      }}
      onFocus={() => setFocusInside(true)}
      onBlur={(event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false);
      }}
      className="flex flex-col px-3 pb-3"
    >
      {rows.map((row) => {
        const { name } = row;
        const selection =
          name !== selected ? "none" : windowFocused && focusInside ? "active" : "inactive";
        const fill = {
          none: "[--gd-fill:var(--color-content)] hover:[--gd-fill:var(--color-row-alt)]",
          active: "[--gd-fill:var(--color-accent-fill)] text-on-accent",
          inactive: "[--gd-fill:var(--color-selection-inactive)]",
        }[selection];
        // Filtered to an agent, a row warns about that agent and the library folder alone.
        const pill =
          row.kind === "waiting"
            ? TWO_VERSIONS
            : pillOf(
                problemsOf(row.skill).filter(
                  (problem) => agent === null || problem.agent === null || problem.agent === agent,
                ),
                names,
              );
        const mode =
          agent === null || row.kind === "waiting" ? undefined : modeOf(modes, name, agent);
        const description = row.kind === "skill" ? row.skill.description : null;
        return (
          <div
            key={name}
            role="option"
            data-skill={name}
            aria-selected={name === selected}
            data-selection={selection}
            tabIndex={name === tabStop ? 0 : -1}
            // Keyboard focus selects at once; a mouse selects on click.
            onFocus={(event) => {
              setLastFocused(name);
              if (quiet.has(event.currentTarget)) return;
              if (event.currentTarget.matches(":focus-visible")) onSelect(name);
            }}
            onClick={() => onSelect(name)}
            className={`group flex min-h-12 items-center gap-3 rounded-md bg-(--gd-fill) px-3 py-2 focus-visible:-outline-offset-2 ${fill}`}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">{name}</span>
              {description === null ? null : (
                <span className="truncate text-callout text-label-secondary group-data-[selection=active]:text-on-accent group-data-[selection=inactive]:text-label">
                  {description}
                </span>
              )}
            </span>
            {updates.has(name) ? <UpdateBadge skill={name} onUpdate={onUpdate} /> : null}
            {pill === null ? null : <ProblemPill pill={pill} />}
            {agent !== null ? (
              mode === undefined ? null : (
                <AgentHas word={MODE_WORD[mode]} />
              )
            ) : row.kind === "waiting" ? (
              <AgentStack agents={readersOf(row.skill)} />
            ) : (
              <AgentStack
                agents={row.skill.cells.filter((cell) => cell.enabled).map((cell) => cell.agent)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

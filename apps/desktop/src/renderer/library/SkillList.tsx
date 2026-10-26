import { useState, type FocusEvent, type KeyboardEvent } from "react";
import type { AgentView, SkillName, SkillView, Snapshot } from "@gandalf/skills";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AgentLogo } from "../design/AgentLogo";
import type { Names } from "../vocabulary";
import { pillOf, problemsOf, type Pill } from "./problems";

interface SkillListProps {
  readonly snapshot: Snapshot;
  readonly names: Names;
  readonly windowFocused: boolean;
  /** The row Skill detail shows, selected by clicking the row or moving key focus onto it. */
  readonly selected: SkillName | null;
  readonly onSelect: (skill: SkillName | null) => void;
}

/** The agents a skill can be turned on for, and the toolbar counts. */
export function libraryAgents(snapshot: Snapshot): readonly AgentView[] {
  return snapshot.agents.filter((agent) => agent.installed && agent.readError === null);
}

/** How many marks a row shows before it sums up the rest as +N. */
const STACK = 4;

function AgentStack({ skill }: { readonly skill: SkillView }) {
  const on = skill.cells.filter((cell) => cell.enabled);
  if (on.length === 0) {
    return <span className="text-callout text-label-secondary">Not in any agent</span>;
  }
  const shown = on.slice(0, STACK);
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="flex items-center">
        {shown.map((cell) => (
          <span
            key={cell.agent}
            className="-ml-1.5 grid size-6 place-items-center rounded-full border border-separator bg-content text-label first:ml-0"
          >
            <AgentLogo agent={cell.agent} size={14} />
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

/**
 * The library, one row per skill: what it is, which agents have it, and a warning when something
 * needs fixing. Turning a skill on or off for an agent happens in its detail, beside the row.
 */
export function SkillList({ snapshot, names, windowFocused, selected, onSelect }: SkillListProps) {
  const [focusInside, setFocusInside] = useState(false);
  const [lastFocused, setLastFocused] = useState<SkillName | null>(null);
  const tabStop = snapshot.skills.some((skill) => skill.name === (selected ?? lastFocused))
    ? (selected ?? lastFocused)
    : (snapshot.skills[0]?.name ?? null);
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
      {snapshot.skills.map((skill) => {
        const selection =
          skill.name !== selected ? "none" : windowFocused && focusInside ? "active" : "inactive";
        const fill = {
          none: "[--gd-fill:var(--color-content)] hover:[--gd-fill:var(--color-row-alt)]",
          active: "[--gd-fill:var(--color-accent-fill)] text-on-accent",
          inactive: "[--gd-fill:var(--color-selection-inactive)]",
        }[selection];
        const pill = pillOf(problemsOf(skill), names);
        return (
          <div
            key={skill.name}
            role="option"
            data-skill={skill.name}
            aria-selected={skill.name === selected}
            data-selection={selection}
            tabIndex={skill.name === tabStop ? 0 : -1}
            // Keyboard focus selects at once; a mouse selects on click.
            onFocus={(event) => {
              setLastFocused(skill.name);
              if (quiet.has(event.currentTarget)) return;
              if (event.currentTarget.matches(":focus-visible")) onSelect(skill.name);
            }}
            onClick={() => onSelect(skill.name)}
            className={`group flex min-h-12 items-center gap-3 rounded-md bg-(--gd-fill) px-3 py-2 focus-visible:-outline-offset-2 ${fill}`}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">{skill.name}</span>
              {skill.description === null ? null : (
                <span className="truncate text-callout text-label-secondary group-data-[selection=active]:text-on-accent group-data-[selection=inactive]:text-label">
                  {skill.description}
                </span>
              )}
            </span>
            {pill === null ? null : <ProblemPill pill={pill} />}
            <AgentStack skill={skill} />
          </div>
        );
      })}
    </div>
  );
}

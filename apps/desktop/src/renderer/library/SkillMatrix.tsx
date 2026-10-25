import { useId, useState, type FocusEvent, type KeyboardEvent } from "react";
import type { AgentId, AgentView, Mode, SkillName, Snapshot } from "@gandalf/skills";
import { Checkbox } from "../design/Checkbox";
import { StatusGlyph } from "./StatusGlyph";

export interface Toggle {
  readonly skill: SkillName;
  readonly agent: AgentId;
  readonly enabled: boolean;
}

interface SkillMatrixProps {
  readonly snapshot: Snapshot;
  readonly windowFocused: boolean;
  readonly onToggle: (toggle: Toggle) => void;
}

/** The agents the matrix has a column for, and the toolbar counts. */
export function matrixAgents(snapshot: Snapshot): readonly AgentView[] {
  return snapshot.agents.filter((agent) => agent.installed && agent.readError === null);
}

/** How each ok cell is projected, read from the entry in the agent's own folder. */
function modes(snapshot: Snapshot): ReadonlyMap<string, Mode> {
  const targets = new Map(snapshot.roots.map((root) => [root.path, root.targets]));
  const found = new Map<string, Mode>();
  for (const entry of snapshot.entries) {
    if (entry.verdict !== "ok") continue;
    for (const agent of targets.get(entry.root) ?? []) {
      found.set(cellKey(entry.name, agent), entry.observed.kind === "cleanCopy" ? "copy" : "link");
    }
  }
  return found;
}

const cellKey = (skill: string, agent: AgentId) => `${agent}/${skill}`;

const MOVE: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

function moveFocus(event: KeyboardEvent<HTMLTableElement>): void {
  const move = MOVE[event.key];
  const from = event.target instanceof HTMLInputElement ? event.target.dataset : undefined;
  if (move === undefined || from?.row === undefined || from.col === undefined) return;
  const next = event.currentTarget.querySelector<HTMLInputElement>(
    `input[data-row="${Number(from.row) + move[0]}"][data-col="${Number(from.col) + move[1]}"]`,
  );
  if (next === null) return;
  event.preventDefault();
  next.focus();
}

/** The row's right end, stuck to the scroller's right edge to fade toward hidden columns. */
function EdgeCell({ className = "" }: { readonly className?: string }) {
  return (
    <td aria-hidden="true" className={`gd-fade-end sticky right-0 z-[1] w-0 p-0 ${className}`} />
  );
}

export function SkillMatrix({ snapshot, windowFocused, onToggle }: SkillMatrixProps) {
  const agents = matrixAgents(snapshot);
  const modeOf = modes(snapshot);
  const [selected, setSelected] = useState<SkillName | null>(null);
  const [focusInside, setFocusInside] = useState(false);
  const ids = useId();
  const [active, setActive] = useState<readonly [number, number]>([0, 0]);
  const activeRow = Math.min(active[0], snapshot.skills.length - 1);
  const activeCol = Math.min(active[1], agents.length - 1);
  const header =
    "h-row-height border-b border-separator px-2 text-subheadline whitespace-nowrap text-label-secondary uppercase tracking-[0.04em]";
  return (
    <table
      role="grid"
      aria-label="Skills"
      onKeyDown={moveFocus}
      onFocus={() => setFocusInside(true)}
      onBlur={(event: FocusEvent<HTMLTableElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false);
      }}
      className="min-w-full border-separate border-spacing-0 bg-content tabular-nums"
    >
      <thead>
        <tr className="[--gd-fill:var(--color-content)]">
          <th
            scope="col"
            className={`${header} gd-fade-start sticky left-0 z-[1] bg-(--gd-fill) pl-5 text-left`}
          >
            Skill
          </th>
          {agents.map((agent) => (
            <th key={agent.id} scope="col" className={`${header} min-w-[76px] text-center`}>
              {agent.displayName}
            </th>
          ))}
          <EdgeCell className="border-b border-separator" />
        </tr>
      </thead>
      <tbody>
        {snapshot.skills.map((skill, row) => {
          const selection =
            skill.name !== selected ? "none" : windowFocused && focusInside ? "active" : "inactive";
          const fill = {
            none:
              row % 2 === 1
                ? "[--gd-fill:var(--color-row-alt)]"
                : "[--gd-fill:var(--color-content)]",
            active: "[--gd-fill:var(--color-accent-fill)] text-on-accent",
            inactive: "[--gd-fill:var(--color-selection-inactive)]",
          }[selection];
          return (
            <tr
              key={skill.name}
              aria-selected={selection !== "none"}
              data-selection={selection}
              onFocus={() => setSelected(skill.name)}
              onMouseDown={() => setSelected(skill.name)}
              className={`group ${fill}`}
            >
              <th
                scope="row"
                className="gd-fade-start sticky left-0 z-[1] h-row-height w-full max-w-0 min-w-[200px] bg-(--gd-fill) px-2 pl-5 text-left font-normal"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="flex-none font-semibold">{skill.name}</span>
                  <span className="min-w-0 truncate text-callout text-label-secondary group-data-[selection=active]:text-on-accent group-data-[selection=inactive]:text-label">
                    {skill.description}
                  </span>
                </span>
              </th>
              {agents.map((agent, col) => {
                const cell = skill.cells.find((candidate) => candidate.agent === agent.id);
                const wordId = `${ids}-${row}-${col}`;
                return (
                  <td key={agent.id} className="h-row-height bg-(--gd-fill) px-2 text-center">
                    {cell === undefined ? null : (
                      <span className="inline-flex items-center gap-1">
                        <Checkbox
                          checked={cell.enabled}
                          aria-label={`${skill.name} for ${agent.displayName}`}
                          aria-describedby={wordId}
                          data-row={row}
                          data-col={col}
                          tabIndex={row === activeRow && col === activeCol ? 0 : -1}
                          onFocus={() => setActive([row, col])}
                          onChange={() =>
                            onToggle({ skill: skill.name, agent: agent.id, enabled: !cell.enabled })
                          }
                          className="group-data-[selection=active]:focus-visible:outline-on-accent"
                        />
                        <StatusGlyph
                          verdict={cell.verdict}
                          mode={modeOf.get(cellKey(skill.name, agent.id))}
                          wordId={wordId}
                        />
                      </span>
                    )}
                  </td>
                );
              })}
              <EdgeCell />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

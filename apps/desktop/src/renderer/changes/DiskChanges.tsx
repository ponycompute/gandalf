import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import type { Plan, Step } from "@gandalf/skills";
import { PathText } from "../design/PathText";
import {
  NOT_DONE,
  STEP_WORD,
  VERDICT_WORD,
  notDoneReason,
  stepPath,
  stepSentence,
  type Names,
} from "../vocabulary";
import { GROUP_OF, type Group } from "./ChangeList";

/** Each kind of change marked as a diff does, in the order the list reads. */
const MARK = {
  remove: { glyph: "−", ink: "text-status-conflict", order: 0 },
  add: { glyph: "+", ink: "text-status-linked", order: 1 },
  update: { glyph: "~", ink: "text-status-change", order: 2 },
} as const satisfies Record<Group, { glyph: string; ink: string; order: number }>;

/** What a step does here, shorter than the change list's word where a summary says more. */
function diskWord(step: Step, recorded: string): string {
  switch (step.kind) {
    case "ensureDir":
      return "New folder";
    case "commitState":
      return recorded;
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
function diskRows(plan: Plan, names: Names, recorded: string): readonly DiskRow[] {
  const steps = [...plan.steps]
    .sort((a, b) => MARK[GROUP_OF[a.kind]].order - MARK[GROUP_OF[b.kind]].order)
    .map((step) => ({
      ...MARK[GROUP_OF[step.kind]],
      path: stepPath(step, names).path,
      word: diskWord(step, recorded),
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

interface DiskChangesProps {
  readonly plan: Plan;
  readonly names: Names;
  /** What the state file's row says the plan records, such as "Records the copies". */
  readonly recorded: string;
  /** Starts open, as for a plan that leaves something undone. */
  readonly open?: boolean;
}

/**
 * A summary's last row: the plan's changes on disk, one click away. Opens by itself when the plan
 * leaves something undone, unless the summary says what that is itself.
 */
export function DiskChanges({
  plan,
  names,
  recorded,
  open: initially = plan.notDone.length > 0,
}: DiskChangesProps) {
  const [open, setOpen] = useState(initially);
  const changes = useId();
  const count = plan.steps.length + plan.notDone.length;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={changes}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 pt-2.5 pb-1 text-callout text-label-secondary"
      >
        <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} aria-hidden />
        {open ? "Hide" : "Show"} the {count} {count === 1 ? "change" : "changes"} on disk
      </button>
      <ul
        id={changes}
        hidden={!open}
        aria-label="Changes on disk"
        className="mt-1.5 flex flex-col rounded-lg bg-row-alt px-2.5 py-1.5 text-callout"
      >
        {diskRows(plan, names, recorded).map((row, at) => (
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
  );
}

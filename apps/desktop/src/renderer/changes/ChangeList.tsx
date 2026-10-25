import { useId } from "react";
import type { NotDone, Plan, Step, Verdict } from "@gandalf/skills";
import { PathText } from "../design/PathText";
import { StatusGlyph } from "../library/StatusGlyph";
import {
  NOT_DONE,
  STEP_WORD,
  VERDICT_WORD,
  libraryPath,
  notDoneReason,
  stepPath,
  stepSentence,
  type Names,
} from "../vocabulary";

type Group = "remove" | "add" | "update";

/** The design system's fixed reading order. Apply runs steps in the plan's own order. */
const GROUPS = [
  { group: "remove", title: "Will remove", verdict: "extra" },
  { group: "add", title: "Will add", verdict: "missing" },
  { group: "update", title: "Will update", verdict: "repair" },
] as const satisfies readonly { group: Group; title: string; verdict: Verdict }[];

const GROUP_OF = {
  unlink: "remove",
  trashCopy: "remove",
  trashDuplicate: "remove",
  libraryTrash: "remove",
  ensureDir: "add",
  libraryAdd: "add",
  adoptMove: "add",
  link: "add",
  copy: "add",
  libraryReplace: "update",
  commitState: "update",
} as const satisfies Record<Step["kind"], Group>;

interface Row {
  readonly verdict: Verdict;
  readonly word: string;
  readonly path: string | null;
  readonly target?: string;
  readonly text: string;
}

function stepRow(step: Step, verdict: Verdict, names: Names): Row {
  return {
    verdict,
    word: STEP_WORD[step.kind].app,
    text: stepSentence(step, names),
    ...stepPath(step, names),
  };
}

function notDoneRow(item: NotDone, names: Names): Row {
  const { verdict } = NOT_DONE[item.kind];
  const row = { verdict, word: VERDICT_WORD[verdict], text: notDoneReason(item, names) };
  switch (item.kind) {
    case "conflict":
      return { ...row, path: item.entry.path };
    case "differsFromLibrary":
      return { ...row, path: item.at.path };
    case "rootUnreadable":
      return { ...row, path: item.root };
    case "libraryMissing":
    case "locallyModified":
      return { ...row, path: libraryPath(names, item.skill) };
    case "needsChoice":
      return { ...row, path: item.variants[0]?.at[0]?.path ?? null };
  }
}

function Section({ title, rows }: { readonly title: string; readonly rows: readonly Row[] }) {
  const heading = useId();
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={heading}>
      <h3 id={heading} className="px-5 pt-3 pb-1 text-title-3">
        {title}
      </h3>
      <ul>
        {rows.map((row, index) => (
          <li
            key={index}
            className="grid min-h-row-height grid-cols-[104px_minmax(0,1fr)] items-center gap-3 border-t border-separator px-5"
          >
            <StatusGlyph verdict={row.verdict} word={row.word} withWord />
            <span className="flex min-w-0 flex-col py-1">
              {row.path === null ? null : <PathText path={row.path} target={row.target} />}
              <span className="text-callout text-label-secondary">{row.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ChangeList({ plan, names }: { readonly plan: Plan; readonly names: Names }) {
  if (plan.steps.length === 0 && plan.notDone.length === 0) {
    return <p className="px-5 py-4 text-label-secondary">Nothing needs to change.</p>;
  }
  return (
    <div className="flex flex-col bg-content">
      {GROUPS.map(({ group, title, verdict }) => (
        <Section
          key={group}
          title={title}
          rows={plan.steps
            .filter((step) => GROUP_OF[step.kind] === group)
            .map((step) => stepRow(step, verdict, names))}
        />
      ))}
      <Section title="Not doing" rows={plan.notDone.map((item) => notDoneRow(item, names))} />
    </div>
  );
}

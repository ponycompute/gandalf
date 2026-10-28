import { useEffect, useRef, useState } from "react";
import type { Intent, Plan, Snapshot } from "@gandalf/skills";
import { DiskChanges } from "../changes/DiskChanges";
import { Button } from "../design/Button";
import { invoke } from "../invoke";
import type { Names } from "../vocabulary";
import { manageModel, twoVersions, variantsOf, type PlacedSkill } from "./model";
import { adoptAgreeing } from "./useAutoManage";

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** How many skills the sheet names before it sums up the rest. */
const SHOWN = 3;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "Claude Code and Cursor · the same in both", or what a skill whose copies differ waits for. */
function holders(skill: PlacedSkill, names: Names): string {
  const where = AND.format([...new Set(skill.copies.map((copy) => names.folder(copy.root)))]);
  if (!skill.agree) return `${where} · ${variantsOf(skill).length} versions, you keep one later`;
  if (skill.inLibrary) return `${where} · the same as the library's`;
  return skill.copies.length > 1
    ? `${where} · the same in ${skill.copies.length === 2 ? "both" : "all"}`
    : where;
}

/** The plan Manage would apply, read once when the sheet opens, for its changes on disk. */
function usePlan(intent: Intent | null): Plan | null {
  const [plan, setPlan] = useState<Plan | null>(null);
  const key = JSON.stringify(intent);
  useEffect(() => {
    let current = true;
    const parsed = JSON.parse(key) as Intent | null;
    if (parsed === null) return;
    void invoke(() => window.gandalf.plan(parsed)).then((result) => {
      if (current && result.ok && result.value.ok) setPlan(result.value.plan);
    });
    return () => {
      current = false;
    };
  }, [key]);
  return plan;
}

function Point({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <li className="flex flex-col border-t border-separator py-2.5">
      <span>{title}</span>
      <span className="text-callout text-label-secondary">{detail}</span>
    </li>
  );
}

interface ManageSheetProps {
  readonly snapshot: Snapshot;
  readonly names: Names;
  /** True when the user answers: gandalf manages skills from now on, or leaves them alone. */
  readonly onAnswer: (on: boolean) => void;
}

/**
 * Asked once, the first time gandalf finds skills in agents' own folders: may it manage them? Yes
 * moves each into the library with a link back, and brings in new ones the same way from then on.
 */
export function ManageSheet({ snapshot, names, onAnswer }: ManageSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const model = manageModel(snapshot);
  const intent = adoptAgreeing(snapshot);
  const plan = usePlan(intent);
  const agreeing = model.notManaged.filter((skill) => skill.agree).length;
  const differing = twoVersions(model).length;
  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    primary.current?.focus();
  }, []);
  const shown = model.notManaged.slice(0, SHOWN);
  const more = model.notManaged.length - shown.length;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="manage-sheet-title"
      onCancel={(event) => {
        event.preventDefault();
        onAnswer(false);
      }}
      className="mx-auto mt-toolbar-height max-h-[calc(100vh-var(--g-toolbar-height)-var(--g-space-5))] w-[min(460px,calc(100vw-40px))] flex-col overflow-hidden rounded-lg bg-content p-0 text-label shadow-popover backdrop:bg-black/20 open:flex"
    >
      <h2 id="manage-sheet-title" className="px-5 pt-4 pb-3 text-title-3">
        Let gandalf manage your skills?
      </h2>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-2">
        <ul className="flex flex-col gap-2 rounded-lg bg-row-alt px-3 py-3">
          {shown.map((skill) => (
            <li key={skill.name} className="flex flex-col">
              <span className="font-semibold">{skill.name}</span>
              <span className="text-callout text-label-secondary">{holders(skill, names)}</span>
            </li>
          ))}
          {more <= 0 ? null : (
            <li className="text-center text-callout text-label-secondary">and {more} more</li>
          )}
        </ul>
        <ul className="mt-3 flex flex-col">
          <Point
            title="Moves each into your library"
            detail="And links it back where it was, so every agent reads it as before"
          />
          <Point
            title="Brings in new skills the same way"
            detail="When another tool adds one. You can turn this off later."
          />
          {differing === 0 ? null : (
            <Point
              title={`Leaves ${plural(differing, "skill")} whose copies differ`}
              detail="They show Two versions in your library until you keep one."
            />
          )}
        </ul>
        {plan === null ? null : (
          <ul className="border-t border-separator">
            <DiskChanges plan={plan} names={names} recorded="Records the skills" open={false} />
          </ul>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-separator px-5 py-3">
        <Button onClick={() => onAnswer(false)}>Not Now</Button>
        <Button ref={primary} variant="primary" onClick={() => onAnswer(true)}>
          Manage {agreeing} {agreeing === 1 ? "Skill" : "Skills"}
        </Button>
      </footer>
    </dialog>
  );
}

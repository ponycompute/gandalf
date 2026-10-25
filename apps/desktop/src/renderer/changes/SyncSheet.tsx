import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NotDone, Plan, Snapshot } from "@gandalf/skills";
import { Banner } from "../design/Banner";
import { Button } from "../design/Button";
import { contentKey } from "../../shared/ipc";
import { shortHash } from "../discover/DiffView";
import { pickLabel, VersionChoice } from "../discover/VersionChoice";
import { ErrorBanner } from "../ErrorBanner";
import { busyText, intentTitle, planRefusal, type Names } from "../vocabulary";
import { ignoredPicks, withPick, type IgnoredPick } from "./adoptPick";
import { ChangeList } from "./ChangeList";
import type { Failure, Flow, FlowEvent } from "./writeFlow";

type SheetFlow = Extract<
  Flow,
  { kind: "previewing" | "replanning" | "applying" | "busy" | "failed" }
>;

export function sheetOf(flow: Flow): SheetFlow | null {
  switch (flow.kind) {
    case "previewing":
    case "replanning":
    case "applying":
    case "busy":
    case "failed":
      return flow;
    case "idle":
    case "planning":
    case "applied":
      return null;
  }
}

const PRIMARY = {
  previewing: "Apply",
  replanning: "Apply",
  applying: "Applying…",
  busy: "Try Again",
} as const satisfies Record<Exclude<SheetFlow["kind"], "failed">, string>;

const STALE = "Disk changed since the preview. Nothing was written.";

function appliesNothing(sheet: SheetFlow): boolean {
  return sheet.kind !== "failed" && sheet.plan.steps.length === 0;
}

function Refusal({
  failure,
  stale,
  names,
}: {
  readonly failure: Failure;
  readonly stale: boolean;
  readonly names: Names;
}) {
  if (failure.kind === "error") return <ErrorBanner error={failure.error} />;
  const { what, next } = planRefusal(failure.error, names);
  return (
    <Banner tone="conflict" title={stale ? STALE : "gandalf cannot plan this change"}>
      <span className="select-text">{what}</span>
      <span>
        {stale
          ? "The change no longer applies. Close this to see the library now."
          : `Nothing was written. ${next}`}
      </span>
    </Banner>
  );
}

/**
 * True when a snapshot that arrived after this preview opened shows other content than the disk the
 * plan was made from. Apply's own stale check still decides whether the plan runs.
 */
function useOutOfDate(sheet: SheetFlow | null, snapshot: Snapshot): boolean {
  const preview = sheet?.kind === "previewing" && !sheet.stale ? sheet : null;
  const [opened, setOpened] = useState<{ readonly plan: Plan; readonly snapshot: Snapshot } | null>(
    null,
  );
  if ((preview?.plan ?? null) !== (opened?.plan ?? null)) {
    setOpened(preview === null ? null : { plan: preview.plan, snapshot });
    return false;
  }
  return (
    preview !== null &&
    preview.basis !== null &&
    opened?.snapshot !== snapshot &&
    contentKey(snapshot) !== preview.basis
  );
}

const PICK_CHANGED = "The version you picked changed on disk";

/** The picks an open preview would not honour. Apply stays off while there is one. */
function ignoredOf(sheet: SheetFlow | null): readonly IgnoredPick[] {
  return sheet?.kind === "previewing" ? ignoredPicks(sheet.plan) : [];
}

interface PickIgnoredProps {
  readonly ignored: IgnoredPick;
  readonly names: Names;
  readonly onAccept: () => void;
}

/** "Claude Code's", or "the one in ~/.agents/skills" for a folder no agent writes to. */
function holder(label: string): string {
  return label.startsWith("~") || label.startsWith("/") ? `the one in ${label}` : `${label}'s`;
}

/**
 * A pick the plan would not adopt, with the version it would adopt instead. Choosing that version
 * plans again with it as the pick, so Apply never adopts a version the user did not see named.
 */
function PickIgnored({ ignored, names, onAccept }: PickIgnoredProps) {
  const hash = shortHash(ignored.adopted);
  const label = ignored.from === null ? null : names.folder(ignored.from.root);
  return (
    <Banner tone="change" title={PICK_CHANGED} live={false}>
      <span>
        {label === null
          ? `The library now has its own version of ${ignored.name} (${hash}), so Apply would link it instead of the version you picked.`
          : `Only one version of ${ignored.name} is left, ${holder(label)} (${hash}), so Apply would adopt it instead of the version you picked.`}{" "}
        Nothing was written. Adopt that version, or click Cancel.
      </span>
      <span className="flex justify-end pt-1">
        <Button size="small" onClick={onAccept}>
          {label === null ? "Adopt the Library's Version" : pickLabel(label)}
        </Button>
      </span>
    </Banner>
  );
}

interface NoticeProps {
  readonly sheet: SheetFlow;
  readonly names: Names;
  readonly outOfDate: boolean;
  readonly dispatch: (event: FlowEvent) => void;
}

/** Says what happened to the last Apply. Announced, since its region stays mounted. */
function Notice({ sheet, names, outOfDate, dispatch }: NoticeProps) {
  const [ignored] = ignoredOf(sheet);
  if (ignored !== undefined && sheet.kind === "previewing") {
    const { intent } = sheet.plan;
    return (
      <PickIgnored
        ignored={ignored}
        names={names}
        onAccept={() =>
          dispatch({
            kind: "choose",
            intent: withPick(intent, { name: ignored.name, kind: "hash", hash: ignored.adopted }),
          })
        }
      />
    );
  }
  if (sheet.kind === "previewing" && sheet.stale) {
    return (
      <Banner tone="change" title={STALE} live={false}>
        <span>
          {appliesNothing(sheet)
            ? "This is the plan now. Nothing in it can be applied. Click Cancel to close it."
            : "This is the plan now. Click Apply to apply it, or Cancel."}
        </span>
      </Banner>
    );
  }
  if (sheet.kind === "previewing" && choicesOf(sheet).some((item) => pickVanished(sheet, item))) {
    return (
      <Banner tone="change" title={PICK_CHANGED} live={false}>
        <span>Nothing was written. Compare the versions below and choose again.</span>
      </Banner>
    );
  }
  if (sheet.kind === "previewing" && outOfDate) {
    return (
      <Banner tone="change" title="May be out of date" live={false}>
        <span>
          The disk changed after gandalf made this preview. Apply checks it again and writes nothing
          if the plan no longer matches.
        </span>
      </Banner>
    );
  }
  if (sheet.kind === "busy") {
    return (
      <Banner tone="change" title="Another gandalf is applying changes" live={false}>
        <span className="select-text">{busyText(sheet.holder)}</span>
        <span>Nothing was written. Try again when it finishes.</span>
      </Banner>
    );
  }
  return null;
}

type NeedsChoice = Extract<NotDone, { kind: "needsChoice" }>;

/** The adopted names whose copies differ, each waiting for the user to pick a version. */
function choicesOf(sheet: SheetFlow | null): readonly NeedsChoice[] {
  if (sheet === null || sheet.kind === "failed" || sheet.plan.intent.kind !== "adopt") return [];
  if (sheet.kind !== "previewing" && sheet.kind !== "replanning") return [];
  return sheet.plan.notDone.filter((item): item is NeedsChoice => item.kind === "needsChoice");
}

/** True when the intent picked a version of this name and the plan still asks: the pick vanished. */
function pickVanished(sheet: SheetFlow, item: NeedsChoice): boolean {
  if (sheet.kind === "failed") return false;
  const { intent } = sheet.plan;
  return intent.kind === "adopt" && intent.pick.some((pick) => pick.name === item.name);
}

/**
 * True from the moment the sheet shows a version choice until it closes, so the sheet keeps its
 * width when the pick lands and the choice gives way to the plain plan.
 */
function useWide(sheet: SheetFlow | null, choosing: boolean): boolean {
  const [wide, setWide] = useState(false);
  if (choosing && !wide) setWide(true);
  if (sheet === null && wide) setWide(false);
  return choosing || (wide && sheet !== null);
}

interface BodyProps {
  readonly sheet: SheetFlow;
  readonly names: Names;
  readonly outOfDate: boolean;
  readonly dispatch: (event: FlowEvent) => void;
}

function Body({ sheet, names, outOfDate, dispatch }: BodyProps) {
  if (sheet.kind === "failed") {
    return (
      <div className="px-5 pb-3">
        <Refusal failure={sheet.failure} stale={sheet.stale} names={names} />
      </div>
    );
  }
  const choices = choicesOf(sheet);
  return (
    <>
      <div role="status" className="px-5 [&:not(:empty)]:pb-3">
        <Notice sheet={sheet} names={names} outOfDate={outOfDate} dispatch={dispatch} />
      </div>
      {choices.map((item) => (
        <VersionChoice
          key={item.name}
          item={item}
          names={names}
          disabled={sheet.kind === "replanning"}
          onPick={(pick) => dispatch({ kind: "choose", intent: withPick(sheet.plan.intent, pick) })}
        />
      ))}
      <ChangeList plan={sheet.plan} names={names} choicesAbove={choices.length > 0} />
    </>
  );
}

interface SyncSheetProps {
  readonly flow: Flow;
  /** The snapshot on screen, to tell when the disk changed under an open preview. */
  readonly snapshot: Snapshot;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
}

/**
 * The sync preview. Escape cancels, also while a picked version is being planned. Enter runs the
 * primary button.
 */
export function SyncSheet({ flow, snapshot, names, dispatch }: SyncSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const secondary = useRef<HTMLButtonElement>(null);
  const sheet = sheetOf(flow);
  const open = sheet !== null;
  const nothingToApply = sheet !== null && appliesNothing(sheet);
  const blocked = nothingToApply || ignoredOf(sheet).length > 0;
  const outOfDate = useOutOfDate(sheet, snapshot);
  const wide = useWide(sheet, choicesOf(sheet).length > 0);
  const working = sheet?.kind === "applying" || sheet?.kind === "replanning";

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  });
  // A focused button that turns disabled drops focus to the body, so Cancel takes it instead.
  useEffect(() => {
    if (open) (blocked ? secondary : primary).current?.focus();
  }, [open, sheet?.kind, blocked]);

  const cancel = () => dispatch({ kind: "cancel" });
  const apply = () => dispatch({ kind: "apply" });
  // A held key repeats keydown, which would click a button again after the sheet changed under it.
  const ignoreRepeats = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (!event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Enter" || event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    primary.current?.click();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="sync-sheet-title"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onKeyDownCapture={ignoreRepeats}
      onKeyDown={onKeyDown}
      className={`mx-auto mt-toolbar-height max-h-[calc(100vh-var(--g-toolbar-height)-var(--g-space-5))] ${wide ? "w-[min(760px,calc(100vw-40px))]" : "w-[min(560px,calc(100vw-40px))]"} flex-col overflow-hidden rounded-lg bg-content p-0 text-label shadow-popover backdrop:bg-black/20 open:flex`}
    >
      {sheet === null ? null : (
        <>
          <h2 id="sync-sheet-title" className="px-5 pt-4 pb-3 text-title-2">
            {intentTitle(sheet.kind === "failed" ? sheet.intent : sheet.plan.intent, names)}
          </h2>
          <div className="min-h-0 flex-1 overflow-auto pb-2">
            <Body sheet={sheet} names={names} outOfDate={outOfDate} dispatch={dispatch} />
          </div>
          <footer className="flex justify-end gap-2 border-t border-separator px-5 py-3">
            {sheet.kind === "failed" ? (
              <Button ref={primary} onClick={cancel}>
                Close
              </Button>
            ) : (
              <>
                <Button ref={secondary} onClick={cancel} disabled={sheet.kind === "applying"}>
                  Cancel
                </Button>
                <Button
                  ref={primary}
                  variant="primary"
                  onClick={apply}
                  aria-disabled={working ? true : undefined}
                  disabled={blocked}
                >
                  {PRIMARY[sheet.kind]}
                </Button>
              </>
            )}
          </footer>
        </>
      )}
    </dialog>
  );
}

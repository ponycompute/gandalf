import { useEffect, useRef, type KeyboardEvent } from "react";
import { Banner } from "../design/Banner";
import { Button } from "../design/Button";
import { ErrorBanner } from "../ErrorBanner";
import { busyText, intentTitle, planRefusal, type Names } from "../vocabulary";
import { ChangeList } from "./ChangeList";
import type { Failure, Flow, FlowEvent } from "./writeFlow";

type SheetFlow = Extract<Flow, { kind: "previewing" | "applying" | "busy" | "failed" }>;

export function sheetOf(flow: Flow): SheetFlow | null {
  switch (flow.kind) {
    case "previewing":
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

/** Says what happened to the last Apply. Announced, since its region stays mounted. */
function Notice({ sheet }: { readonly sheet: SheetFlow }) {
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

function Body({ sheet, names }: { readonly sheet: SheetFlow; readonly names: Names }) {
  if (sheet.kind === "failed") {
    return (
      <div className="px-5 pb-3">
        <Refusal failure={sheet.failure} stale={sheet.stale} names={names} />
      </div>
    );
  }
  return (
    <>
      <div role="status" className="px-5 [&:not(:empty)]:pb-3">
        <Notice sheet={sheet} />
      </div>
      <ChangeList plan={sheet.plan} names={names} />
    </>
  );
}

interface SyncSheetProps {
  readonly flow: Flow;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
}

/** The sync preview. Escape cancels, Enter runs the primary button. */
export function SyncSheet({ flow, names, dispatch }: SyncSheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const secondary = useRef<HTMLButtonElement>(null);
  const sheet = sheetOf(flow);
  const open = sheet !== null;
  const nothingToApply = sheet !== null && appliesNothing(sheet);

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  });
  // A focused button that turns disabled drops focus to the body, so Cancel takes it instead.
  useEffect(() => {
    if (open) (nothingToApply ? secondary : primary).current?.focus();
  }, [open, sheet?.kind, nothingToApply]);

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
      className="mx-auto mt-toolbar-height max-h-[calc(100vh-var(--g-toolbar-height)-var(--g-space-5))] w-[min(560px,calc(100vw-40px))] flex-col overflow-hidden rounded-lg bg-content p-0 text-label shadow-popover backdrop:bg-black/20 open:flex"
    >
      {sheet === null ? null : (
        <>
          <h2 id="sync-sheet-title" className="px-5 pt-4 pb-3 text-title-2">
            {intentTitle(sheet.kind === "failed" ? sheet.intent : sheet.plan.intent, names)}
          </h2>
          <div className="min-h-0 flex-1 overflow-auto pb-2">
            <Body sheet={sheet} names={names} />
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
                  aria-disabled={sheet.kind === "applying" ? true : undefined}
                  disabled={nothingToApply}
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

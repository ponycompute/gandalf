import { useMemo, useState } from "react";
import { Button } from "../design/Button";
import { capRows, hunks, textDiff, type DiffGap, type DiffLine } from "./diff";

export interface DiffSide {
  /** Who holds this version, such as "Claude Code". */
  readonly label: string;
  readonly hash: string;
}

interface DiffViewProps {
  readonly before: DiffSide & { readonly text: string };
  readonly after: DiffSide & { readonly text: string };
}

/** Rows drawn until the user asks for all, so a diff past the edit cap does not mount tens of thousands. */
const MAX_ROWS = 1000;

/** "sha256:" and the first 8 hex digits, per the design system. */
export function shortHash(hash: string): string {
  const colon = hash.indexOf(":") + 1;
  return hash.slice(0, colon + 8);
}

const LINE = {
  same: { fill: "", sign: " ", name: undefined },
  add: { fill: "bg-diff-add", sign: "+", name: "Added" },
  remove: { fill: "bg-diff-remove", sign: "−", name: "Removed" },
} as const satisfies Record<DiffLine["kind"], { fill: string; sign: string; name?: string }>;

function Row({ line }: { readonly line: DiffLine | DiffGap }) {
  if (line.kind === "gap") {
    return (
      <div className="px-3 font-sans text-callout text-label-secondary">
        {line.count} unchanged {line.count === 1 ? "line" : "lines"}
      </div>
    );
  }
  const style = LINE[line.kind];
  return (
    <div className={`grid grid-cols-[2ch_minmax(0,1fr)] px-3 whitespace-pre ${style.fill}`}>
      <span className="text-label-secondary">
        <span aria-hidden="true">{style.sign}</span>
        {style.name === undefined ? null : <span className="sr-only">{style.name}</span>}
      </span>
      <span className="text-label">{line.text}</span>
    </div>
  );
}

/**
 * Unified hunks of two versions of a SKILL.md. The lines scroll inside their own pane, both ways,
 * so a long file never grows the sheet or the window. What the lines cannot show, the same file,
 * CRLF on one side or a missing final newline, is said in a note above them, and when that is all
 * that differs the note shows alone.
 */
export function DiffView({ before, after }: DiffViewProps) {
  const diff = useMemo(() => textDiff(before.text, after.text), [before.text, after.text]);
  // Showing every row applies to this diff only, so a variant read again starts capped.
  const [uncappedFor, setUncappedFor] = useState<typeof diff | null>(null);
  const shown = useMemo(
    () => capRows(hunks(diff.lines), uncappedFor === diff ? Infinity : MAX_ROWS),
    [diff, uncappedFor],
  );
  const sideOf = (which: "before" | "after") => (which === "before" ? before : after);
  const notes = [
    diff.crlf === null
      ? null
      : `${sideOf(diff.crlf).label}'s SKILL.md ends its lines with CRLF and ${sideOf(diff.crlf === "before" ? "after" : "before").label}'s with LF. ${diff.changed ? "The lines below are compared without that difference." : "Apart from that, the lines are the same."}`,
    diff.noFinalNewline === null
      ? null
      : `${sideOf(diff.noFinalNewline).label}'s SKILL.md has no newline at the end.`,
  ].filter((note) => note !== null);
  return (
    <figure
      aria-label={`Changes from ${before.label}'s version to ${after.label}'s`}
      className="overflow-hidden rounded-sm border border-separator bg-content"
    >
      <figcaption className="grid grid-cols-2 gap-2 border-b border-separator px-3 py-2 text-callout text-label-secondary">
        {[before, after].map((side, index) => (
          <span key={index} className="min-w-0 truncate">
            {index === 0 ? "− " : "+ "}
            {side.label} · <span className="font-mono text-path">{shortHash(side.hash)}</span>
          </span>
        ))}
      </figcaption>
      {diff.identical ? (
        <p className="px-3 py-2 text-callout text-label-secondary">
          SKILL.md is the same in both. Other files differ.
        </p>
      ) : (
        <>
          {notes.map((note) => (
            <p
              key={note}
              data-diff-note=""
              className={`px-3 py-2 text-callout text-label-secondary ${diff.changed ? "border-b border-separator" : ""}`}
            >
              {note}
            </p>
          ))}
          {diff.changed ? (
            <div
              data-diff-lines=""
              role="region"
              aria-label="Changes in SKILL.md"
              tabIndex={0}
              className="max-h-64 overflow-auto overscroll-contain font-mono text-code select-text"
            >
              <div className="w-max min-w-full">
                {shown.rows.map((line, index) => (
                  <Row key={index} line={line} />
                ))}
                {shown.hidden === 0 ? null : (
                  <div className="sticky left-0 flex w-fit items-center gap-2 px-3 py-1 font-sans text-callout text-label-secondary">
                    <span>
                      {shown.hidden} more {shown.hidden === 1 ? "line" : "lines"} not shown,{" "}
                      {shown.hiddenChanges} of them changed.
                    </span>
                    <Button size="small" onClick={() => setUncappedFor(diff)}>
                      Show All Lines
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
    </figure>
  );
}

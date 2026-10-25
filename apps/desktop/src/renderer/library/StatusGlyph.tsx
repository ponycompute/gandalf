import type { Mode, Verdict } from "@gandalf/skills";
import { GLYPH, verdictWord } from "../vocabulary";

const INK = {
  ok: "text-status-linked",
  missing: "text-status-change",
  repair: "text-status-change",
  extra: "text-status-change",
  blocked: "text-status-conflict",
  conflict: "text-status-conflict",
  unmanaged: "text-status-unmanaged",
  untouched: "text-label-secondary",
  off: "text-label-secondary",
} as const satisfies Record<Verdict | "off", string>;

/** A selected row's text color, which everything inside it takes. */
const SELECTED =
  "group-data-[selection=active]:text-on-accent group-data-[selection=inactive]:text-label";

interface StatusGlyphProps {
  readonly verdict: Verdict | "off";
  /** Tells Linked from Copied for an ok verdict. */
  readonly mode?: Mode;
  /** Replaces the verdict's word. The change list passes a step's user word, such as Remove. */
  readonly word?: string;
  /** Shows the word beside the glyph. Otherwise the word is screen-reader text and the tooltip. */
  readonly withWord?: boolean;
  /** The word's element id, for a control that is described by it. */
  readonly wordId?: string;
}

export function StatusGlyph({ verdict, mode, word, withWord = false, wordId }: StatusGlyphProps) {
  const label = word ?? verdictWord(verdict, mode);
  return (
    <span
      title={withWord ? undefined : label}
      className="inline-flex items-baseline gap-1 whitespace-nowrap"
    >
      <span
        aria-hidden="true"
        className={`w-[1ch] text-center font-mono text-[12px] ${INK[verdict]} ${SELECTED}`}
      >
        {GLYPH[verdict]}
      </span>
      <span id={wordId} className={withWord ? SELECTED : "sr-only"}>
        {label}
      </span>
    </span>
  );
}

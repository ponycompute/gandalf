import { STATUS, type Verdict } from "@/data/status";

/** The CLI's glyph in its status color. The word stays as the accessible name unless `withWord`. */
export function StatusGlyph({
  verdict,
  withWord = false,
}: {
  verdict: Verdict;
  withWord?: boolean;
}) {
  const { glyph, word, token } = STATUS[verdict];
  const mark = (
    <span
      className={`gd-status-glyph gd-status-${token}`}
      title={word}
      aria-label={withWord ? undefined : word}
    >
      {glyph}
    </span>
  );
  if (!withWord) return mark;
  return (
    <span className="gd-status">
      {mark}
      <span className="gd-status-word">{word}</span>
    </span>
  );
}

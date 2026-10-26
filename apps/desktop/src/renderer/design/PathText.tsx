import { Fragment } from "react";
import { tilde } from "../vocabulary";

interface PathTextProps {
  readonly path: string;
  /** Where a symlink at `path` points. */
  readonly target?: string;
  /**
   * Wraps the whole path onto as many lines as it needs, breaking anywhere, instead of shortening
   * it from the left on one line: for a panel too narrow for even the last two segments.
   */
  readonly wrap?: boolean;
}

const ARROW = " → ";

/** A path split where it may ellipsize: the head shrinks, the parent folder and last segment never do. */
function split(shown: string) {
  const last = shown.lastIndexOf("/") + 1;
  const parent = shown.lastIndexOf("/", last - 2) + 1;
  return {
    head: shown.slice(0, parent),
    parent: shown.slice(parent, last),
    last: shown.slice(last),
  };
}

type Parts = ReturnType<typeof split>;

/**
 * Each head gets its share of the width left over, rounded down to whole characters. The font is
 * monospace, so the ellipsis then ends flush with the head's box instead of leaving a blank gap
 * up to one character wide before the next segment.
 */
function headWidth(head: string, fixed: number, heads: number): string {
  const share = `calc((100cqw - ${fixed}ch) * ${head.length / heads})`;
  // Layout rounds a width of whole ch down by a fraction of a pixel, which would push the last
  // character out and leave the gap again, so the box gets a hair more.
  return `calc(min(${head.length}ch, max(1ch, round(down, ${share}, 1ch))) + 0.1px)`;
}

function Side({
  parts,
  fixed,
  heads,
}: {
  readonly parts: Parts;
  readonly fixed: number;
  readonly heads: number;
}) {
  return (
    <>
      {parts.head === "" ? null : (
        <span className="flex-none truncate" style={{ width: headWidth(parts.head, fixed, heads) }}>
          {parts.head}
        </span>
      )}
      <span className="flex-none">{parts.parent}</span>
      <span className="flex-none text-label">{parts.last}</span>
    </>
  );
}

export function PathText({ path, target, wrap = false }: PathTextProps) {
  const shown = tilde(path, window.gandalf);
  const pointsAt = target === undefined ? null : tilde(target, window.gandalf);
  if (wrap) {
    return (
      <span className="min-w-0 font-mono text-path [overflow-wrap:anywhere] text-label-secondary select-text">
        {pointsAt === null ? shown : `${shown}${ARROW}${pointsAt}`}
      </span>
    );
  }
  const sides = [split(shown), ...(pointsAt === null ? [] : [split(pointsAt)])];
  const fixed =
    sides.reduce((sum, side) => sum + side.parent.length + side.last.length, 0) +
    (sides.length - 1) * ARROW.length;
  const heads = sides.reduce((sum, side) => sum + side.head.length, 0);
  return (
    <span
      title={pointsAt === null ? shown : `${shown}${ARROW}${pointsAt}`}
      className="@container flex min-w-0 overflow-hidden font-mono text-path whitespace-nowrap text-label-secondary select-text"
    >
      {sides.map((parts, index) => (
        <Fragment key={index}>
          {index === 0 ? null : (
            <span className="w-[3ch] flex-none text-center">{ARROW.trim()}</span>
          )}
          <Side parts={parts} fixed={fixed} heads={heads} />
        </Fragment>
      ))}
    </span>
  );
}

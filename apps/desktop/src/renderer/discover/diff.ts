export interface DiffLine {
  readonly kind: "same" | "add" | "remove";
  readonly text: string;
}

/** Lines left out between hunks. */
export interface DiffGap {
  readonly kind: "gap";
  readonly count: number;
}

/**
 * Past this many added and removed lines the middle shows as all removed, then all added. Edit d
 * keeps a row of 2d + 1 Int32s, so the search holds at most 2001² of them, 16 MB, and its time is
 * O((lines in both) × 2000).
 */
const MAX_EDITS = 2000;

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The lines of `before` turned into `after`, with as few added and removed lines as it takes. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const same = (text: string): DiffLine => ({ kind: "same", text });
  return [
    ...a.slice(0, start).map(same),
    ...middle(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map(same),
  ];
}

/**
 * Myers' O(ND) diff: for each number of edits d it records, per diagonal k = x - y, the furthest
 * line of `a` a path with d edits reaches, then walks those rows back from the end.
 */
function middle(a: readonly string[], b: readonly string[]): DiffLine[] {
  const fallback = (): DiffLine[] => [
    ...a.map((text): DiffLine => ({ kind: "remove", text })),
    ...b.map((text): DiffLine => ({ kind: "add", text })),
  ];
  if (a.length === 0 || b.length === 0) return fallback();
  const max = Math.min(a.length + b.length, MAX_EDITS);
  // rows[d][k + d] is the furthest x on diagonal k after d edits.
  const rows: Int32Array[] = [];
  let previous = new Int32Array([0]);
  for (let d = 0; d <= max; d += 1) {
    const row = new Int32Array(2 * d + 1);
    const at = (k: number) => previous[k + d - 1] ?? 0;
    for (let k = -d; k <= d; k += 2) {
      let x =
        d === 0 ? 0 : k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      row[k + d] = x;
      if (x >= a.length && y >= b.length) {
        rows.push(row);
        return walkBack(a, b, rows);
      }
    }
    rows.push(row);
    previous = row;
  }
  return fallback();
}

function walkBack(a: readonly string[], b: readonly string[], rows: readonly Int32Array[]) {
  const lines: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = rows.length - 1; d > 0; d -= 1) {
    const row = rows[d - 1] ?? new Int32Array();
    const at = (k: number) => row[k + d - 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const fromX = at(down ? k + 1 : k - 1);
    const fromY = fromX - (down ? k + 1 : k - 1);
    while (x > fromX + (down ? 0 : 1) && y > fromY + (down ? 1 : 0)) {
      x -= 1;
      y -= 1;
      lines.push({ kind: "same", text: a[x] ?? "" });
    }
    if (down) lines.push({ kind: "add", text: b[fromY] ?? "" });
    else lines.push({ kind: "remove", text: a[fromX] ?? "" });
    x = fromX;
    y = fromY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    lines.push({ kind: "same", text: a[x] ?? "" });
  }
  return lines.reverse();
}

/** What differs between two versions of a file, beyond its lines. */
export interface TextDiff {
  readonly lines: readonly DiffLine[];
  /** Byte for byte the same, so whatever differs is in other files. */
  readonly identical: boolean;
  /**
   * Set when one side ends every line with CRLF and the other ends none with it. The lines are then
   * compared without the CR, so a file that differs only in line endings does not show every line
   * changed. A side that mixes the two is compared as it is, its CRs showing as changed lines.
   */
  readonly crlf: "before" | "after" | null;
  /** True when some line is added or removed once line endings are set aside. */
  readonly changed: boolean;
  /** The side without a newline at the end, when only one lacks it. */
  readonly noFinalNewline: "before" | "after" | null;
}

type Endings = "crlf" | "lf" | "mixed";

/** How a text ends its lines: every break with CRLF, none with it, or some of each. */
function endingsOf(text: string): Endings {
  const breaks = text.split("\n").length - 1;
  const crlf = text.split("\r\n").length - 1;
  return crlf === 0 ? "lf" : crlf === breaks ? "crlf" : "mixed";
}

export function textDiff(before: string, after: string): TextDiff {
  const endings = [endingsOf(before), endingsOf(after)].join();
  const crlf = endings === "crlf,lf" ? "before" : endings === "lf,crlf" ? "after" : null;
  const lf = (text: string) => (crlf === null ? text : text.replaceAll("\r\n", "\n"));
  const ends = (text: string) => text === "" || text.endsWith("\n");
  const noFinalNewline = ends(before) === ends(after) ? null : ends(before) ? "after" : "before";
  const lines = lineDiff(lf(before), lf(after));
  return {
    lines,
    identical: before === after,
    changed: lines.some((line) => line.kind !== "same"),
    crlf,
    noFinalNewline,
  };
}

/** Unified hunks: every changed line with `context` unchanged lines around it, gaps for the rest. */
export function hunks(lines: readonly DiffLine[], context = 3): (DiffLine | DiffGap)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let near = from; near <= to; near += 1) keep[near] = true;
  });
  const shown: (DiffLine | DiffGap)[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) shown.push({ kind: "gap", count: skipped });
      skipped = 0;
      shown.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) shown.push({ kind: "gap", count: skipped });
  return shown;
}

/** The first `max` rows of hunks to draw, and how many lines the rows after them hold. */
export function capRows(
  rows: readonly (DiffLine | DiffGap)[],
  max: number,
): {
  readonly rows: readonly (DiffLine | DiffGap)[];
  readonly hidden: number;
  readonly hiddenChanges: number;
} {
  const rest = rows.slice(max);
  return {
    rows: rest.length === 0 ? rows : rows.slice(0, max),
    hidden: rest.reduce((sum, row) => sum + (row.kind === "gap" ? row.count : 1), 0),
    hiddenChanges: rest.filter((row) => row.kind === "add" || row.kind === "remove").length,
  };
}

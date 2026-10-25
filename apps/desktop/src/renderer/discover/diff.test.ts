import { describe, expect, it } from "vitest";
import { capRows, hunks, lineDiff, textDiff, type DiffLine } from "./diff";

const text = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("lineDiff", () => {
  it("marks every line unchanged when both sides match", () => {
    expect(lineDiff(text("a", "b"), text("a", "b"))).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  it("marks a line only the second side has as added", () => {
    expect(lineDiff(text("a", "c"), text("a", "b", "c"))).toEqual([
      { kind: "same", text: "a" },
      { kind: "add", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("marks a line only the first side has as removed", () => {
    expect(lineDiff(text("a", "b", "c"), text("a", "c"))).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("shows a changed line as removed, then added, between unchanged ones", () => {
    expect(lineDiff(text("name: x", "old", "end"), text("name: x", "new", "end"))).toEqual([
      { kind: "same", text: "name: x" },
      { kind: "remove", text: "old" },
      { kind: "add", text: "new" },
      { kind: "same", text: "end" },
    ]);
  });

  it("keeps lines both sides share in the middle of other changes", () => {
    const kinds = lineDiff(text("x", "keep", "y"), text("p", "keep", "q")).map(
      (line) => `${line.kind} ${line.text}`,
    );
    expect(kinds).toEqual(["remove x", "add p", "same keep", "remove y", "add q"]);
  });

  it("treats a missing final newline as the same last line", () => {
    expect(lineDiff("a\nb", "a\nb\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  it("diffs an empty side as all added or all removed", () => {
    expect(lineDiff("", text("a"))).toEqual([{ kind: "add", text: "a" }]);
    expect(lineDiff(text("a"), "")).toEqual([{ kind: "remove", text: "a" }]);
  });
});

/** The length of the longest common subsequence, the classic way, as an oracle. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  let row = new Array<number>(b.length + 1).fill(0);
  for (const line of a) {
    const next = [0];
    b.forEach((other, j) => {
      next.push(line === other ? (row[j] ?? 0) + 1 : Math.max(row[j + 1] ?? 0, next[j] ?? 0));
    });
    row = next;
  }
  return row[b.length] ?? 0;
}

const side = (lines: readonly DiffLine[], drop: DiffLine["kind"]) =>
  lines.filter((line) => line.kind !== drop).map((line) => line.text);

describe("lineDiff, as a minimal edit", () => {
  it("rebuilds both sides and keeps a longest common run, for many small random pairs", () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 500; round += 1) {
      const a = Array.from({ length: random(12) }, () => "abcd"[random(4)] ?? "a");
      const b = Array.from({ length: random(12) }, () => "abcd"[random(4)] ?? "a");
      const joined = (lines: readonly string[]) => lines.map((line) => `${line}\n`).join("");
      const lines = lineDiff(joined(a), joined(b));
      expect(side(lines, "add")).toEqual(a);
      expect(side(lines, "remove")).toEqual(b);
      expect(lines.filter((line) => line.kind === "same")).toHaveLength(lcsLength(a, b));
    }
  });

  it("shows only the changed lines of two 5000-line files, fast", () => {
    const before = Array.from({ length: 5000 }, (_, n) => `line ${n}`);
    const after = before.map((line, n) =>
      n === 100 || n === 2500 || n === 4900 ? `${line}!` : line,
    );
    after.splice(3000, 0, "inserted");
    const started = performance.now();
    const lines = lineDiff(text(...before), text(...after));
    const took = performance.now() - started;
    expect(lines.filter((line) => line.kind !== "same")).toHaveLength(7);
    expect(side(lines, "add")).toEqual(before);
    expect(side(lines, "remove")).toEqual(after);
    expect(took).toBeLessThan(100);
  });

  it("falls back to all removed, then all added, only past thousands of edits", () => {
    const before = Array.from({ length: 3000 }, (_, n) => `old ${n}`);
    const after = Array.from({ length: 3000 }, (_, n) => `new ${n}`);
    const started = performance.now();
    const lines = lineDiff(text(...before), text(...after));
    expect(performance.now() - started).toBeLessThan(500);
    expect(lines.map((line) => line.kind)).toEqual([
      ...before.map(() => "remove"),
      ...after.map(() => "add"),
    ]);
  });
});

describe("textDiff", () => {
  it("says when both sides are byte for byte the same", () => {
    expect(textDiff(text("a"), text("a"))).toMatchObject({
      identical: true,
      crlf: null,
      noFinalNewline: null,
    });
  });

  it("compares CRLF lines with LF ones by their text and says which side uses CRLF", () => {
    const diff = textDiff("a\r\nb\r\nc\r\n", text("a", "B", "c"));
    expect(diff.crlf).toBe("before");
    expect(diff.identical).toBe(false);
    expect(diff.lines.map((line) => `${line.kind} ${line.text}`)).toEqual([
      "same a",
      "remove b",
      "add B",
      "same c",
    ]);
  });

  it("says nothing of CRLF when a side ends only some lines with it, and shows those lines", () => {
    const diff = textDiff("a\r\nb\nc\n", text("a", "b", "c"));
    expect(diff.crlf).toBeNull();
    expect(diff.changed).toBe(true);
    expect(diff.lines.map((line) => line.kind)).toEqual(["remove", "add", "same", "same"]);
    expect(textDiff(text("a", "b"), "a\r\nb\r\n").crlf).toBe("after");
  });

  it("finds no changed line when only line endings or the final newline differ", () => {
    expect(textDiff("a\r\nb\r\n", text("a", "b"))).toMatchObject({
      crlf: "before",
      changed: false,
    });
    expect(textDiff("a\nb", text("a", "b")).changed).toBe(false);
    expect(textDiff(text("a"), text("b")).changed).toBe(true);
  });

  it("says which side has no newline at the end", () => {
    const diff = textDiff("a\nb", text("a", "b"));
    expect(diff.noFinalNewline).toBe("before");
    expect(diff.lines.every((line) => line.kind === "same")).toBe(true);
    expect(textDiff(text("a"), "a").noFinalNewline).toBe("after");
  });
});

describe("hunks", () => {
  it("keeps context around a change and counts the lines it leaves out", () => {
    const before = text(...Array.from({ length: 20 }, (_, n) => `line ${n}`));
    const after = before.replace("line 10\n", "line ten\n");
    const shown = hunks(lineDiff(before, after), 2);
    expect(shown).toEqual([
      { kind: "gap", count: 8 },
      { kind: "same", text: "line 8" },
      { kind: "same", text: "line 9" },
      { kind: "remove", text: "line 10" },
      { kind: "add", text: "line ten" },
      { kind: "same", text: "line 11" },
      { kind: "same", text: "line 12" },
      { kind: "gap", count: 7 },
    ]);
  });

  it("shows nothing but one gap when nothing changed", () => {
    expect(hunks(lineDiff(text("a", "b"), text("a", "b")))).toEqual([{ kind: "gap", count: 2 }]);
  });
});

describe("capRows", () => {
  it("keeps every row under the cap", () => {
    const rows = hunks(lineDiff(text("a"), text("b")));
    expect(capRows(rows, 10)).toEqual({ rows, hidden: 0, hiddenChanges: 0 });
  });

  it("draws the first rows of a diff past the edit cap and counts the lines left", () => {
    const before = text(...Array.from({ length: 3000 }, (_, n) => `old ${n}`));
    const after = text(...Array.from({ length: 3000 }, (_, n) => `new ${n}`));
    const rows = hunks(textDiff(before, after).lines);
    expect(rows).toHaveLength(6000);
    const capped = capRows(rows, 1000);
    expect(capped.rows).toHaveLength(1000);
    expect(capped.hidden).toBe(5000);
    expect(capped.hiddenChanges).toBe(5000);
    expect(capRows([{ kind: "gap", count: 4 }, ...rows.slice(0, 1)], 0).hidden).toBe(5);
  });
});

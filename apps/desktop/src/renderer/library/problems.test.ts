import type { AgentId, Cell, SkillView } from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import type { Names } from "../vocabulary";
import { notesOf, pillOf, problemsOf } from "./problems";

const DISPLAY: Readonly<Record<string, string>> = {
  cursor: "Cursor",
  claude_code: "Claude Code",
  codex: "Codex",
};

const names = { agent: (id: AgentId) => DISPLAY[id] ?? id } as Names;

function skill(cells: readonly [string, Cell["verdict"]][], hash: string | null = "h"): SkillView {
  return {
    name: "demo",
    hash,
    cells: cells.map(([agent, verdict]) => ({
      agent: agent as AgentId,
      enabled: verdict !== "off",
      verdict,
    })),
  } as unknown as SkillView;
}

describe("a skill's problems", () => {
  it("has none when every agent is linked, off or left alone", () => {
    const problems = problemsOf(
      skill([
        ["cursor", "ok"],
        ["codex", "off"],
        ["claude_code", "untouched"],
      ]),
    );
    expect(problems).toEqual([]);
    expect(pillOf(problems, names)).toBeNull();
    expect(notesOf(problems, names)).toEqual([]);
  });

  it("names a single problem and its agent on the pill", () => {
    const sync = problemsOf(
      skill([
        ["cursor", "missing"],
        ["codex", "ok"],
      ]),
    );
    expect(pillOf(sync, names)).toEqual({ text: "Not synced in Cursor", tone: "sync" });
    const review = problemsOf(skill([["codex", "conflict"]]));
    expect(pillOf(review, names)).toEqual({ text: "Conflict in Codex", tone: "review" });
  });

  it("counts several, red when any needs a review", () => {
    const mixed = problemsOf(
      skill([
        ["cursor", "repair"],
        ["codex", "conflict"],
      ]),
    );
    expect(pillOf(mixed, names)).toEqual({ text: "2 problems", tone: "review" });
    const syncOnly = problemsOf(
      skill([
        ["cursor", "repair"],
        ["codex", "extra"],
      ]),
    );
    expect(pillOf(syncOnly, names)).toEqual({ text: "2 problems", tone: "sync" });
  });

  it("writes one note per fix, grouping agents with the same problem", () => {
    const problems = problemsOf(
      skill([
        ["cursor", "missing"],
        ["claude_code", "missing"],
        ["codex", "conflict"],
      ]),
    );
    expect(notesOf(problems, names)).toEqual([
      { fix: "sync", text: "Not synced in Cursor and Claude Code." },
      { fix: "review", text: "Conflict in Codex." },
    ]);
  });

  it("counts a missing library folder as a problem to review", () => {
    const problems = problemsOf(skill([["cursor", "ok"]], null));
    expect(pillOf(problems, names)).toEqual({ text: "Folder missing", tone: "review" });
    expect(notesOf(problems, names)).toEqual([
      { fix: "review", text: "Folder missing in the library." },
    ]);
  });
});

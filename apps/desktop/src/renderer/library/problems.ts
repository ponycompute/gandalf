import type { AgentId, SkillView, Verdict } from "@gandalf/skills";
import type { Names } from "../vocabulary";

/**
 * What it takes to fix a problem: "sync" ones go away with a Sync of the skill, "review" ones need
 * a choice on the Discover screen, as gandalf never writes over a folder it does not manage.
 */
export type Fix = "sync" | "review";

const FIX: Readonly<Partial<Record<Verdict | "off", Fix>>> = {
  missing: "sync",
  repair: "sync",
  extra: "sync",
  conflict: "review",
  blocked: "review",
  unmanaged: "review",
};

/** The word a problem reads as on its pill and note. */
const PROBLEM_WORD: Readonly<Record<Fix, Partial<Record<Verdict | "off", string>>>> = {
  sync: { missing: "Not synced", repair: "Out of date", extra: "Left over" },
  review: { conflict: "Conflict", blocked: "Blocked", unmanaged: "Not managed" },
};

export interface Problem {
  readonly fix: Fix;
  /** The agent it is in, or null when the skill's own library folder is missing. */
  readonly agent: AgentId | null;
  readonly word: string;
}

/** Every problem a skill has, agent by agent in registry order, after a missing library folder. */
export function problemsOf(skill: SkillView): readonly Problem[] {
  const problems: Problem[] = [];
  if (skill.hash === null) problems.push({ fix: "review", agent: null, word: "Folder missing" });
  for (const cell of skill.cells) {
    const fix = FIX[cell.verdict];
    if (fix === undefined) continue;
    problems.push({ fix, agent: cell.agent, word: PROBLEM_WORD[fix][cell.verdict] ?? "" });
  }
  return problems;
}

export interface Pill {
  readonly text: string;
  /** Red when any problem needs a review, orange when a Sync fixes them all. */
  readonly tone: Fix;
}

/** The row's one warning: the problem itself when there is one, otherwise how many there are. */
export function pillOf(problems: readonly Problem[], names: Names): Pill | null {
  const [first] = problems;
  if (first === undefined) return null;
  const tone = problems.some((problem) => problem.fix === "review") ? "review" : "sync";
  if (problems.length > 1) return { text: `${problems.length} problems`, tone };
  return {
    text: first.agent === null ? first.word : `${first.word} in ${names.agent(first.agent)}`,
    tone,
  };
}

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

export interface Note {
  readonly fix: Fix;
  readonly text: string;
}

/** One line per fix for the detail panel, each naming the agents it is about. */
export function notesOf(problems: readonly Problem[], names: Names): readonly Note[] {
  const notes: Note[] = [];
  for (const fix of ["sync", "review"] as const) {
    const words = new Map<string, string[]>();
    for (const problem of problems) {
      if (problem.fix !== fix) continue;
      const where = problem.agent === null ? "the library" : names.agent(problem.agent);
      words.set(problem.word, [...(words.get(problem.word) ?? []), where]);
    }
    if (words.size === 0) continue;
    const text = [...words].map(([word, where]) => `${word} in ${AND.format(where)}`).join(". ");
    notes.push({ fix, text: `${text}.` });
  }
  return notes;
}

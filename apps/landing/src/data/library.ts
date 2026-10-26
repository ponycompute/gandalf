import type { Verdict } from "./status";

/** The agents the page's made-up Mac has, in the app's registry order. */
export const SAMPLE_AGENTS = [
  "claude_code",
  "codex",
  "cursor",
  "gemini_cli",
  "github_copilot",
  "opencode",
] as const;

export type SampleAgent = (typeof SAMPLE_AGENTS)[number];

/** Something wrong with one agent's copy, said as the app says it: a pill on the row, a line in the panel. */
export interface SampleProblem {
  readonly agent: SampleAgent;
  readonly verdict: Verdict;
  /** "change" is a write gandalf will make; "review" needs the user. */
  readonly tone: "change" | "review";
  readonly pill: string;
  readonly line: string;
  readonly action: string;
}

export interface SampleSkill {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly on: readonly SampleAgent[];
  readonly problem?: SampleProblem;
}

// A made-up library for the page's screenshots, the one the Library design shows.
export const SAMPLE_LIBRARY: readonly SampleSkill[] = [
  {
    name: "api-client",
    description: "Call the team's internal APIs",
    source: "github.com/acme/agent-skills",
    on: ["claude_code", "cursor"],
  },
  {
    name: "browser-check",
    description: "Drive a browser to verify a change",
    source: "github.com/acme/agent-skills",
    on: ["claude_code", "cursor"],
  },
  {
    name: "deploy-preview",
    description: "Ship a preview build",
    source: "~/src/deploy-preview",
    on: ["claude_code", "codex", "cursor"],
  },
  {
    name: "design-review",
    description: "Critique a screen against the design system",
    source: "~/src/design-review",
    on: ["claude_code", "cursor"],
    problem: {
      agent: "cursor",
      verdict: "repair",
      tone: "change",
      pill: "Edited in Cursor",
      line: "Cursor's copy was edited",
      action: "Review",
    },
  },
  {
    name: "docs-writer",
    description: "Write docs in the house style",
    source: "github.com/acme/agent-skills",
    on: ["claude_code", "codex", "cursor", "gemini_cli", "github_copilot", "opencode"],
  },
  {
    name: "git-hygiene",
    description: "Tidy branches and commits",
    source: "~/src/git-hygiene",
    on: ["claude_code", "cursor"],
    problem: {
      agent: "cursor",
      verdict: "repair",
      tone: "review",
      pill: "Broken link",
      line: "Cursor's link is broken",
      action: "Repair",
    },
  },
  {
    name: "my-notes",
    description: "Personal project notes",
    source: "Adopted from Claude Code",
    on: ["claude_code"],
  },
  {
    name: "pdf-tools",
    description: "Fill and merge PDF forms",
    source: "github.com/anthropics/skills",
    on: ["claude_code", "codex", "cursor"],
  },
  {
    name: "release-notes",
    description: "Draft release notes from merged work",
    source: "~/src/release-notes",
    on: ["claude_code", "cursor"],
  },
  {
    name: "review-pull-request",
    description: "Review a PR against the team checklist",
    source: "github.com/acme/agent-skills",
    on: ["claude_code", "codex", "cursor", "gemini_cli"],
    problem: {
      agent: "gemini_cli",
      verdict: "conflict",
      tone: "review",
      pill: "Not managed in Gemini CLI",
      line: "Gemini CLI has its own review-pull-request",
      action: "Adopt",
    },
  },
  {
    name: "sql-helper",
    description: "Write and explain SQL",
    source: "~/src/sql-helper",
    on: [],
  },
  {
    name: "test-audit",
    description: "Find tests that assert nothing",
    source: "~/src/test-audit",
    on: ["claude_code", "cursor"],
  },
];

/** The verdict the CLI prints for one skill in one agent. */
export function verdictOf(skill: SampleSkill, agent: SampleAgent): Verdict {
  if (skill.problem?.agent === agent) return skill.problem.verdict;
  return skill.on.includes(agent) ? "ok" : "off";
}

/** The toolbar's line under the title, as the app sums up the library. */
export function librarySummary(skills: readonly SampleSkill[]): string {
  const repairs = skills.filter((skill) => skill.problem !== undefined).length;
  return `${skills.length} skills · ${repairs} ${repairs === 1 ? "thing" : "things"} to fix`;
}

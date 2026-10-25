import type { Verdict } from "./status";

export interface SampleSkill {
  readonly name: string;
  readonly description: string;
  /** One verdict per column of AGENT_COLUMNS, in order. */
  readonly cells: readonly Verdict[];
}

export const AGENT_COLUMNS = ["Claude", "Codex", "Cursor", "Gemini", "Copilot"] as const;

// A made-up library for the page's screenshots. The mix shows every verdict at least once.
export const SAMPLE_SKILLS: readonly SampleSkill[] = [
  {
    name: "release-desktop",
    description: "Cut a signed desktop release",
    cells: ["ok", "missing", "missing", "ok", "ok"],
  },
  {
    name: "review-pr",
    description: "Review a pull request our way",
    cells: ["ok", "ok", "ok", "repair", "off"],
  },
  {
    name: "write-migration",
    description: "Safe, reversible schema changes",
    cells: ["ok", "ok", "unmanaged", "ok", "ok"],
  },
  {
    name: "triage-sentry",
    description: "First 15 minutes of an incident",
    cells: ["ok", "conflict", "ok", "off", "ok"],
  },
  {
    name: "pdf-tools",
    description: "Read and fill PDF forms",
    cells: ["ok", "ok", "ok", "ok", "ok"],
  },
  {
    name: "design-tokens",
    description: "Regenerate tokens.css",
    cells: ["ok", "ok", "ok", "ok", "off"],
  },
  {
    name: "oncall-handoff",
    description: "Write the weekly handoff",
    cells: ["ok", "ok", "off", "ok", "ok"],
  },
  {
    name: "changelog",
    description: "Group commits into a changelog",
    cells: ["ok", "ok", "ok", "ok", "ok"],
  },
  {
    name: "bisect-flake",
    description: "Find the commit that broke a test",
    cells: ["ok", "ok", "ok", "extra", "ok"],
  },
  {
    name: "api-client",
    description: "Regenerate the typed API client",
    cells: ["ok", "blocked", "ok", "ok", "ok"],
  },
  {
    name: "copy-review",
    description: "Check UI copy against the voice",
    cells: ["ok", "ok", "ok", "ok", "untouched"],
  },
  {
    name: "perf-trace",
    description: "Profile a slow render",
    cells: ["ok", "ok", "ok", "ok", "ok"],
  },
];

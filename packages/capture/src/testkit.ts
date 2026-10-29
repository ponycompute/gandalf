// Fixture sessions in the shapes Claude Code and Copilot CLI write, seeded into a throwaway HOME.
// Nothing here reads or writes the real one.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const json = (value: unknown) => JSON.stringify(value);

/** Lines of a Claude Code session file, in its event shapes. */
export const claude = {
  prompt: (text: string, at: string, cwd = "/work/app") =>
    json({ type: "user", timestamp: at, cwd, message: { role: "user", content: text } }),
  reply: (text: string, at: string) =>
    json({ type: "assistant", timestamp: at, message: { content: [{ type: "text", text }] } }),
  tool: (name: string, input: Record<string, unknown>, at: string) =>
    json({
      type: "assistant",
      timestamp: at,
      message: { content: [{ type: "tool_use", name, input }] },
    }),
  result: (text: string, at: string) =>
    json({
      type: "user",
      timestamp: at,
      message: { content: [{ type: "tool_result", content: text }] },
    }),
  meta: (text: string, at: string) =>
    json({ type: "user", timestamp: at, isMeta: true, message: { content: text } }),
  reminder: (at: string) =>
    json({
      type: "user",
      timestamp: at,
      message: { content: "<system-reminder>x</system-reminder>" },
    }),
  snapshot: (at: string) => json({ type: "file-history-snapshot", timestamp: at, snapshot: {} }),
};

/** Lines of a Copilot CLI events.jsonl, in its event shapes. */
export const copilot = {
  start: (at: string, cwd = "/work/app") =>
    json({ type: "session.start", timestamp: at, data: { startTime: at, context: { cwd } } }),
  prompt: (text: string, at: string) =>
    json({ type: "user.message", timestamp: at, data: { content: text } }),
  reply: (text: string, at: string) =>
    json({ type: "assistant.message", timestamp: at, data: { content: text } }),
  tool: (toolName: string, args: Record<string, unknown>, at: string) =>
    json({ type: "tool.execution_start", timestamp: at, data: { toolName, arguments: args } }),
  hook: (at: string) => json({ type: "hook.start", timestamp: at, data: { hookType: "pre" } }),
};

export type FixtureSession =
  | {
      readonly agent: "claude_code";
      /** The folder under ~/.claude/projects, as Claude Code names it from the cwd. */
      readonly folder: string;
      readonly id: string;
      readonly lines: readonly string[];
      /** Subagent sessions written beside it, which are part of this one. */
      readonly subagents?: readonly (readonly string[])[];
    }
  | { readonly agent: "github_copilot"; readonly id: string; readonly lines: readonly string[] };

/** Writes each session where its agent keeps them and returns the file paths, in order. */
export async function seedSessions(
  home: string,
  sessions: readonly FixtureSession[],
): Promise<string[]> {
  const files: string[] = [];
  for (const session of sessions) {
    const body = session.lines.join("\n") + "\n";
    if (session.agent === "claude_code") {
      const dir = join(home, ".claude", "projects", session.folder);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${session.id}.jsonl`);
      await writeFile(file, body);
      for (const [index, lines] of (session.subagents ?? []).entries()) {
        const sub = join(dir, session.id, "subagents");
        await mkdir(sub, { recursive: true });
        await writeFile(join(sub, `agent-${index}.jsonl`), lines.join("\n") + "\n");
      }
      files.push(file);
    } else {
      const dir = join(home, ".copilot", "session-state", session.id);
      await mkdir(dir, { recursive: true });
      const file = join(dir, "events.jsonl");
      await writeFile(file, body);
      files.push(file);
    }
  }
  return files;
}

/** Three Claude Code sessions in two projects and two Copilot CLI sessions, over four days. */
export const MIXED: readonly FixtureSession[] = [
  {
    agent: "claude_code",
    folder: "-work-app",
    id: "c1000000-0000-4000-8000-000000000001",
    lines: [
      claude.snapshot("2026-10-24T09:00:00.000Z"),
      claude.prompt("Release the desktop app", "2026-10-24T09:00:01.000Z"),
      claude.tool("Bash", { command: "npm run dist" }, "2026-10-24T09:00:05.000Z"),
      claude.result("built", "2026-10-24T09:01:00.000Z"),
      claude.reply("The dmg is in release/.", "2026-10-24T09:01:05.000Z"),
    ],
  },
  {
    agent: "claude_code",
    folder: "-work-app",
    id: "c1000000-0000-4000-8000-000000000002",
    lines: [
      claude.reminder("2026-10-26T10:00:00.000Z"),
      claude.prompt("Commit to main without docs/plans", "2026-10-26T10:00:01.000Z"),
      claude.tool("Bash", { command: "git status --short" }, "2026-10-26T10:00:03.000Z"),
      claude.tool("Bash", { command: "git commit -m 'feat: x'" }, "2026-10-26T10:00:09.000Z"),
      claude.reply("Committed.", "2026-10-26T10:00:12.000Z"),
    ],
  },
  {
    agent: "claude_code",
    folder: "-work-site",
    id: "c1000000-0000-4000-8000-000000000003",
    lines: [
      claude.prompt("Fix the FAQ wording", "2026-10-27T08:00:00.000Z", "/work/site"),
      claude.tool("Edit", { file_path: "/work/site/faq.tsx" }, "2026-10-27T08:00:04.000Z"),
      claude.reply("Done.", "2026-10-27T08:00:30.000Z"),
    ],
  },
  {
    agent: "github_copilot",
    id: "a2000000-0000-4000-8000-000000000001",
    lines: [
      copilot.start("2026-10-25T12:00:00.000Z"),
      copilot.hook("2026-10-25T12:00:00.500Z"),
      copilot.prompt("Run the tests", "2026-10-25T12:00:01.000Z"),
      copilot.tool("bash", { command: "npx vitest run" }, "2026-10-25T12:00:02.000Z"),
      copilot.reply("All green.", "2026-10-25T12:00:40.000Z"),
    ],
  },
  {
    agent: "github_copilot",
    id: "a2000000-0000-4000-8000-000000000002",
    lines: [
      copilot.start("2026-10-28T15:00:00.000Z", "/work/site"),
      copilot.prompt("Deploy the landing page", "2026-10-28T15:00:01.000Z"),
      copilot.reply("Deployed.", "2026-10-28T15:02:00.000Z"),
    ],
  },
];

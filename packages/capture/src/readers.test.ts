import { appendFile, chmod, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { openCapture } from "./capture.js";
import { TOOL_DETAIL } from "./readers/reader.js";
import { MIXED, claude, copilot, seedSessions, type FixtureSession } from "./testkit.js";

/** The session with this id, or null when it is not found. */
async function one(home: string, id: string) {
  const lookup = await openCapture(home).session(id);
  return lookup.kind === "found" ? lookup.session : null;
}

async function tempHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "gandalf-capture-")));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  return home;
}

describe("Claude Code sessions", () => {
  it("reads prompts, replies and tools in order, leaving out results and app text", async () => {
    const home = await tempHome();
    await seedSessions(home, [MIXED[1]!]);
    const session = await one(home, "c1000000-0000-4000-8000-000000000002");
    expect(session).toMatchObject({
      agent: "claude_code",
      cwd: "/work/app",
      startedAt: "2026-10-26T10:00:01.000Z",
      endedAt: "2026-10-26T10:00:12.000Z",
      skippedLines: 0,
    });
    expect(session?.turns).toEqual([
      { kind: "prompt", at: "2026-10-26T10:00:01.000Z", text: "Commit to main without docs/plans" },
      { kind: "tool", at: "2026-10-26T10:00:03.000Z", name: "Bash", detail: "git status --short" },
      {
        kind: "tool",
        at: "2026-10-26T10:00:09.000Z",
        name: "Bash",
        detail: "git commit -m 'feat: x'",
      },
      { kind: "reply", at: "2026-10-26T10:00:12.000Z", text: "Committed." },
    ]);
  });

  it("leaves out meta lines and tool results", async () => {
    const home = await tempHome();
    await seedSessions(home, [
      {
        agent: "claude_code",
        folder: "-work-app",
        id: "meta",
        lines: [
          claude.meta("Caveat: the messages below were generated", "2026-10-24T09:00:00.000Z"),
          claude.prompt("Real prompt", "2026-10-24T09:00:01.000Z"),
          claude.result("output", "2026-10-24T09:00:02.000Z"),
        ],
      },
    ]);
    const session = await one(home, "meta");
    expect(session?.turns.map((turn) => turn.kind)).toEqual(["prompt"]);
  });

  it("counts a session once, not its subagents", async () => {
    const home = await tempHome();
    await seedSessions(home, [
      {
        ...(MIXED[0]! as Extract<FixtureSession, { agent: "claude_code" }>),
        subagents: [[claude.prompt("Subagent task", "2026-10-24T09:00:03.000Z")]],
      },
    ]);
    const { sessions } = await openCapture(home).sessions();
    expect(sessions.map((session) => session.id)).toEqual(["c1000000-0000-4000-8000-000000000001"]);
    expect(sessions[0]?.prompts).toBe(1);
  });

  it("skips and counts a torn last line, keeping the turns before it", async () => {
    const home = await tempHome();
    const [file] = await seedSessions(home, [MIXED[0]!]);
    await appendFile(file!, '{"type":"assistant","timestamp":"2026-10-24T09:02:00.000Z","mess');
    const { sessions } = await openCapture(home).sessions();
    expect(sessions[0]).toMatchObject({ prompts: 1, replies: 1, tools: 1, skippedLines: 1 });
  });

  it("keeps the tool input that names what it ran on, cut short", async () => {
    const home = await tempHome();
    await seedSessions(home, [
      {
        agent: "claude_code",
        folder: "-work-app",
        id: "long",
        lines: [
          claude.tool("Bash", { command: "x".repeat(1000) }, "2026-10-24T09:00:00.000Z"),
          claude.tool("Grep", { glob: "*.ts", pattern: "TODO" }, "2026-10-24T09:00:01.000Z"),
        ],
      },
    ]);
    const session = await one(home, "long");
    expect(session?.turns.map((turn) => (turn.kind === "tool" ? turn.detail : ""))).toEqual([
      "x".repeat(TOOL_DETAIL),
      "TODO",
    ]);
  });
});

describe("Copilot CLI sessions", () => {
  it("reads the same shape from events.jsonl, with the cwd from session.start", async () => {
    const home = await tempHome();
    await seedSessions(home, [MIXED[3]!]);
    const session = await one(home, "a2000000-0000-4000-8000-000000000001");
    expect(session).toMatchObject({
      agent: "github_copilot",
      cwd: "/work/app",
      startedAt: "2026-10-25T12:00:00.000Z",
      endedAt: "2026-10-25T12:00:40.000Z",
    });
    expect(session?.turns).toEqual([
      { kind: "prompt", at: "2026-10-25T12:00:01.000Z", text: "Run the tests" },
      { kind: "tool", at: "2026-10-25T12:00:02.000Z", name: "bash", detail: "npx vitest run" },
      { kind: "reply", at: "2026-10-25T12:00:40.000Z", text: "All green." },
    ]);
  });

  it("ignores hooks and keeps Korean text byte for byte", async () => {
    const home = await tempHome();
    await seedSessions(home, [
      {
        agent: "github_copilot",
        id: "ko",
        lines: [
          copilot.hook("2026-10-25T12:00:00.000Z"),
          copilot.prompt("다음 해야할거 뭐야?", "2026-10-25T12:00:01.000Z"),
        ],
      },
    ]);
    const session = await one(home, "ko");
    expect(session?.turns).toEqual([
      { kind: "prompt", at: "2026-10-25T12:00:01.000Z", text: "다음 해야할거 뭐야?" },
    ]);
  });
});

describe("listing", () => {
  it("lists every agent's sessions newest first, with counts in place of turns", async () => {
    const home = await tempHome();
    await seedSessions(home, MIXED);
    const { sessions, problems } = await openCapture(home).sessions();
    expect(problems).toEqual([]);
    expect(sessions.map((session) => [session.agent, session.startedAt])).toEqual([
      ["github_copilot", "2026-10-28T15:00:00.000Z"],
      ["claude_code", "2026-10-27T08:00:00.000Z"],
      ["claude_code", "2026-10-26T10:00:01.000Z"],
      ["github_copilot", "2026-10-25T12:00:00.000Z"],
      ["claude_code", "2026-10-24T09:00:01.000Z"],
    ]);
    expect(sessions[0]).not.toHaveProperty("turns");
  });

  it("filters by agent and by start time", async () => {
    const home = await tempHome();
    await seedSessions(home, MIXED);
    const capture = openCapture(home);
    const copilotOnly = await capture.sessions({ agent: "github_copilot" });
    expect(copilotOnly.sessions.every((session) => session.agent === "github_copilot")).toBe(true);
    expect(copilotOnly.sessions).toHaveLength(2);
    const recent = await capture.sessions({ since: new Date("2026-10-26T00:00:00.000Z") });
    expect(recent.sessions).toHaveLength(3);
  });

  it("reports an unreadable file and lists the rest", async () => {
    const home = await tempHome();
    const [file] = await seedSessions(home, MIXED);
    await chmod(file!, 0o000);
    onTestFinished(() => chmod(file!, 0o644));
    const { sessions, problems } = await openCapture(home).sessions();
    expect(sessions).toHaveLength(4);
    expect(problems).toEqual([{ agent: "claude_code", file, code: "EACCES" }]);
  });

  it("finds nothing in an empty HOME", async () => {
    const home = await tempHome();
    expect(await openCapture(home).sessions()).toEqual({ sessions: [], problems: [] });
    expect(await one(home, "missing")).toBeNull();
  });
});

describe("what counts as work", () => {
  it("reads a slash command back as typed, and leaves out a scheduled task's text", async () => {
    const home = await tempHome();
    await seedSessions(home, [
      {
        agent: "claude_code",
        folder: "-work-app",
        id: "commands",
        lines: [
          claude.prompt(
            "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-opus-5-5</command-args>",
            "2026-10-24T09:00:00.000Z",
          ),
          claude.prompt(
            "<command-message>review</command-message>\n<command-name>/review</command-name>",
            "2026-10-24T09:00:01.000Z",
          ),
          claude.prompt(
            '<scheduled-task name="daily">This is an automated run</scheduled-task>',
            "2026-10-24T09:00:02.000Z",
          ),
        ],
      },
    ]);
    const session = await one(home, "commands");
    expect(session?.turns.map((turn) => (turn.kind === "prompt" ? turn.text : ""))).toEqual([
      "/model claude-opus-5-5",
      "/review",
    ]);
  });

  it("does not list a file of bookkeeping alone", async () => {
    const home = await tempHome();
    await seedSessions(home, [
      MIXED[0]!,
      {
        agent: "claude_code",
        folder: "-work-app",
        id: "empty",
        lines: [claude.snapshot("2026-10-25T09:00:00.000Z")],
      },
    ]);
    const { sessions } = await openCapture(home).sessions();
    expect(sessions.map((session) => session.id)).toEqual(["c1000000-0000-4000-8000-000000000001"]);
  });
});

describe("reading files", () => {
  it("keeps a line longer than a read chunk whole, multibyte text included", async () => {
    const home = await tempHome();
    const long = "가".repeat(1_500_000);
    await seedSessions(home, [
      {
        agent: "claude_code",
        folder: "-work-app",
        id: "long-line",
        lines: [
          claude.prompt(long, "2026-10-24T09:00:00.000Z"),
          claude.prompt("after", "2026-10-24T09:00:01.000Z"),
        ],
      },
    ]);
    const session = await one(home, "long-line");
    expect(session?.turns.map((turn) => (turn.kind === "prompt" ? turn.text : ""))).toEqual([
      long,
      "after",
    ]);
  });
});

describe("text the app sent in the user's place", () => {
  it("keeps what the user typed after the app's blocks, in a string or in text blocks", async () => {
    const home = await tempHome();
    const user = (content: unknown, at: string) =>
      JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content } });
    await seedSessions(home, [
      {
        agent: "claude_code",
        folder: "-work-app",
        id: "blocks",
        lines: [
          user(
            [
              { type: "text", text: "<ide_opened_file>The user opened x.ts</ide_opened_file>" },
              { type: "text", text: "Fix the bug in x.ts" },
            ],
            "2026-10-24T09:00:00.000Z",
          ),
          user(
            '<artifact-view-context url="u">viewing</artifact-view-context>\n<system-reminder>r</system-reminder>\nShip it',
            "2026-10-24T09:00:01.000Z",
          ),
          user("<!-- reply 1 -->\nYes, go", "2026-10-24T09:00:02.000Z"),
          user("[Request interrupted by user for tool use]", "2026-10-24T09:00:03.000Z"),
          user("<ide_selection>only a selection</ide_selection>", "2026-10-24T09:00:04.000Z"),
          user(
            '<pasted_content id="4185">a log</pasted_content id="4185">\nWhy does this fail?',
            "2026-10-24T09:00:05.000Z",
          ),
          user("<b>bold</b> is what I want", "2026-10-24T09:00:06.000Z"),
          user(
            "<bash-input>git status</bash-input><bash-stdout>On branch main</bash-stdout>",
            "2026-10-24T09:00:07.000Z",
          ),
          user(
            "<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>",
            "2026-10-24T09:00:08.000Z",
          ),
          user(
            [
              '<wake reason="mention">',
              '  <thread><message from="human">earlier</message>',
              '  <message trigger="true" from="human" mention="true">로컬에서 테스트 해봐</message>',
              "  </thread>",
              "</wake>",
            ].join("\n"),
            "2026-10-24T09:00:09.000Z",
          ),
          user(
            '<relay from="coordinator">\n  <note>Run the tests</note>\n</relay>',
            "2026-10-24T09:00:10.000Z",
          ),
        ],
      },
    ]);
    const session = await one(home, "blocks");
    expect(session?.turns.map((turn) => (turn.kind === "prompt" ? turn.text : ""))).toEqual([
      "Fix the bug in x.ts",
      "Ship it",
      "Yes, go",
      "Why does this fail?",
      "<b>bold</b> is what I want",
      "!git status",
      "로컬에서 테스트 해봐",
    ]);
  });

  it("leaves out Copilot messages from agents and skills, and subagent work", async () => {
    const home = await tempHome();
    const event = (type: string, data: Record<string, unknown>, at: string) =>
      JSON.stringify({ type, timestamp: at, data });
    await seedSessions(home, [
      {
        agent: "github_copilot",
        id: "sources",
        lines: [
          copilot.start("2026-10-25T12:00:00.000Z"),
          copilot.prompt("Review the diff", "2026-10-25T12:00:01.000Z"),
          event(
            "user.message",
            { content: "Read-only analysis of x", source: "agent-54785a" },
            "2026-10-25T12:00:02.000Z",
          ),
          event(
            "user.message",
            { content: "Skill text", source: "skill-aspire" },
            "2026-10-25T12:00:03.000Z",
          ),
          event(
            "tool.execution_start",
            { toolName: "grep", arguments: { pattern: "x" }, parentToolCallId: "call-1" },
            "2026-10-25T12:00:04.000Z",
          ),
          event(
            "assistant.message",
            { content: "Subagent says", parentToolCallId: "call-1" },
            "2026-10-25T12:00:05.000Z",
          ),
          event("user.message", { content: "Thanks", source: "user" }, "2026-10-25T12:00:06.000Z"),
        ],
      },
    ]);
    const session = await one(home, "sources");
    expect(
      session?.turns.map(
        (turn) => turn.kind + ":" + (turn.kind === "tool" ? turn.name : turn.text),
      ),
    ).toEqual(["prompt:Review the diff", "prompt:Thanks"]);
  });
});

describe("folders and files that cannot be read", () => {
  it("reports an unreadable project folder and lists the other folders' sessions", async () => {
    const home = await tempHome();
    await seedSessions(home, MIXED);
    const folder = join(home, ".claude/projects/-work-site");
    await chmod(folder, 0o000);
    onTestFinished(() => chmod(folder, 0o755));
    const { sessions, problems } = await openCapture(home).sessions({ agent: "claude_code" });
    expect(sessions).toHaveLength(2);
    expect(problems).toEqual([{ agent: "claude_code", file: folder, code: "EACCES" }]);
  });

  it("reports an unreadable Copilot session folder", async () => {
    const home = await tempHome();
    await seedSessions(home, MIXED);
    const folder = join(home, ".copilot/session-state/a2000000-0000-4000-8000-000000000001");
    await chmod(folder, 0o000);
    onTestFinished(() => chmod(folder, 0o755));
    const { sessions, problems } = await openCapture(home).sessions({ agent: "github_copilot" });
    expect(sessions).toHaveLength(1);
    expect(problems).toEqual([{ agent: "github_copilot", file: folder, code: "EACCES" }]);
  });

  it("says a session it cannot read is unreadable, not missing", async () => {
    const home = await tempHome();
    const [file] = await seedSessions(home, [MIXED[0]!]);
    await chmod(file!, 0o000);
    onTestFinished(() => chmod(file!, 0o644));
    expect(await openCapture(home).session("c1000000-0000-4000-8000-000000000001")).toEqual({
      kind: "unreadable",
      problem: { agent: "claude_code", file, code: "EACCES" },
    });
  });

  it("lists and shows one copy, the one whose work ran last, when an id is in two folders", async () => {
    const home = await tempHome();
    const id = "c1000000-0000-4000-8000-00000000000d";
    const [latest, earlier] = await seedSessions(home, [
      {
        agent: "claude_code",
        folder: "-work-a",
        id,
        lines: [claude.prompt("new", "2026-10-25T09:00:00.000Z")],
      },
      {
        agent: "claude_code",
        folder: "-work-b",
        id,
        lines: [claude.prompt("old", "2026-10-24T09:00:00.000Z")],
      },
    ]);
    // The copy with the earlier work was written to disk last, so a rule by file time would pick it.
    await utimes(latest!, new Date("2026-10-25T10:00:00Z"), new Date("2026-10-25T10:00:00Z"));
    await utimes(earlier!, new Date("2026-10-26T10:00:00Z"), new Date("2026-10-26T10:00:00Z"));
    const { sessions } = await openCapture(home).sessions();
    expect(sessions.map((session) => session.file)).toEqual([latest]);
    expect((await one(home, id))?.file).toBe(latest);
  });
});

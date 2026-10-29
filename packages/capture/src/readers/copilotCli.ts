// GitHub Copilot CLI keeps a folder per session under ~/.copilot/session-state/<session>/, with
// events.jsonl as its log: a line per event, `{ type, data, timestamp }`. Hooks, turn markers and
// model bookkeeping outnumber the work; only these events carry it.

import { basename, dirname, join } from "node:path";
import {
  SessionDraft,
  entries,
  stringOr,
  toolDetail,
  torn,
  type SessionReader,
  type Unreadable,
} from "./reader.js";

const WORK = ["session.start", "user.message", "assistant.message", "tool.execution_start"];
const MARKERS = WORK.map((type) => `"type":"${type}"`);

export const copilotCli: SessionReader = {
  agent: "github_copilot",
  async files(home) {
    const root = join(home, ".copilot", "session-state");
    const unreadable: Unreadable[] = [];
    const sessions = (await entries(root, unreadable)).filter((entry) => entry.isDirectory());
    const files = await Promise.all(
      sessions.map(async (session) =>
        (await entries(join(root, session.name), unreadable)).some(
          (entry) => entry.name === "events.jsonl",
        )
          ? [join(root, session.name, "events.jsonl")]
          : [],
      ),
    );
    return { files: files.flat(), unreadable };
  },
  idOf: (file) => basename(dirname(file)),
  async parse(lines) {
    const draft = new SessionDraft();
    for await (const line of lines) {
      if (line.trim() === "") continue;
      if (!MARKERS.some((marker) => line.includes(marker))) {
        if (torn(line)) draft.skippedLines += 1;
        continue;
      }
      let event: { type?: unknown; timestamp?: unknown; data?: Record<string, unknown> };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        draft.skippedLines += 1;
        continue;
      }
      const at = stringOr(event.timestamp);
      const data = event.data ?? {};
      // A subagent's work rides in its parent's log under the tool call that started it; it is
      // part of that call, as Claude Code's subagents are part of their parent session.
      if (data.parentToolCallId !== undefined && data.parentToolCallId !== null) continue;
      switch (event.type) {
        case "session.start":
          draft.cwd ??= stringOr((data.context as Record<string, unknown> | undefined)?.cwd);
          draft.seen(stringOr(data.startTime) ?? at);
          break;
        case "user.message": {
          // Other sources are text the CLI sent in the user's place: an agent's briefing, a
          // skill's or an instruction file's text, autopilot, the system.
          const source = data.source ?? "user";
          const text = stringOr(data.content)?.trim() ?? "";
          if (source === "user" && text !== "" && !text.startsWith("<"))
            draft.add({ kind: "prompt", at, text });
          break;
        }
        case "assistant.message": {
          const text = stringOr(data.content)?.trim() ?? "";
          if (text !== "") draft.add({ kind: "reply", at, text });
          break;
        }
        case "tool.execution_start":
          draft.add({
            kind: "tool",
            at,
            name: stringOr(data.toolName) ?? "tool",
            detail: toolDetail(data.arguments),
          });
          break;
      }
    }
    return draft.done();
  },
};

// Claude Code writes one JSONL file per session under ~/.claude/projects/<folder>/<session>.jsonl,
// a line per event. Only user and assistant lines carry the work; the rest are bookkeeping, such as
// file snapshots, titles and request blobs that repeat the same turns. Subagent sessions live in
// <session>/subagents/ and are part of their parent's work, so they are not listed on their own.

import { basename, join } from "node:path";
import {
  SessionDraft,
  entries,
  stringOr,
  toolDetail,
  torn,
  type SessionReader,
  type Unreadable,
} from "./reader.js";

const WORK = ['"type":"user"', '"type":"assistant"'];

/**
 * A block the app puts before what the user typed: the file open in the IDE, the artifact in view,
 * a reminder, pasted material. Comments too, such as `<!-- reply 1 -->`. The app's tag names join
 * words with `-` or `_`, which keeps HTML the user typed, such as `<b>`, out of it. A paste's
 * closing tag repeats its id, as in `</pasted_content id="4185">`.
 */
const LEADING_BLOCK =
  /^\s*(?:<!--[\s\S]*?-->|<([a-z]+[-_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1(?:\s[^>]*)?>)/;

/** Text that opens with one of the app's tags, such as a block it never closed. */
const APP_TAG = /^<(?:!--|[a-z]+[-_])/;

/** A message that is one element end to end, such as a note relayed from another session. */
const WHOLE_ELEMENT = /^<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/;

/** A channel wake quotes the thread; the message that woke the agent is the user's request. */
const WAKE_MESSAGE = /<message(\s[^>]*)>([\s\S]*?)<\/message>/g;

/** A shell command the user ran from the prompt; its output follows in the same text. */
const SHELL_INPUT = /^\s*<bash-input>([\s\S]*?)<\/bash-input>/;

/** The app's line when the user stopped a turn; it is not a request. */
const INTERRUPTED = "[Request interrupted by user";

/**
 * What the user typed, without the blocks the app put before it. A slash command and a shell
 * command arrive as tags and read back as typed, `/model opus` and `!git status`. Text that is the
 * app's alone, such as a scheduled task's run or a command's output, is none.
 */
function typed(text: string): string | null {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (command !== undefined) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
    return args === "" ? command : `${command} ${args}`;
  }
  const shell = SHELL_INPUT.exec(text)?.[1]?.trim();
  if (shell !== undefined) return shell === "" ? null : `!${shell}`;
  let rest = text;
  for (let block = LEADING_BLOCK.exec(rest); block !== null; block = LEADING_BLOCK.exec(rest))
    rest = rest.slice(block[0].length);
  rest = rest.trim();
  const whole = WHOLE_ELEMENT.exec(rest)?.[1];
  if (whole === "wake") {
    const asked = [...rest.matchAll(WAKE_MESSAGE)]
      .filter(
        ([, attributes]) =>
          /\bfrom="human"/.test(attributes!) && /\btrigger="true"/.test(attributes!),
      )
      .map(([, , words]) => words!.trim());
    return asked.length === 0 ? null : asked.join("\n");
  }
  return rest === "" || whole !== undefined || APP_TAG.test(rest) || rest.startsWith(INTERRUPTED)
    ? null
    : rest;
}

export const claudeCode: SessionReader = {
  agent: "claude_code",
  async files(home) {
    const projects = join(home, ".claude", "projects");
    const unreadable: Unreadable[] = [];
    const folders = (await entries(projects, unreadable)).filter((entry) => entry.isDirectory());
    const files = await Promise.all(
      folders.map(async (folder) =>
        (await entries(join(projects, folder.name), unreadable))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => join(projects, folder.name, entry.name)),
      ),
    );
    return { files: files.flat(), unreadable };
  },
  idOf: (file) => basename(file, ".jsonl"),
  async parse(lines) {
    const draft = new SessionDraft();
    for await (const line of lines) {
      if (line.trim() === "") continue;
      if (!WORK.some((marker) => line.includes(marker))) {
        if (torn(line)) draft.skippedLines += 1;
        continue;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        draft.skippedLines += 1;
        continue;
      }
      if (event.isMeta === true || event.isCompactSummary === true || event.isSidechain === true)
        continue;
      const at = stringOr(event.timestamp);
      draft.cwd ??= stringOr(event.cwd);
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (event.type === "user") {
        const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
        // A tool result rides in a user line too; it is the agent's work, not a prompt.
        if (blocks.some((block) => block.type === "tool_result")) continue;
        // The app's blocks may be text blocks of their own, before the one the user typed.
        const texts =
          typeof content === "string"
            ? [content]
            : blocks.flatMap((block) => (block.type === "text" ? [String(block.text)] : []));
        const prompt = texts.flatMap((text) => typed(text) ?? []).join("\n");
        if (prompt !== "") draft.add({ kind: "prompt", at, text: prompt });
      } else if (event.type === "assistant" && Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
            draft.add({ kind: "reply", at, text: block.text.trim() });
          if (block.type === "tool_use")
            draft.add({
              kind: "tool",
              at,
              name: String(block.name),
              detail: toolDetail(block.input),
            });
        }
      }
    }
    return draft.done();
  },
};

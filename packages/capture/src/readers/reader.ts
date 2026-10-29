import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { AgentId } from "@gandalf/skills";
import type { Session, Turn } from "../types.js";

/** What a reader makes of one file; the registry adds the agent, the id and the path. */
export type Parsed = Omit<Session, "agent" | "id" | "file">;

/** A file or folder gandalf found but could not read, with its errno code, such as EACCES. */
export interface Unreadable {
  readonly file: string;
  readonly code: string;
}

export interface Found {
  readonly files: readonly string[];
  readonly unreadable: readonly Unreadable[];
}

/** One agent's session files: where they live and how one reads. */
export interface SessionReader {
  readonly agent: AgentId;
  /** Every session file under `home`, and the folders on the way that could not be read. */
  files(home: string): Promise<Found>;
  idOf(file: string): string;
  parse(lines: AsyncIterable<string>): Promise<Parsed>;
}

export function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "EIO";
}

/** A folder's entries, or none when it is missing. One that cannot be read is noted in `unreadable`. */
export async function entries(dir: string, unreadable: Unreadable[]): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = codeOf(error);
    if (code !== "ENOENT") unreadable.push({ file: dir, code });
    return [];
  }
}

/** How much of a tool's input a turn keeps: enough to say what it ran on. */
export const TOOL_DETAIL = 300;

/** The input field that names what a tool ran on, in the order agents' tools use them. */
const DETAIL_FIELDS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
] as const;

export function toolDetail(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  const named = DETAIL_FIELDS.map((field) => fields[field]).find(
    (value): value is string => typeof value === "string" && value !== "",
  );
  return (named ?? JSON.stringify(input)).slice(0, TOOL_DETAIL);
}

/**
 * A line worth parsing ends its JSON object. One that does not was cut short, as the last line of
 * a file an agent was writing when it crashed.
 */
export function torn(line: string): boolean {
  return !line.trimEnd().endsWith("}");
}

/** Builds a Parsed as lines arrive: turns in order, the first cwd, and the span of times seen. */
export class SessionDraft {
  cwd: string | null = null;
  skippedLines = 0;
  private readonly turns: Turn[] = [];
  private first: string | null = null;
  private last: string | null = null;

  seen(at: string | null): void {
    if (at === null) return;
    if (this.first === null || at < this.first) this.first = at;
    if (this.last === null || at > this.last) this.last = at;
  }

  add(turn: Turn): void {
    this.turns.push(turn);
    this.seen(turn.at);
  }

  done(): Parsed {
    return {
      cwd: this.cwd,
      startedAt: this.first,
      endedAt: this.last,
      turns: this.turns,
      skippedLines: this.skippedLines,
    };
  }
}

export function stringOr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A file's lines, streamed, so a session larger than a string can hold still reads. A line longer
 * than a chunk, such as a tool call that wrote a whole file, is joined once at its end; growing it
 * chunk by chunk copies it over and over.
 */
export async function* fileLines(file: string): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending: string[] = [];
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    const parts = decoder.write(chunk as Buffer).split("\n");
    const last = parts.pop() ?? "";
    if (parts.length > 0) {
      pending.push(parts[0] ?? "");
      yield pending.join("");
      for (let index = 1; index < parts.length; index += 1) yield parts[index] ?? "";
      pending = [];
    }
    pending.push(last);
  }
  pending.push(decoder.end());
  const rest = pending.join("");
  if (rest !== "") yield rest;
}

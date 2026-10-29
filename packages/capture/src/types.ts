import type { AgentId } from "@gandalf/skills";

/**
 * One step of a session, as the work reads: what the user asked, what the agent said, and which
 * tool it ran on what. Tool results and the agent's reasoning are left out; they are most of a
 * session's bytes and say little about the task.
 */
export type Turn =
  | { readonly kind: "prompt"; readonly at: string | null; readonly text: string }
  | { readonly kind: "reply"; readonly at: string | null; readonly text: string }
  | {
      readonly kind: "tool";
      readonly at: string | null;
      readonly name: string;
      /** The command, path or query the tool ran on, cut to TOOL_DETAIL characters. */
      readonly detail: string;
    };

/** One coding-agent session read from its file. Times are the ISO strings the agent wrote. */
export interface Session {
  readonly agent: AgentId;
  readonly id: string;
  readonly file: string;
  /** The folder the agent worked in, or null when the file never says. */
  readonly cwd: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly turns: readonly Turn[];
  /** Lines that were not JSON, such as a last line torn by a crash. */
  readonly skippedLines: number;
}

/** A session as `gandalf sessions` lists it: counts in place of the turns. */
export interface SessionInfo extends Omit<Session, "turns"> {
  readonly prompts: number;
  readonly replies: number;
  readonly tools: number;
}

/** A session file gandalf found but could not read. */
export interface ReadProblem {
  readonly agent: AgentId;
  readonly file: string;
  /** The errno code, such as EACCES. */
  readonly code: string;
}

export interface SessionList {
  /** Newest first. */
  readonly sessions: readonly SessionInfo[];
  readonly problems: readonly ReadProblem[];
}

/** One session looked up by id. */
export type SessionLookup =
  | { readonly kind: "found"; readonly session: Session }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly problem: ReadProblem };

export interface ListOptions {
  readonly agent?: AgentId;
  /** Only sessions that started at or after this time. */
  readonly since?: Date;
}

// Reading coding-agent sessions off disk. Read-only: nothing here opens a file for writing, so
// listing sessions can never change what an agent keeps.

import { stat } from "node:fs/promises";
import { codeOf, fileLines, type SessionReader } from "./readers/reader.js";
import { READERS } from "./readers/registry.js";
import type {
  ListOptions,
  ReadProblem,
  Session,
  SessionInfo,
  SessionList,
  SessionLookup,
} from "./types.js";

export interface Capture {
  sessions(options?: ListOptions): Promise<SessionList>;
  session(id: string): Promise<SessionLookup>;
}

/** How many session files are read at once. */
const PARALLEL = 8;

async function inBatches<T, R>(items: readonly T[], each: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += PARALLEL)
    results.push(...(await Promise.all(items.slice(start, start + PARALLEL).map(each))));
  return results;
}

async function read(reader: SessionReader, file: string): Promise<Session> {
  const parsed = await reader.parse(fileLines(file));
  return { agent: reader.agent, id: reader.idOf(file), file, ...parsed };
}

function info({ turns, ...session }: Session): SessionInfo {
  const count = (kind: Session["turns"][number]["kind"]) =>
    turns.filter((turn) => turn.kind === kind).length;
  return { ...session, prompts: count("prompt"), replies: count("reply"), tools: count("tool") };
}

/** Newest first; a session with no times sorts last. */
function newestFirst(a: SessionInfo, b: SessionInfo): number {
  return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
}

/**
 * Claude Code can leave one session in two project folders. The copy whose work ran latest is the
 * session as it stands, for the list and for `session(id)` alike.
 */
function latest<S extends { readonly endedAt: string | null }>(copies: readonly S[]): S {
  return copies.reduce((best, copy) => ((copy.endedAt ?? "") > (best.endedAt ?? "") ? copy : best));
}

export function openCapture(home: string, readers: readonly SessionReader[] = READERS): Capture {
  return {
    async sessions(options = {}) {
      const copies = new Map<string, SessionInfo[]>();
      const problems: ReadProblem[] = [];
      const since = options.since?.toISOString();
      for (const reader of readers) {
        if (options.agent !== undefined && reader.agent !== options.agent) continue;
        const found = await reader.files(home);
        problems.push(...found.unreadable.map((entry) => ({ agent: reader.agent, ...entry })));
        const readOne = async (file: string): Promise<SessionInfo | null> => {
          try {
            // A file last written before `since` cannot hold a session that started after it.
            if (options.since !== undefined && (await stat(file)).mtime < options.since)
              return null;
            return info(await read(reader, file));
          } catch (error) {
            problems.push({ agent: reader.agent, file, code: codeOf(error) });
            return null;
          }
        };
        for (const session of await inBatches(found.files, readOne)) {
          // A file of bookkeeping alone, such as a session opened and closed, holds no work.
          if (session === null || session.prompts + session.replies + session.tools === 0) continue;
          if (since !== undefined && (session.startedAt === null || session.startedAt < since))
            continue;
          const key = `${session.agent}:${session.id}`;
          copies.set(key, [...(copies.get(key) ?? []), session]);
        }
      }
      return { sessions: [...copies.values()].map(latest).sort(newestFirst), problems };
    },
    async session(id) {
      for (const reader of readers) {
        const matches = (await reader.files(home)).files.filter((file) => reader.idOf(file) === id);
        if (matches.length === 0) continue;
        const sessions: Session[] = [];
        for (const file of matches) {
          try {
            sessions.push(await read(reader, file));
          } catch (error) {
            return {
              kind: "unreadable",
              problem: { agent: reader.agent, file, code: codeOf(error) },
            };
          }
        }
        return { kind: "found", session: latest(sessions) };
      }
      return { kind: "missing" };
    },
  };
}

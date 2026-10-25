import {
  GitError,
  InputError,
  StateCorruptError,
  openGandalf,
  type Env,
  type Snapshot,
} from "@gandalf/skills";
import type { AppError, Result } from "../shared/ipc";

export interface GandalfService {
  snapshot(): Promise<Result<Snapshot>>;
}

export function openService(env: Env): GandalfService {
  const gandalf = openGandalf(env);
  return { snapshot: () => settle(env.home, () => gandalf.snapshot()) };
}

export function toAppError(error: unknown, home: string): AppError {
  if (error instanceof StateCorruptError) {
    return { kind: "stateCorrupt", path: tilde(error.path, home), reason: error.reason };
  }
  if (error instanceof InputError) {
    return { kind: "badInput", field: error.field, message: error.message };
  }
  if (error instanceof GitError) return { kind: "git", message: error.message };
  return { kind: "internal", message: error instanceof Error ? error.message : String(error) };
}

export async function settle<T>(home: string, work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: toAppError(error, home) };
  }
}

function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

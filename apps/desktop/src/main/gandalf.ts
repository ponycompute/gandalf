import {
  GitError,
  InputError,
  StateCorruptError,
  openGandalf,
  parseIntent,
  parsePlanToken,
  type ApplyOutcome,
  type Env,
  type PlanOutcome,
  type Snapshot,
} from "@gandalf/skills";
import type { AppError, Result } from "../shared/ipc";

/** Takes the renderer's payloads as unknown: they are parsed here, before they reach Gandalf. */
export interface GandalfService {
  snapshot(): Promise<Result<Snapshot>>;
  plan(intent: unknown): Promise<Result<PlanOutcome>>;
  apply(token: unknown): Promise<Result<ApplyOutcome>>;
}

export function openService(env: Env): GandalfService {
  const gandalf = openGandalf(env);
  return {
    snapshot: () => settle(() => gandalf.snapshot()),
    plan: (intent) => settle(() => gandalf.plan(parseIntent(intent))),
    apply: (token) => settle(() => gandalf.apply(parsePlanToken(token))),
  };
}

export function toAppError(error: unknown): AppError {
  if (error instanceof StateCorruptError) {
    return { kind: "stateCorrupt", path: error.path, reason: error.reason };
  }
  if (error instanceof InputError) {
    return { kind: "badInput", field: error.field, message: error.message };
  }
  if (error instanceof GitError) return { kind: "git", message: error.message };
  return { kind: "internal", message: error instanceof Error ? error.message : String(error) };
}

export async function settle<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: toAppError(error) };
  }
}

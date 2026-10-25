import type { ApplyOutcome, PlanOutcome, Snapshot } from "@gandalf/skills";

export type AppError =
  /** `message` is the whole sentence and already starts with `field`, so show it alone. */
  | { readonly kind: "badInput"; readonly field: string; readonly message: string }
  | { readonly kind: "stateCorrupt"; readonly path: string; readonly reason: string }
  | { readonly kind: "git"; readonly message: string }
  | { readonly kind: "internal"; readonly message: string };

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppError };

/**
 * A plan outcome and `basis`, the content key of the snapshot main read just before planning, so the
 * renderer can tell when the disk moved on from the plan. Null when that read failed.
 */
export type Planned = PlanOutcome & { readonly basis: string | null };

/** What a snapshot shows of the disk and the recorded state. Snapshots with the same key match. */
export function contentKey(snapshot: Snapshot): string {
  const { revision, agents, roots, skills, entries, problems } = snapshot;
  return JSON.stringify([revision, agents, roots, skills, entries, problems]);
}

export interface GandalfApi {
  /** The home directory main runs gandalf against, so the renderer can write paths with ~. */
  readonly home: string;
  snapshot(): Promise<Result<Snapshot>>;
  plan(intent: unknown): Promise<Result<Planned>>;
  apply(token: unknown): Promise<Result<ApplyOutcome>>;
  /**
   * The text of a file straight inside a skill folder the current snapshot shows, at most 1 MB.
   * Anything else is badInput: a `..` path, a file in a subfolder or outside those folders, a
   * folder or file that is a symlink, or anything but a regular file, such as a FIFO.
   */
  readSkillFile(path: unknown): Promise<Result<string>>;
  onSnapshot(listener: (snapshot: Result<Snapshot>) => void): Unsubscribe;
}

export type Unsubscribe = () => void;

export const channels = {
  snapshot: "gandalf:snapshot",
  plan: "gandalf:plan",
  apply: "gandalf:apply",
  readSkillFile: "gandalf:read-skill-file",
  snapshotPushed: "gandalf:snapshot-pushed",
  watchReduceTransparency: "shell:watch-reduce-transparency",
  reduceTransparency: "shell:reduce-transparency",
} as const;

/** How main hands the home directory to the preload, through webPreferences.additionalArguments. */
export const HOME_ARGUMENT = "--gandalf-home=";

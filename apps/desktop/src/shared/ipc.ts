import type { ApplyOutcome, PlanOutcome, RepoSkillsOutcome, Snapshot } from "@gandalf/skills";

export type AppError =
  /** `message` is the whole sentence and already starts with `field`, so show it alone. */
  | { readonly kind: "badInput"; readonly field: string; readonly message: string }
  | { readonly kind: "stateCorrupt"; readonly path: string; readonly reason: string }
  | { readonly kind: "git"; readonly message: string }
  /** skills.sh or GitHub could not be reached, or answered with something gandalf cannot read. */
  | { readonly kind: "network"; readonly message: string }
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
  const { revision, agents, roots, skills, projects, entries, problems } = snapshot;
  return JSON.stringify([revision, agents, roots, skills, projects, entries, problems]);
}

/** A skills.sh leaderboard: all-time installs, the last 24 hours', or what is climbing now. */
export type Board = "allTime" | "trending" | "hot";

/** A skill as skills.sh lists it. */
export interface MarketSkill {
  /** `source/skillId`, unique on skills.sh. */
  readonly id: string;
  /** Usually a GitHub owner/repo, such as anthropics/skills. */
  readonly source: string;
  /** The skill's name in its repository, which install looks for. */
  readonly skillId: string;
  readonly name: string;
  /** All-time installs in a search or the All Time board; the day's on Trending and Hot. */
  readonly installs: number;
  /** The git URL gandalf installs from, or null when the source is not a GitHub repository. */
  readonly repository: string | null;
  /** The repository's GitHub owner, whose avatar the row shows, or null with no repository. */
  readonly owner: string | null;
}

export interface GandalfApi {
  /** The home directory main runs gandalf against, so the renderer can write paths with ~. */
  readonly home: string;
  /** `home` with its symlinks resolved, such as /private/var/… for /var/…, also written with ~. */
  readonly realHome: string;
  snapshot(): Promise<Result<Snapshot>>;
  plan(intent: unknown): Promise<Result<Planned>>;
  apply(token: unknown): Promise<Result<ApplyOutcome>>;
  /**
   * The text of a file straight inside a skill folder the current snapshot shows, at most 1 MB.
   * Anything else is badInput: a `..` path, a file in a subfolder or outside those folders, a
   * folder or file that is a symlink, or anything but a regular file, such as a FIFO.
   */
  readSkillFile(path: unknown): Promise<Result<string>>;
  /**
   * Cancels every plan main is running: a fetch is killed, and their answers are not wanted. A plan
   * still answers, so the renderer drops what arrives after it cancelled.
   */
  cancelPlan(): Promise<Result<null>>;
  /** Asks for a folder with the system's open panel. Null when the user cancels. */
  chooseFolder(): Promise<Result<string | null>>;
  /**
   * Shows a skill's library folder in Finder. Any other path is badInput: main reveals only a
   * folder straight inside the library that the current snapshot lists.
   */
  revealSkill(dir: unknown): Promise<Result<null>>;
  /** Shows the library folder in Finder. */
  revealLibrary(): Promise<Result<null>>;
  /** Shows a project's folder in Finder. A path that is not one of the projects is badInput. */
  revealProject(path: unknown): Promise<Result<null>>;
  /** Searches skills.sh. A query that is not text, or is blank, is badInput. */
  searchSkillsSh(query: unknown): Promise<Result<readonly MarketSkill[]>>;
  /** A skills.sh leaderboard, kept for a few minutes. */
  skillsShBoard(board: unknown): Promise<Result<readonly MarketSkill[]>>;
  /** A GitHub owner's avatar as a data URL, or null when it cannot be had. */
  ownerAvatar(owner: unknown): Promise<Result<string | null>>;
  /**
   * The skills a git repository holds at `ref` (null for the default branch), fetched into the
   * cache. A repository gandalf cannot fetch answers ok with a badSource refusal.
   */
  repoSkills(repository: {
    readonly url: string;
    readonly ref: string | null;
  }): Promise<Result<RepoSkillsOutcome>>;
  /** Sets the window's light or dark appearance, or "system" to follow the Mac's. */
  setAppearance(appearance: unknown): Promise<Result<null>>;
  onSnapshot(listener: (snapshot: Result<Snapshot>) => void): Unsubscribe;
}

export type Unsubscribe = () => void;

export const channels = {
  snapshot: "gandalf:snapshot",
  plan: "gandalf:plan",
  apply: "gandalf:apply",
  readSkillFile: "gandalf:read-skill-file",
  cancelPlan: "gandalf:cancel-plan",
  revealSkill: "gandalf:reveal-skill",
  revealLibrary: "gandalf:reveal-library",
  revealProject: "gandalf:reveal-project",
  searchSkillsSh: "market:search",
  skillsShBoard: "market:board",
  ownerAvatar: "market:avatar",
  repoSkills: "gandalf:repo-skills",
  setAppearance: "shell:set-appearance",
  chooseFolder: "shell:choose-folder",
  snapshotPushed: "gandalf:snapshot-pushed",
  watchReduceTransparency: "shell:watch-reduce-transparency",
  reduceTransparency: "shell:reduce-transparency",
} as const;

/** How main hands the home directory to the preload, through webPreferences.additionalArguments. */
export const HOME_ARGUMENT = "--gandalf-home=";
export const REAL_HOME_ARGUMENT = "--gandalf-real-home=";

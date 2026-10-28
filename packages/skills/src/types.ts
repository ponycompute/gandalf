// Public domain types of @gandalf/skills.
//
// Every value in this file is plain JSON data: no Map, Set, Date, or class instance. The same
// objects therefore serve `gandalf --json` and Electron structured-clone IPC with no mapping layer.

import type { AgentId } from "./agents.js";

export type { AgentId };

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** One path segment matching /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/. Parsed once, trusted after. */
export type SkillName = Brand<string, "SkillName">;
export type AbsPath = Brand<string, "AbsPath">;
/** "sha256:<hex>" over a skill directory's canonical listing (see disk.ts contentHash). */
export type ContentHash = Brand<string, "ContentHash">;
export type GitCommit = Brand<string, "GitCommit">;
/** Monotonic counter stored in state.db. Bumped by every commitState step. */
export type Revision = Brand<number, "Revision">;
export type PlanFingerprint = Brand<string, "PlanFingerprint">;
export type IsoTime = Brand<string, "IsoTime">;

export type Selection<T> = "all" | readonly T[];
/** How an entry is projected into an agent dir. */
export type Mode = "link" | "copy";
/** "auto" links where the root supports symlinks and copies where it does not. */
export type ModeSetting = "auto" | Mode;

// ---------------------------------------------------------------------------
// Desired state (the domain view of state.db; the storage schema stays private to state.ts)
// ---------------------------------------------------------------------------

/**
 * Normalized enablement. enabled(agent) = default XOR except.includes(agent).
 * An override equal to the default is unrepresentable, and agents installed later inherit `default`.
 */
export interface Enablement {
  readonly default: boolean;
  readonly except: readonly AgentId[];
}

export type SkillSource =
  /** `path` is null for a library dir that was enabled without ever being installed by gandalf. */
  | { readonly kind: "local"; readonly path: AbsPath | null }
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref: string | null;
      readonly subpath: string | null;
      readonly commit: GitCommit;
    }
  /** `from` is null when the adopted entry lived in a shared scan dir such as ~/.agents/skills. */
  | { readonly kind: "adopted"; readonly from: AgentId | null };

// ---------------------------------------------------------------------------
// Observation: what is on disk at one entry, decided by evidence on the entry itself
// ---------------------------------------------------------------------------

export type Observed =
  | { readonly kind: "absent" }
  /** Symlink whose target is <library>/<skill>. Owned. `resolves` is false for a broken link. */
  | { readonly kind: "link"; readonly skill: SkillName; readonly resolves: boolean }
  /** Directory carrying a valid .gandalf-copy.json whose recorded hash equals the content. Owned. */
  | { readonly kind: "cleanCopy"; readonly skill: SkillName; readonly hash: ContentHash }
  /** gandalf copied it, the user edited it since. Treated as the user's: never touched. */
  | {
      readonly kind: "modifiedCopy";
      readonly skill: SkillName;
      readonly recorded: ContentHash;
      readonly actual: ContentHash;
    }
  /** Directory with SKILL.md and no marker: a skill the user put there. */
  | { readonly kind: "skillDir"; readonly hash: ContentHash; readonly declaredName: string | null }
  /** Symlink pointing anywhere outside the library. */
  | { readonly kind: "foreignLink"; readonly target: string; readonly resolves: boolean }
  /** A file, or a directory without SKILL.md. */
  | { readonly kind: "other" };

export type Absent = Extract<Observed, { kind: "absent" }>;
/** The only observations a removal step can be built from. */
export type Owned = Extract<Observed, { kind: "link" | "cleanCopy" }>;
/** Everything gandalf must never move or replace during sync. */
export type Unowned = Extract<
  Observed,
  { kind: "modifiedCopy" | "skillDir" | "foreignLink" | "other" }
>;

export interface Desired {
  readonly skill: SkillName;
  readonly mode: ModeSetting;
}

export type RepairReason = "otherSkill" | "staleCopy" | "wrongMode";

/**
 * The diff for one entry: observed and desired are correlated with the verdict, so a verdict that
 * leads to a removal can only carry Owned evidence. `conflict` and `unmanaged` carry Unowned evidence
 * and map to no step at all.
 */
export type Reconciled =
  | { readonly verdict: "ok"; readonly observed: Owned; readonly desired: Desired }
  | { readonly verdict: "missing"; readonly observed: Absent; readonly desired: Desired }
  | {
      readonly verdict: "repair";
      readonly observed: Owned;
      readonly desired: Desired;
      readonly why: RepairReason;
    }
  | { readonly verdict: "extra"; readonly observed: Owned; readonly desired: null }
  /** Desired, but the library dir is gone, so there is nothing to link to. */
  | { readonly verdict: "blocked"; readonly observed: Absent | Owned; readonly desired: Desired }
  | { readonly verdict: "conflict"; readonly observed: Unowned; readonly desired: Desired }
  | { readonly verdict: "unmanaged"; readonly observed: Unowned; readonly desired: null }
  /** Owned evidence that sync deliberately leaves alone: in a scan root, or for an untracked skill. */
  | {
      readonly verdict: "untouched";
      readonly observed: Owned;
      readonly desired: null;
      readonly why: "scanRoot" | "untracked";
    };

export type Verdict = Reconciled["verdict"];

/** "target": gandalf projects skills here. "scan": read-only discovery dir. */
export type RootRole = "target" | "scan";

export interface EntryLocation {
  readonly root: AbsPath;
  readonly role: RootRole;
  /** Installed agents that read this root. Several when dirs are shared or overridden to one path. */
  readonly readers: readonly AgentId[];
  /** The registered project the root lies in; null for agents' own dirs under HOME. */
  readonly project: AbsPath | null;
  /** The name on disk. Not a SkillName: unmanaged entries can be called anything. */
  readonly name: string;
  readonly path: AbsPath;
}

export type Entry = EntryLocation & Reconciled;

// ---------------------------------------------------------------------------
// Snapshot: the read model every view (agents, list, scan, status, Electron screens) filters
// ---------------------------------------------------------------------------

export interface AgentView {
  readonly id: AgentId;
  readonly displayName: string;
  readonly installed: boolean;
  readonly skillsDir: AbsPath;
  /** The skills dir without an override; skillsDir differs from it when one sets the dir. */
  readonly builtInSkillsDir: AbsPath;
  readonly scanDirs: readonly AbsPath[];
  /** Relative to a project's folder; null when gandalf writes no project skills for this agent. */
  readonly projectDir: string | null;
  readonly mode: ModeSetting;
  /** True when state.db overrides the built-in skills dir or mode. */
  readonly overridden: boolean;
  /** Set when the skills dir cannot be read or lies inside ~/.gandalf. Planners skip it. */
  readonly readError: string | null;
}

/** A directory gandalf observes. Shared dirs appear once, with every agent that reads them. */
export interface RootView {
  readonly path: AbsPath;
  readonly role: RootRole;
  /** Installed agents that load skills from this dir. */
  readonly readers: readonly AgentId[];
  /** Installed agents whose skills dir this is. gandalf writes only to roots with targets. */
  readonly targets: readonly AgentId[];
  /** The registered project the dir lies in; null for agents' own dirs under HOME. */
  readonly project: AbsPath | null;
}

/**
 * A folder, usually a repository, whose agents get their own skills next to the code. Skills land
 * there as copies, never links: a link into ~/.gandalf would break for anyone else who opens it.
 */
export interface ProjectView {
  readonly path: AbsPath;
  /** Agents whose project skills dir gandalf writes, in registry order. Installed or not. */
  readonly agents: readonly AgentId[];
  /** The skills the project gets, sorted. */
  readonly skills: readonly SkillName[];
  /** Set when the project folder is gone or a skills dir in it cannot be read. */
  readonly readError: string | null;
}

export type SkillIssue =
  /** In the library with no state.db record. Sync leaves its entries alone until it is enabled. */
  | { readonly kind: "untracked" }
  /** state.db tracks it but the library dir is gone. */
  | { readonly kind: "libraryMissing" }
  | { readonly kind: "noSkillMd" }
  | { readonly kind: "nameMismatch"; readonly declared: string };

export interface Cell {
  readonly agent: AgentId;
  readonly enabled: boolean;
  /** "off" when the skill is not desired here and nothing occupies the slot. */
  readonly verdict: Verdict | "off";
}

export interface SkillView {
  readonly name: SkillName;
  readonly description: string | null;
  readonly dir: AbsPath;
  /** null when the library dir is missing. */
  readonly hash: ContentHash | null;
  /** null when untracked. */
  readonly source: SkillSource | null;
  readonly installedAt: IsoTime | null;
  /** One cell per installed agent, in registry order: the Library matrix row. */
  readonly cells: readonly Cell[];
  readonly issues: readonly SkillIssue[];
}

/** What `gandalf status` reports. Any problem makes it exit 2. */
export type Problem =
  | {
      readonly kind: "brokenLink" | "modifiedCopy" | "conflict" | "blocked" | "drift";
      readonly entry: Entry;
    }
  | { readonly kind: "libraryMissing"; readonly skill: SkillName };

export interface Snapshot {
  readonly revision: Revision;
  readonly libraryDir: AbsPath;
  readonly agents: readonly AgentView[];
  readonly roots: readonly RootView[];
  readonly skills: readonly SkillView[];
  readonly projects: readonly ProjectView[];
  /** Every non-absent entry in every root, plus absent slots where a skill is desired. */
  readonly entries: readonly Entry[];
  readonly problems: readonly Problem[];
  /** Directories whose change can change this snapshot. The Electron shell fs.watch-es exactly these. */
  readonly watchPaths: readonly AbsPath[];
}

// ---------------------------------------------------------------------------
// Intents: what a caller asks for. Every write in the product is one of these.
// ---------------------------------------------------------------------------

export type SourceSpec =
  | { readonly kind: "local"; readonly path: AbsPath }
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref: string | null;
      readonly subpath: string | null;
      /**
       * A skill to find in the repository, by its SKILL.md name or else its folder's, for a source
       * such as skills.sh that names the skill but not its folder. Only with `subpath` null: plan()
       * sets `subpath` to the folder it found and this back to null.
       */
      readonly skill: SkillName | null;
      /** Filled in by plan() so apply() re-derives the same plan without touching the network. */
      readonly commit: GitCommit | null;
    };

/** The variant to keep when copies of one name differ between agents. */
export type AdoptPick =
  | { readonly name: SkillName; readonly kind: "hash"; readonly hash: ContentHash }
  | { readonly name: SkillName; readonly kind: "agent"; readonly agent: AgentId };

export interface CommitPin {
  readonly skill: SkillName;
  readonly commit: GitCommit;
}

export type Intent =
  | { readonly kind: "sync"; readonly skills: Selection<SkillName> }
  | {
      readonly kind: "setEnabled";
      readonly skill: SkillName;
      readonly enabled: boolean;
      readonly agents: Selection<AgentId>;
    }
  | {
      readonly kind: "adopt";
      readonly names: Selection<SkillName>;
      readonly pick: readonly AdoptPick[];
    }
  | {
      readonly kind: "install";
      readonly source: SourceSpec;
      readonly agents: Selection<AgentId>;
      /** More sources installed in the same plan, such as other skills of one repository. */
      readonly also?: readonly SourceSpec[];
    }
  | {
      readonly kind: "update";
      readonly skills: Selection<SkillName>;
      /** Filled in by plan(): the commit each skill moves to. */
      readonly pins: readonly CommitPin[];
    }
  | { readonly kind: "remove"; readonly skill: SkillName }
  | {
      readonly kind: "configureAgent";
      readonly agent: AgentId;
      /** null restores the built-in dir. */
      readonly skillsDir: AbsPath | null;
      /** null restores the default, "auto". */
      readonly mode: ModeSetting | null;
    }
  /** Registers `path`, or changes its agents. Dropping an agent removes gandalf's copies there. */
  | {
      readonly kind: "configureProject";
      readonly path: AbsPath;
      readonly agents: readonly AgentId[];
    }
  /** Forgets the project. Its copies stay in place, as the user's own skills from then on. */
  | { readonly kind: "removeProject"; readonly path: AbsPath }
  | {
      readonly kind: "setProjectSkills";
      readonly project: AbsPath;
      readonly skills: readonly SkillName[];
      readonly enabled: boolean;
    };

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** An entry in a target root. Steps address roots plus names, never free-form paths. */
export interface Slot {
  readonly root: AbsPath;
  /** The name on disk. Creations always use the skill's name; a removal may target a misnamed link. */
  readonly name: string;
}

export type Materialize =
  | { readonly kind: "local"; readonly path: AbsPath }
  | {
      readonly kind: "git";
      readonly url: string;
      readonly commit: GitCommit;
      readonly subpath: string | null;
    };

/** Set-semantics patch to state.db. Applying a change twice equals applying it once. */
export type StateChange =
  | {
      readonly kind: "track";
      readonly skill: SkillName;
      readonly source: SkillSource;
      readonly enabled: Enablement;
    }
  | { readonly kind: "untrack"; readonly skill: SkillName }
  | { readonly kind: "setEnabled"; readonly skill: SkillName; readonly enabled: Enablement }
  | { readonly kind: "setSource"; readonly skill: SkillName; readonly source: SkillSource }
  | {
      readonly kind: "setAgent";
      readonly agent: AgentId;
      readonly skillsDir: AbsPath | null;
      readonly mode: ModeSetting | null;
    }
  | {
      readonly kind: "setProject";
      readonly project: AbsPath;
      readonly agents: readonly AgentId[];
    }
  | { readonly kind: "untrackProject"; readonly project: AbsPath }
  | {
      readonly kind: "setProjectSkill";
      readonly project: AbsPath;
      readonly skill: SkillName;
      readonly enabled: boolean;
    }
  /**
   * The hash of a copy gandalf is about to place in a project. A project copy carries no marker, so
   * this record is what tells it from the user's own dir: owned while the content still hashes so.
   */
  | {
      readonly kind: "recordCopy";
      readonly project: AbsPath;
      readonly path: AbsPath;
      readonly skill: SkillName;
      readonly hash: ContentHash;
    }
  | { readonly kind: "forgetCopy"; readonly project: AbsPath; readonly path: AbsPath };

/**
 * Every step names the evidence it expects (pre) and implies the evidence it leaves (post).
 * apply() checks both against disk right before acting: post holds means alreadyDone, pre holds
 * means act, anything else means drifted and nothing is touched.
 *
 * Steps run in the fixed order of reconcile.ts RANK: removals, commitState, library adds,
 * creations, library trash.
 */
export type Step =
  | { readonly kind: "unlink"; readonly slot: Slot; readonly skill: SkillName }
  | { readonly kind: "trashCopy"; readonly slot: Slot; readonly hash: ContentHash }
  | {
      readonly kind: "libraryReplace";
      readonly skill: SkillName;
      readonly expect: ContentHash;
      readonly from: Materialize;
      readonly hash: ContentHash;
    }
  | {
      readonly kind: "commitState";
      readonly from: Revision;
      readonly changes: readonly StateChange[];
    }
  | { readonly kind: "ensureDir"; readonly dir: AbsPath }
  | {
      readonly kind: "libraryAdd";
      readonly skill: SkillName;
      /** The SKILL.md description, so the plan can say what it brings. */
      readonly description: string | null;
      readonly from: Materialize;
      readonly hash: ContentHash;
    }
  | {
      readonly kind: "adoptMove";
      readonly skill: SkillName;
      readonly from: EntryLocation;
      readonly hash: ContentHash;
    }
  | {
      readonly kind: "trashDuplicate";
      readonly skill: SkillName;
      readonly from: EntryLocation;
      readonly hash: ContentHash;
    }
  | { readonly kind: "link"; readonly slot: Slot; readonly skill: SkillName }
  | {
      readonly kind: "copy";
      readonly slot: Slot;
      readonly skill: SkillName;
      readonly hash: ContentHash;
    }
  /** A copy into a project: no marker, the hash recorded in state.db instead. */
  | {
      readonly kind: "projectCopy";
      readonly slot: Slot;
      readonly skill: SkillName;
      readonly hash: ContentHash;
    }
  | { readonly kind: "trashProjectCopy"; readonly slot: Slot; readonly hash: ContentHash }
  | { readonly kind: "libraryTrash"; readonly skill: SkillName; readonly expect: ContentHash };

export interface AdoptVariant {
  readonly hash: ContentHash;
  readonly at: readonly EntryLocation[];
}

/** In-scope things the plan deliberately does not do, with the reason. Shown next to the steps. */
export type NotDone =
  | { readonly kind: "conflict"; readonly entry: Entry }
  | { readonly kind: "libraryMissing"; readonly skill: SkillName }
  | {
      readonly kind: "needsChoice";
      readonly name: SkillName;
      readonly variants: readonly AdoptVariant[];
    }
  | { readonly kind: "differsFromLibrary"; readonly name: SkillName; readonly at: EntryLocation }
  | { readonly kind: "locallyModified"; readonly skill: SkillName }
  | { readonly kind: "rootUnreadable"; readonly root: AbsPath; readonly error: string };

export interface Plan {
  /** The intent with every pin filled in. */
  readonly intent: Intent;
  readonly steps: readonly Step[];
  readonly notDone: readonly NotDone[];
  /** sha256 of canonical JSON of { intent, steps }. */
  readonly fingerprint: PlanFingerprint;
}

/** What apply() needs. A Plan is a PlanToken; over IPC the renderer may send back only these two fields. */
export type PlanToken = Pick<Plan, "intent" | "fingerprint">;

export type PlanError =
  | { readonly kind: "unknownSkill"; readonly skill: SkillName }
  | { readonly kind: "agentNotInstalled"; readonly agent: AgentId }
  | { readonly kind: "nameTaken"; readonly skill: SkillName }
  | { readonly kind: "nothingToAdopt"; readonly name: SkillName }
  | { readonly kind: "notGitSourced"; readonly skill: SkillName }
  | { readonly kind: "badSource"; readonly reason: string }
  | { readonly kind: "unknownProject"; readonly path: AbsPath }
  /** The agent reads no project skills dir gandalf knows of. */
  | { readonly kind: "noProjectDir"; readonly agent: AgentId }
  /** The project's skills dir for `agent` is a dir gandalf already manages under HOME. */
  | {
      readonly kind: "projectOverlaps";
      readonly path: AbsPath;
      readonly agent: AgentId;
      readonly dir: AbsPath;
    };

/** A skill a repository holds, as `repoSkills` lists it. */
export interface RepoSkill {
  readonly name: SkillName;
  /** The folder of its SKILL.md in the repository, null at the top. */
  readonly subpath: string | null;
  readonly description: string | null;
}

export type RepoSkillsOutcome =
  | { readonly ok: true; readonly commit: GitCommit; readonly skills: readonly RepoSkill[] }
  | { readonly ok: false; readonly error: PlanError };

export type PlanOutcome =
  { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly error: PlanError };

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface LockHolder {
  readonly pid: number;
  readonly since: IsoTime;
}

export type StepResult =
  | { readonly step: Step; readonly status: "done" | "alreadyDone" }
  /** Neither pre nor post held on disk. Nothing was touched. */
  | { readonly step: Step; readonly status: "drifted"; readonly found: string }
  /** crossDevice: the move needs a rename across volumes, which Stage 1 refuses. */
  | {
      readonly step: Step;
      readonly status: "failed";
      readonly reason: "crossDevice" | "io";
      readonly error: string;
    }
  /** An earlier step on the same slot or skill did not complete. `after` is its index. */
  | { readonly step: Step; readonly status: "skipped"; readonly after: number };

export type ApplyOutcome =
  | { readonly kind: "applied"; readonly results: readonly StepResult[] }
  /** The plan re-derived under the lock differs from the token. Nothing was written. */
  | { readonly kind: "stale"; readonly fresh: PlanOutcome }
  | { readonly kind: "busy"; readonly holder: LockHolder };

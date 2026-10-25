import type {
  AgentId,
  Enablement,
  Intent,
  LockHolder,
  Materialize,
  Mode,
  NotDone,
  Observed,
  PlanError,
  Snapshot,
  StateChange,
  Step,
  StepResult,
  Verdict,
} from "@gandalf/skills";

// Glyphs, CLI verbs and the summary line are copied from packages/cli/src/render.ts.
// vocabulary.test.ts fails when the two drift.

export const GLYPH = {
  ok: "●",
  missing: "○",
  repair: "◐",
  extra: "−",
  blocked: "!",
  conflict: "✗",
  unmanaged: "?",
  untouched: "~",
  off: "·",
} as const satisfies Record<Verdict | "off", string>;

/** Each step's CLI verb and the user word the app shows for it instead. */
export const STEP_WORD = {
  unlink: { cli: "unlink", app: "Remove" },
  trashCopy: { cli: "trash", app: "Move to Trash" },
  libraryReplace: { cli: "update", app: "Update" },
  commitState: { cli: "record", app: "Save" },
  ensureDir: { cli: "mkdir", app: "Create" },
  libraryAdd: { cli: "add", app: "Add" },
  adoptMove: { cli: "move", app: "Move" },
  trashDuplicate: { cli: "trash", app: "Move to Trash" },
  link: { cli: "link", app: "Link" },
  copy: { cli: "copy", app: "Copy" },
  libraryTrash: { cli: "trash", app: "Move to Trash" },
} as const satisfies Record<Step["kind"], { readonly cli: string; readonly app: string }>;

/**
 * Each reason a plan leaves something undone: the CLI's label for it (needsChoice prints apart)
 * and the one status the app shows. Conflict means something on disk is in the way; Blocked means
 * gandalf cannot reach what it needs. A name waiting for a version choice, and a copy that keeps
 * its own version, are still Not managed: nothing is in the way, they just stay where they are, as
 * Discover and the library show them.
 */
export const NOT_DONE = {
  conflict: { cli: "conflict", verdict: "conflict" },
  libraryMissing: { cli: "missing", verdict: "blocked" },
  differsFromLibrary: { cli: "differs", verdict: "unmanaged" },
  locallyModified: { cli: "modified", verdict: "conflict" },
  rootUnreadable: { cli: "unreadable", verdict: "blocked" },
  needsChoice: { cli: null, verdict: "unmanaged" },
} as const satisfies Record<
  NotDone["kind"],
  { readonly cli: string | null; readonly verdict: "conflict" | "blocked" | "unmanaged" }
>;

export function summaryLine(results: readonly StepResult[]): string {
  const count = (status: StepResult["status"]) =>
    results.filter((result) => result.status === status).length;
  return `${count("done")} done, ${count("alreadyDone")} already done, ${count("drifted")} drifted, ${count("failed")} failed, ${count("skipped")} skipped`;
}

export function notDoneReason(item: NotDone, names: Names): string {
  switch (item.kind) {
    case "conflict":
      return conflictReason(item.entry.observed, names);
    case "libraryMissing":
      return `The library folder for ${item.skill} is missing. Reinstall ${item.skill} or remove it from gandalf.`;
    case "differsFromLibrary":
      return keepsOwnVersion(item.name, item.at.root, names);
    case "locallyModified":
      return `You edited ${item.skill} in the library. gandalf never updates over your edits. Copy your edits elsewhere, then update ${item.skill} again.`;
    case "rootUnreadable":
      return `gandalf cannot read this folder (${item.error}). Check its permissions, then Sync.`;
    case "needsChoice":
      return `The ${item.variants.length} versions of ${item.name} differ, so this change leaves its copies where they are.`;
  }
}

/** Why a copy you placed that differs from the library's version stays where it is. */
export function keepsOwnVersion(name: string, root: string, names: Names): string {
  return `${names.folder(root)} keeps its own version of ${name}. gandalf does not replace a skill you placed. To use the library's version there, remove this copy, then Sync.`;
}

/** What Adopt does with copies you placed that match the library's version of their name. */
export function matchesLibrary(name: string): string {
  return `The library has this same version of ${name}. Adopt moves your copy to the Trash and links the library's version in its place.`;
}

/** Why gandalf leaves something in a slot it wants for a skill. */
export function conflictReason(observed: Observed, names: Names): string {
  switch (observed.kind) {
    case "skillDir":
      return "A skill you placed there uses this name. gandalf never replaces it. Rename or move it, then Sync.";
    case "modifiedCopy":
      return "You edited gandalf's copy here. gandalf leaves it alone. Move your edits into the library, then Sync.";
    case "foreignLink":
      return `A ${observed.resolves ? "" : "broken "}link you made there points to ${tilde(observed.target, names.home)}. gandalf never replaces it. Remove the link, then Sync.`;
    case "other":
    case "absent":
    case "link":
    case "cleanCopy":
      return "Something that is not a skill uses this name. gandalf never replaces it. Rename or move it, then Sync.";
  }
}

/** Why Discover cannot adopt an entry that gandalf does not manage. */
export function cannotAdoptReason(observed: Observed, names: Names): string {
  switch (observed.kind) {
    case "skillDir":
      return "Its folder name is not a valid skill name. Rename the folder, then adopt it.";
    case "modifiedCopy":
      return `You edited gandalf's copy of ${observed.skill} here. gandalf leaves it alone.`;
    case "foreignLink":
      return `A ${observed.resolves ? "" : "broken "}link you made to ${tilde(observed.target, names.home)}. gandalf leaves it alone.`;
    case "other":
    case "absent":
    case "link":
    case "cleanCopy":
      // The core observes a file and a folder without SKILL.md alike, so the reason names both.
      return "It is a file, or a folder with no SKILL.md, so it is not a skill. gandalf leaves it alone.";
  }
}

export interface Refusal {
  /** What the planner found. */
  readonly what: string;
  /** What the user can do about it. */
  readonly next: string;
}

export function planRefusal(error: PlanError, names: Names): Refusal {
  switch (error.kind) {
    case "unknownSkill":
      return {
        what: `${error.skill} is not in the library.`,
        next: "Close this to see the library now.",
      };
    case "agentNotInstalled": {
      const agent = names.agent(error.agent);
      return { what: `${agent} is not installed.`, next: `Install ${agent}, then try again.` };
    }
    case "nameTaken":
      return {
        what: `The library already has a different skill named ${error.skill}.`,
        next: "Rename one of them, then try again.",
      };
    case "nothingToAdopt":
      return {
        what: `gandalf found no skill you placed named ${error.name}.`,
        next: "Place the skill's folder in an agent's skills folder, then try again.",
      };
    case "notGitSourced":
      return {
        what: `${error.skill} was not installed from git, so it has no updates.`,
        next: "Install it from git to get updates.",
      };
    case "badSource":
      return {
        what: `gandalf cannot use this source (${error.reason}).`,
        next: "Choose a folder or git URL that contains a SKILL.md.",
      };
  }
}

function source(from: Materialize, home: string): string {
  return from.kind === "local"
    ? tilde(from.path, home)
    : `${from.url}@${from.commit.slice(0, 12)}${from.subpath === null ? "" : `:${from.subpath}`}`;
}

// The app's own words, per the design system README's Status vocabulary and Voice sections.

export const VERDICT_WORD = {
  ok: "Linked",
  missing: "Will add",
  repair: "Will update",
  extra: "Will remove",
  blocked: "Blocked",
  conflict: "Conflict",
  unmanaged: "Not managed",
  untouched: "Left alone",
  off: "Off",
} as const satisfies Record<Verdict | "off", string>;

export function verdictWord(verdict: Verdict | "off", mode: Mode = "link"): string {
  return verdict === "ok" && mode === "copy" ? "Copied" : VERDICT_WORD[verdict];
}

export function tilde(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** What a plan's paths and agent ids are called on screen. */
export interface Names {
  readonly home: string;
  readonly libraryDir: string;
  /** The agents the matrix has a column for, in registry order. */
  readonly installed: readonly AgentId[];
  agent(id: AgentId): string;
  /** The agents gandalf writes for in a folder, or the folder itself when none does. */
  folder(root: string): string;
}

export function namesOf(snapshot: Snapshot, home: string): Names {
  const display = new Map<string, string>(snapshot.agents.map((a) => [a.id, a.displayName]));
  const targets = new Map<string, readonly AgentId[]>(
    snapshot.roots.map((root) => [root.path, root.targets]),
  );
  const agent = (id: AgentId) => display.get(id) ?? id;
  return {
    home,
    libraryDir: snapshot.libraryDir,
    installed: snapshot.agents
      .filter((view) => view.installed && view.readError === null)
      .map((view) => view.id),
    agent,
    folder: (root) => {
      const ids = targets.get(root) ?? [];
      return ids.length === 0 ? tilde(root, home) : AND.format(ids.map(agent));
    },
  };
}

export function stepSentence(step: Step, names: Names): string {
  switch (step.kind) {
    case "unlink":
      return `Remove ${step.skill} from ${names.folder(step.slot.root)}`;
    case "trashCopy":
      return `Move gandalf's copy of ${step.slot.name} in ${names.folder(step.slot.root)} to the Trash`;
    case "libraryReplace":
      return `Update ${step.skill} in the library from ${source(step.from, names.home)}`;
    case "commitState":
      return `Save ${step.changes.map((change) => changeText(change, names)).join("; ")}`.trimEnd();
    case "ensureDir":
      return `Create the skills folder for ${names.folder(step.dir)}`;
    case "libraryAdd":
      return `Add ${step.skill} to the library from ${source(step.from, names.home)}`;
    case "adoptMove":
      return `Move ${step.skill} from ${names.folder(step.from.root)} into the library`;
    case "trashDuplicate":
      return `Move the copy of ${step.skill} in ${names.folder(step.from.root)} that matches the library to the Trash`;
    case "link":
      return `Link ${step.skill} into ${names.folder(step.slot.root)}`;
    case "copy":
      return `Copy ${step.skill} into ${names.folder(step.slot.root)}`;
    case "libraryTrash":
      return `Move ${step.skill} in the library to the Trash`;
  }
}

export function libraryPath(names: Names, skill: string): string {
  return `${names.libraryDir}/${skill}`;
}

/** The folder that holds the library and state.json. */
export function gandalfDir(names: Names): string {
  return names.libraryDir.slice(0, names.libraryDir.lastIndexOf("/"));
}

/** Where a step writes, and where a link it makes points. */
export function stepPath(
  step: Step,
  names: Names,
): { readonly path: string; readonly target?: string } {
  switch (step.kind) {
    case "link":
      return {
        path: `${step.slot.root}/${step.slot.name}`,
        target: libraryPath(names, step.skill),
      };
    case "unlink":
    case "trashCopy":
    case "copy":
      return { path: `${step.slot.root}/${step.slot.name}` };
    case "libraryReplace":
    case "libraryAdd":
    case "libraryTrash":
      return { path: libraryPath(names, step.skill) };
    case "adoptMove":
    case "trashDuplicate":
      return { path: step.from.path };
    case "ensureDir":
      return { path: step.dir };
    case "commitState":
      return { path: `${gandalfDir(names)}/state.json` };
  }
}

function changeText(change: StateChange, names: Names): string {
  switch (change.kind) {
    case "track":
      return `${change.skill} in the library as ${enablementText(change.enabled, names)}`;
    case "untrack":
      return `the removal of ${change.skill}`;
    case "setEnabled":
      return `${change.skill} as ${enablementText(change.enabled, names)}`;
    case "setSource":
      return `the source of ${change.skill}${change.source.kind === "git" ? ` at ${change.source.commit.slice(0, 12)}` : ""}`;
    case "setAgent":
      return `${names.agent(change.agent)} with the ${change.skillsDir === null ? "default folder" : `folder ${tilde(change.skillsDir, names.home)}`} and mode ${change.mode ?? "auto"}`;
  }
}

/** The end state in installed agents' names: "on for Cursor only", "off for all agents". */
function enablementText(enablement: Enablement, names: Names): string {
  if (enablement.default && enablement.except.length === 0) return "on for all agents";
  const on = names.installed.filter((id) => enablement.default !== enablement.except.includes(id));
  if (on.length === 0) return "off for all agents";
  const list = AND.format(on.map(names.agent));
  return on.length < names.installed.length ? `on for ${list} only` : `on for ${list}`;
}

export function intentTitle(intent: Intent, names: Names): string {
  const skills = (selection: "all" | readonly string[]) =>
    selection === "all" ? "all skills" : AND.format(selection);
  switch (intent.kind) {
    case "sync":
      return `Sync ${skills(intent.skills)}`;
    case "setEnabled": {
      const agents =
        intent.agents === "all" ? "all agents" : AND.format(intent.agents.map(names.agent));
      return `Turn ${intent.enabled ? "on" : "off"} ${intent.skill} for ${agents}`;
    }
    case "adopt":
      return `Adopt ${skills(intent.names)}`;
    case "install":
      return `Install ${intent.source.kind === "local" ? tilde(intent.source.path, names.home) : intent.source.url}`;
    case "update":
      return `Update ${skills(intent.skills)}`;
    case "remove":
      return `Remove ${intent.skill}`;
    case "configureAgent":
      return `Configure ${names.agent(intent.agent)}`;
  }
}

const SINCE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" });

export function busyText(holder: LockHolder): string {
  return `Process ${holder.pid} has been applying since ${SINCE.format(new Date(holder.since))}.`;
}

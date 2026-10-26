import type {
  AbsPath,
  AgentId,
  GitCommit,
  Intent,
  RepoSkill,
  Selection,
  SkillName,
  Snapshot,
  SourceSpec,
} from "@gandalf/skills";
import type { Board, MarketSkill } from "../../shared/ipc";
import type { Flow } from "../changes/writeFlow";
import { NO_REMOTE_REF } from "../vocabulary";

export type SourceKind = "skillsSh" | "folder" | "git";

/** What the Install form holds, as typed. Fields of the source not shown keep their text. */
export interface InstallDraft {
  readonly source: SourceKind;
  readonly folder: string;
  /**
   * The folder the folder panel returned, and how Folder shows it, with ~. While Folder still
   * shows it, the path goes as the panel spelled it, not as ~ expands.
   */
  readonly chosen: { readonly shown: string; readonly path: string } | null;
  readonly url: string;
  readonly ref: string;
  readonly subpath: string;
  /** The agents checked under Link into. */
  readonly agents: readonly AgentId[];
  /** What skills.sh is searched for; while empty, the board shows instead. */
  readonly query: string;
  readonly board: Board;
}

export type FieldName = "folder" | "url" | "ref" | "subpath" | "skills" | "agents";

/** A sentence for one field, said in place of its help. */
export interface FieldError {
  readonly field: FieldName;
  readonly message: string;
}

/** A value the form built, or the field to fix first. */
export type Checked<T> =
  { readonly ok: true; readonly value: T } | ({ readonly ok: false } & FieldError);

export type InstallIntent = Extract<Intent, { kind: "install" }>;

export function emptyDraft(installed: readonly AgentId[]): InstallDraft {
  return {
    source: "skillsSh",
    folder: "",
    chosen: null,
    url: "",
    ref: "",
    subpath: "",
    agents: installed,
    query: "",
    board: "trending",
  };
}

/** `~` and `~/…` the way a shell reads them, so a path can be typed as the app writes it. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

function fail(field: FieldName, message: string): { readonly ok: false } & FieldError {
  return { ok: false, field, message };
}

/**
 * The source the form describes, checked as the core's parser checks it but in the user's words,
 * so a value it would refuse never leaves the form. The core normalizes the path itself.
 */
export function sourceSpec(draft: InstallDraft, home: string): Checked<SourceSpec> {
  if (draft.source === "folder") {
    const folder = draft.folder.trim();
    const path =
      draft.chosen !== null && draft.chosen.shown === folder
        ? draft.chosen.path
        : expandHome(folder, home);
    if (path === "") return fail("folder", "Choose the folder that contains SKILL.md.");
    if (path.startsWith("~")) return fail("folder", OTHER_HOME);
    if (!path.startsWith("/")) {
      return fail("folder", "Enter the folder's full path, starting with / or ~.");
    }
    return { ok: true, value: { kind: "local", path: path as AbsPath } };
  }
  // The core takes /repo.git/ and /repo.git as two origins, so the trailing / goes.
  const url = expandHome(draft.url.trim(), home).replace(/(?<=.)\/+$/, "");
  if (url === "") return fail("url", "Enter the repository's URL or path.");
  if (url.startsWith("-")) return fail("url", "A repository cannot start with -.");
  if (url.startsWith("~")) return fail("url", OTHER_HOME);
  if (!isRepository(url)) {
    return fail(
      "url",
      "Enter the repository's URL, such as https://github.com/acme/skills.git, or its full path, starting with / or ~.",
    );
  }
  const ref = draft.ref.trim();
  if (ref.startsWith("-")) return fail("ref", "A branch or tag cannot start with -.");
  const subpath = draft.subpath
    .trim()
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  const segments = subpath.split("/");
  if (
    subpath.startsWith("/") ||
    segments.some((segment) => segment === ".." || segment.startsWith("-"))
  ) {
    return fail("subpath", "Enter a folder inside the repository, such as skills/pdf-tools.");
  }
  return {
    ok: true,
    value: {
      kind: "git",
      url,
      ref: ref === "" ? null : ref,
      subpath: subpath === "" || subpath === "." ? null : subpath,
      skill: null,
      commit: null,
    },
  };
}

/** ~name/… is another user's home folder, which gandalf does not look up. */
const OTHER_HOME = "gandalf reads ~ only as your home folder. Enter the full path instead.";

/**
 * A URL git takes as a remote, such as https://…, ssh://… or file://…, the scp-like
 * git@host:path, or a full path. A relative path would be read against gandalf's cache.
 */
function isRepository(url: string): boolean {
  if (url.startsWith("/")) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return true;
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  return colon > 0 && (slash === -1 || colon < slash);
}

/**
 * Every installed agent checked means "all", as the CLI's install does without --agent, so agents
 * installed later get the skill too. That holds only while the form shows every installed agent:
 * with one hidden, such as one whose folder cannot be read, "all" would turn the skill on for it
 * unseen, so the checked agents go instead, in `installed` order. With no agent shown at all, "all"
 * puts the skill in the library and turns it on for agents installed later.
 */
export function agentSelection(
  checked: readonly AgentId[],
  installed: readonly AgentId[],
  hidden = false,
): Selection<AgentId> | null {
  if (installed.length === 0) return "all";
  if (!hidden && installed.every((agent) => checked.includes(agent))) return "all";
  const chosen = installed.filter((agent) => checked.includes(agent));
  return chosen.length === 0 ? null : chosen;
}

export function installIntent(
  draft: InstallDraft,
  installed: readonly AgentId[],
  home: string,
  hidden = false,
): Checked<InstallIntent> {
  const source = sourceSpec(draft, home);
  if (!source.ok) return source;
  const agents = agentSelection(draft.agents, installed, hidden);
  if (agents === null) return fail("agents", "Choose at least one agent to link the skill into.");
  return { ok: true, value: { kind: "install", source: source.value, agents } };
}

/** The skills a git repository was found to hold, for picking which to install. */
export type RepoListing =
  | { readonly kind: "none" }
  | { readonly kind: "loading"; readonly url: string; readonly ref: string | null }
  | {
      readonly kind: "ready";
      readonly url: string;
      readonly ref: string | null;
      readonly commit: GitCommit;
      readonly skills: readonly RepoSkill[];
      readonly chosen: readonly SkillName[];
    }
  | {
      readonly kind: "failed";
      readonly url: string;
      readonly ref: string | null;
      readonly message: string;
      readonly detail: string | null;
    };

/** Where a repository's skill stands against the library: new, this one, or another by its name. */
export type PickStanding = "new" | "inLibrary" | "nameTaken";

export function pickStanding(skill: RepoSkill, url: string, snapshot: Snapshot): PickStanding {
  const same = snapshot.skills.find((view) => view.name === skill.name);
  if (same === undefined) return "new";
  return same.source?.kind === "git" &&
    same.source.url === url &&
    same.source.subpath === skill.subpath
    ? "inLibrary"
    : "nameTaken";
}

/** The skills of a listing that can be installed, chosen at first. */
export function installable(
  listing: Extract<RepoListing, { kind: "ready" }>,
  snapshot: Snapshot,
): SkillName[] {
  return listing.skills
    .filter((skill) => pickStanding(skill, listing.url, snapshot) === "new")
    .map((skill) => skill.name);
}

/**
 * The install of the skills chosen from a repository, in one plan at the commit they were listed
 * at. `also` is set even for one skill, so a failure shows in the sync sheet, not on Folder.
 */
export function pickedIntent(
  listing: Extract<RepoListing, { kind: "ready" }>,
  draft: InstallDraft,
  installed: readonly AgentId[],
  hidden = false,
): Checked<InstallIntent> {
  const specs = listing.skills
    .filter((skill) => listing.chosen.includes(skill.name))
    .map((skill): SourceSpec => ({
      kind: "git",
      url: listing.url,
      ref: listing.ref,
      subpath: skill.subpath,
      skill: null,
      commit: listing.commit,
    }));
  const [first, ...also] = specs;
  if (first === undefined) return fail("skills", "Choose at least one skill to install.");
  const agents = agentSelection(draft.agents, installed, hidden);
  if (agents === null) return fail("agents", "Choose at least one agent to link the skills into.");
  return { ok: true, value: { kind: "install", source: first, agents, also } };
}

/**
 * The install of one skills.sh skill: its GitHub repository at the default branch, the skill
 * found in it by its id, as `gandalf skills install <url> --skill <id>` does.
 */
export function skillsShIntent(
  skill: MarketSkill,
  draft: InstallDraft,
  installed: readonly AgentId[],
  hidden = false,
): Checked<InstallIntent> {
  const agents = agentSelection(draft.agents, installed, hidden);
  if (agents === null) return fail("agents", "Choose at least one agent to link the skill into.");
  if (skill.repository === null) {
    return fail("url", `${skill.source} is not a GitHub repository, so gandalf cannot fetch it.`);
  }
  return {
    ok: true,
    value: {
      kind: "install",
      source: {
        kind: "git",
        url: skill.repository,
        ref: null,
        subpath: null,
        skill: skill.skillId as SkillName,
        commit: null,
      },
      agents,
    },
  };
}

/** True when the intent installs this skills.sh skill. */
export function installsSkill(intent: Intent, skill: MarketSkill): boolean {
  return (
    intent.kind === "install" &&
    intent.source.kind === "git" &&
    intent.source.url === skill.repository &&
    intent.source.skill === skill.skillId
  );
}

/** Where a skills.sh skill stands against the library, before anything is planned. */
export type MarketStanding = "new" | "inLibrary" | "nameTaken" | "notOnGitHub";

export function marketStanding(skill: MarketSkill, snapshot: Snapshot): MarketStanding {
  if (skill.repository === null) return "notOnGitHub";
  const same = snapshot.skills.find(
    (view) => view.name === skill.skillId || view.name === skill.name,
  );
  if (same === undefined) return "new";
  // The library's git sources are kept as typed, so http(s) and a missing .git still match.
  const bare = (url: string) => url.replace(/\.git$/, "").replace(/^https?:\/\//, "");
  return same.source?.kind === "git" && bare(same.source.url) === bare(skill.repository)
    ? "inLibrary"
    : "nameTaken";
}

/** Why the install of a skills.sh skill failed, said on its row instead of the sync sheet. */
export interface RowProblem {
  readonly url: string;
  readonly skill: string;
  readonly message: string;
  readonly detail: string | null;
}

/** The row's problem with a failed skills.sh install, or null when the sync sheet shows it. */
export function rowProblem(flow: Flow): RowProblem | null {
  if (flow.kind !== "failed" || flow.intent.kind !== "install") return null;
  const { source } = flow.intent;
  if (source.kind !== "git" || source.skill === null) return null;
  const { failure } = flow;
  const at = { url: source.url, skill: source.skill };
  if (failure.kind === "refused") {
    if (failure.error.kind !== "badSource") return null;
    const { reason } = failure.error;
    return reason.startsWith("no skill named ")
      ? { ...at, message: "The repository no longer has this skill.", detail: null }
      : { ...at, message: "gandalf could not fetch this skill.", detail: reason };
  }
  if (failure.error.kind !== "git" && failure.error.kind !== "network") return null;
  return { ...at, message: "gandalf could not fetch this skill.", detail: failure.error.message };
}

/**
 * Why an install failed, shown on the form instead of the sync sheet: the source is wrong, so the
 * fix is in the form. `field` is the one to mark; a git failure has `detail`, git's own words.
 */
export interface FormProblem extends FieldError {
  readonly detail: string | null;
}

const NO_SKILL_MD = "no SKILL.md in ";
const NO_NAME = "no usable skill name in ";
/** Main's reason for a local folder that is missing or a file (NOT_A_FOLDER in main/gandalf.ts). */
const NO_FOLDER = "no folder at ";
/** git's words for a Folder that is not in the commit. */
const NO_PATH = "did not match any file(s) known to git";

/** The form's problem with a failed install, or null when the sync sheet shows the failure. */
export function formProblem(flow: Flow): FormProblem | null {
  if (flow.kind !== "failed" || flow.intent.kind !== "install") return null;
  const { source } = flow.intent;
  // A skills.sh install says its failure on its row, and one picked from a list in the sheet.
  if ((source.kind === "git" && source.skill !== null) || flow.intent.also !== undefined) {
    return null;
  }
  const { failure } = flow;
  if (failure.kind === "error") {
    const { error } = failure;
    if (error.kind !== "badInput" || !error.field.startsWith("source")) return null;
    // The core's message starts with the field, "source.ref: …", which the form says by marking it.
    const reason = error.message.replace(/^source\.\w+: /, "");
    return {
      field: inputField(error.field),
      message: `gandalf cannot use this value (${reason}). Change it, then click Install.`,
      detail: null,
    };
  }
  if (failure.error.kind !== "badSource") return null;
  const { reason } = failure.error;
  if (source.kind === "local") {
    return { field: "folder", ...localProblem(reason) };
  }
  if (reason.includes(NO_PATH)) {
    return {
      field: "subpath",
      message:
        "The repository has no folder by this name. Check the spelling, or leave it empty when SKILL.md is at the top.",
      detail: null,
    };
  }
  if (reason.includes(NO_REMOTE_REF)) {
    return source.ref === null
      ? {
          field: "ref",
          message: "The repository has no default branch. Enter a branch or tag.",
          detail: null,
        }
      : {
          field: "ref",
          message: `The repository has no branch or tag named ${source.ref}. Check the name, or leave it empty for the default branch.`,
          detail: null,
        };
  }
  const where: FieldName = source.subpath === null ? "url" : "subpath";
  if (reason.startsWith(NO_SKILL_MD)) {
    const message =
      source.subpath === null
        ? "No SKILL.md at the top of this repository. Enter the folder that contains one under Folder."
        : "No SKILL.md in this folder of the repository. Enter a folder that contains one.";
    return { field: where, message, detail: null };
  }
  if (reason.startsWith(NO_NAME)) return { field: where, message: NO_NAME_MESSAGE, detail: null };
  return {
    field: "url",
    message:
      "gandalf could not fetch this repository. Check the URL and the branch or tag, then click Install.",
    detail: reason,
  };
}

const NO_NAME_MESSAGE =
  "This folder's name is not a valid skill name, and its SKILL.md names none. Add a name to SKILL.md, then click Install.";

function localProblem(reason: string): Omit<FormProblem, "field"> {
  if (reason.startsWith(NO_FOLDER)) {
    return { message: "No folder at this path. Choose another.", detail: null };
  }
  if (reason.startsWith(NO_SKILL_MD)) {
    return {
      message: "No SKILL.md in this folder. Choose a folder that contains one.",
      detail: null,
    };
  }
  if (reason.startsWith(NO_NAME)) return { message: NO_NAME_MESSAGE, detail: null };
  return {
    message: "gandalf cannot read this folder. Check that you can open it, then click Install.",
    detail: reason,
  };
}

/** The form field behind a source field the core refused, such as source.url. */
function inputField(field: string): FieldName {
  if (field.endsWith(".ref")) return "ref";
  if (field.endsWith(".subpath")) return "subpath";
  return field.endsWith(".url") ? "url" : "folder";
}

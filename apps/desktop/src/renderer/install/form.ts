import type { AbsPath, AgentId, Intent, Selection, SourceSpec } from "@gandalf/skills";
import type { Flow } from "../changes/writeFlow";
import { NO_REMOTE_REF } from "../vocabulary";

export type SourceKind = "folder" | "git";

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
}

export type FieldName = "folder" | "url" | "ref" | "subpath" | "agents";

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
    source: "folder",
    folder: "",
    chosen: null,
    url: "",
    ref: "",
    subpath: "",
    agents: installed,
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
  if (agents === null) return fail("agents", "Choose at least one agent to link it into.");
  return { ok: true, value: { kind: "install", source: source.value, agents } };
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

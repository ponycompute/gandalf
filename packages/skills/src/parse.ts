// Boundary parsers for the two values callers send in: intents and plan tokens.
//
// The CLI builds a raw object from argv and the Electron main process receives one over IPC. Both
// go through parseIntent, so there is one validation path for every way an intent enters the system.
// Only syntax is checked here. "Is this skill in the library" is the planner's job.

import { isAbsolute, normalize } from "node:path";
import { isAgentId, type AgentId } from "./agents.js";
import type {
  AbsPath,
  AdoptPick,
  CommitPin,
  ContentHash,
  GitCommit,
  Intent,
  ModeSetting,
  PlanFingerprint,
  PlanToken,
  Selection,
  SkillName,
  SourceSpec,
} from "./types.js";

export class InputError extends Error {
  constructor(
    /** Dotted path of the offending field, e.g. "source.url" or "agents[1]". */
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
  }
}

export function parseSkillName(raw: string): SkillName | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw) && !raw.includes("..")
    ? (raw as SkillName)
    : null;
}

export function parseAbsPath(raw: string): AbsPath | null {
  return isAbsolute(raw) ? (normalize(raw).replace(/(.)\/+$/, "$1") as AbsPath) : null;
}

export function parseContentHash(raw: unknown): ContentHash | null {
  return typeof raw === "string" && /^sha256:[0-9a-f]{64}$/.test(raw) ? (raw as ContentHash) : null;
}

type Parse<T> = (raw: unknown, field: string) => T;

/** Throws InputError. Agent ids are checked against the registry; paths must be absolute. */
export function parseIntent(raw: unknown): Intent {
  const intent = object(raw, "intent");
  switch (intent.kind) {
    case "sync":
      return { kind: "sync", skills: selection(intent.skills, "skills", skillName) };
    case "setEnabled":
      if (typeof intent.enabled !== "boolean") throw new InputError("enabled", "must be a boolean");
      return {
        kind: "setEnabled",
        skill: skillName(intent.skill, "skill"),
        enabled: intent.enabled,
        agents: selection(intent.agents, "agents", agentId),
      };
    case "adopt":
      return {
        kind: "adopt",
        names: selection(intent.names, "names", skillName),
        pick: list(intent.pick ?? [], "pick", adoptPick),
      };
    case "keep": {
      const hash = parseContentHash(intent.hash);
      if (hash === null) throw new InputError("hash", "must be sha256:<64 hex>");
      return { kind: "keep", name: skillName(intent.name, "name"), hash };
    }
    case "replace":
      return { kind: "replace", skill: skillName(intent.skill, "skill") };
    case "install":
      return {
        kind: "install",
        source: sourceSpec(intent.source, "source"),
        agents: selection(intent.agents, "agents", agentId),
        ...(intent.also === undefined ? {} : { also: list(intent.also, "also", sourceSpec) }),
      };
    case "update":
      return {
        kind: "update",
        skills: selection(intent.skills, "skills", skillName),
        pins: list(intent.pins ?? [], "pins", commitPin),
      };
    case "remove":
      return { kind: "remove", skill: skillName(intent.skill, "skill") };
    case "configureAgent":
      return {
        kind: "configureAgent",
        agent: agentId(intent.agent, "agent"),
        skillsDir: intent.skillsDir === null ? null : absPath(intent.skillsDir, "skillsDir"),
        mode: intent.mode === null ? null : modeSetting(intent.mode, "mode"),
      };
    case "configureProject":
      return {
        kind: "configureProject",
        path: absPath(intent.path, "path"),
        agents: [...new Set(list(intent.agents, "agents", agentId))],
      };
    case "removeProject":
      return { kind: "removeProject", path: absPath(intent.path, "path") };
    case "setProjectSkills": {
      if (typeof intent.enabled !== "boolean") throw new InputError("enabled", "must be a boolean");
      const skills = list(intent.skills, "skills", skillName);
      if (skills.length === 0) throw new InputError("skills", "must be a non-empty list");
      return {
        kind: "setProjectSkills",
        project: absPath(intent.project, "project"),
        skills,
        enabled: intent.enabled,
      };
    }
    default:
      throw new InputError("kind", `unknown intent ${JSON.stringify(intent.kind)}`);
  }
}

/** Throws InputError. Steps a caller sends along are ignored: apply re-derives them. */
export function parsePlanToken(raw: unknown): PlanToken {
  const token = object(raw, "token");
  if (typeof token.fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(token.fingerprint)) {
    throw new InputError("fingerprint", "must be sha256:<64 hex>");
  }
  return {
    intent: parseIntent(token.intent),
    fingerprint: token.fingerprint as PlanFingerprint,
  };
}

function object(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputError(field, "must be an object");
  }
  return raw as Record<string, unknown>;
}

function list<T>(raw: unknown, field: string, item: Parse<T>): T[] {
  if (!Array.isArray(raw)) throw new InputError(field, "must be a list");
  return raw.map((value, index) => item(value, `${field}[${index}]`));
}

function selection<T>(raw: unknown, field: string, item: Parse<T>): Selection<T> {
  if (raw === "all") return "all";
  const items = list(raw, field, item);
  if (items.length === 0) throw new InputError(field, `must be "all" or a non-empty list`);
  return items;
}

const skillName: Parse<SkillName> = (raw, field) => {
  const name = typeof raw === "string" ? parseSkillName(raw) : null;
  if (name === null) throw new InputError(field, `not a skill name: ${JSON.stringify(raw)}`);
  return name;
};

const agentId: Parse<AgentId> = (raw, field) => {
  if (typeof raw !== "string" || !isAgentId(raw)) {
    throw new InputError(field, `unknown agent ${JSON.stringify(raw)}`);
  }
  return raw;
};

const absPath: Parse<AbsPath> = (raw, field) => {
  const path = typeof raw === "string" ? parseAbsPath(raw) : null;
  if (path === null) throw new InputError(field, "must be an absolute path");
  return path;
};

const modeSetting: Parse<ModeSetting> = (raw, field) => {
  if (raw !== "auto" && raw !== "link" && raw !== "copy") {
    throw new InputError(field, `must be auto, link or copy`);
  }
  return raw;
};

const gitCommit: Parse<GitCommit> = (raw, field) => {
  if (typeof raw !== "string" || !/^[0-9a-f]{40}$/.test(raw)) {
    throw new InputError(field, "must be a 40-hex commit id");
  }
  return raw as GitCommit;
};

const adoptPick: Parse<AdoptPick> = (raw, field) => {
  const pick = object(raw, field);
  const name = skillName(pick.name, `${field}.name`);
  if (pick.kind === "agent")
    return { name, kind: "agent", agent: agentId(pick.agent, `${field}.agent`) };
  if (pick.kind !== "hash") throw new InputError(`${field}.kind`, "must be hash or agent");
  const hash = parseContentHash(pick.hash);
  if (hash === null) throw new InputError(`${field}.hash`, "must be sha256:<64 hex>");
  return { name, kind: "hash", hash };
};

const commitPin: Parse<CommitPin> = (raw, field) => {
  const pin = object(raw, field);
  return {
    skill: skillName(pin.skill, `${field}.skill`),
    commit: gitCommit(pin.commit, `${field}.commit`),
  };
};

/** A value that git receives positionally. A leading "-" would read as an option. */
function gitArgument(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw === "" || raw.startsWith("-")) {
    throw new InputError(field, "must be a non-empty string not starting with '-'");
  }
  return raw;
}

function sourceSpec(raw: unknown, field: string): SourceSpec {
  const source = object(raw, field);
  if (source.kind === "local")
    return { kind: "local", path: absPath(source.path, `${field}.path`) };
  if (source.kind !== "git") throw new InputError(`${field}.kind`, "must be local or git");
  const subpath = source.subpath ?? null;
  if (
    subpath !== null &&
    (typeof subpath !== "string" ||
      subpath === "" ||
      subpath.startsWith("/") ||
      subpath.split("/").some((segment) => segment === ".." || segment.startsWith("-")))
  ) {
    throw new InputError(`${field}.subpath`, "must be a relative path inside the repo");
  }
  const skill = source.skill == null ? null : skillName(source.skill, `${field}.skill`);
  if (skill !== null && subpath !== null) {
    throw new InputError(`${field}.skill`, "must be left out when subpath is given");
  }
  return {
    kind: "git",
    url: gitArgument(source.url, `${field}.url`),
    ref: source.ref == null ? null : gitArgument(source.ref, `${field}.ref`),
    subpath: subpath === null ? null : normalize(subpath).replace(/\/+$/, ""),
    skill,
    commit: source.commit == null ? null : gitCommit(source.commit, `${field}.commit`),
  };
}

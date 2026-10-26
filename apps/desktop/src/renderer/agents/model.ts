import type { AgentId, AgentView, Intent, Mode, ModeSetting, Snapshot } from "@gandalf/skills";
import type { Names } from "../vocabulary";

/** A folder an agent reads, with every installed agent that reads it too. */
export interface ReadFolder {
  readonly path: string;
  /** Installed agents that load skills from it, this one included. Empty when gandalf skips it. */
  readonly readers: readonly AgentId[];
}

export interface AgentRow {
  readonly agent: AgentView;
  /** Where gandalf puts this agent's skills. */
  readonly skillsFolder: ReadFolder;
  /** Folders the agent also reads skills from, which gandalf only reads. */
  readonly scanFolders: readonly ReadFolder[];
  /** An agent that is not installed has nothing gandalf can change for it yet. */
  readonly actionable: boolean;
}

/**
 * Every agent in registry order, as the CLI's `agents` lists them. A root's path is a realpath, so
 * a folder is matched to its root by the agent that reads it, not by its spelling: the skills dir
 * is the root this agent targets, and every other root it reads is one of its scan dirs.
 */
export function agentRows(snapshot: Snapshot): readonly AgentRow[] {
  return snapshot.agents.map((agent) => {
    const roots = snapshot.roots.filter((root) => root.readers.includes(agent.id));
    const target = roots.find((root) => root.targets.includes(agent.id));
    const scans = roots.filter((root) => root !== target);
    return {
      agent,
      skillsFolder: {
        path: target?.path ?? agent.skillsDir,
        readers: target?.readers ?? [],
      },
      scanFolders: agent.installed
        ? scans.map((root) => ({ path: root.path, readers: root.readers }))
        : agent.scanDirs.map((path) => ({ path, readers: [] })),
      actionable: agent.installed,
    };
  });
}

/** How many library skills are on for `agent`. */
export function skillsOn(snapshot: Snapshot, agent: AgentId): number {
  return snapshot.skills.filter((skill) =>
    skill.cells.some((cell) => cell.agent === agent && cell.enabled),
  ).length;
}

const AND = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** "Read by Codex and GitHub Copilot", for a folder more than one agent reads; null otherwise. */
export function readersLine(folder: ReadFolder, names: Names): string | null {
  if (folder.readers.length < 2) return null;
  return `Read by ${AND.format(folder.readers.map(names.agent))}`;
}

export const MODE_SEGMENTS = [
  { value: "auto", label: "Auto" },
  { value: "link", label: "Link" },
  { value: "copy", label: "Copy" },
] as const satisfies readonly { readonly value: ModeSetting; readonly label: string }[];

/** What each mode does, for the line under the control. */
export const MODE_HINT: Readonly<Record<Mode, string>> = {
  link: "Links each skill to the library, so edits there show at once.",
  copy: "Copies each skill, for an agent that does not follow links.",
};

/** Whether an override moves the agent's skills dir, rather than only setting its mode. */
export function hasCustomFolder(agent: AgentView): boolean {
  return agent.skillsDir !== agent.builtInSkillsDir;
}

/**
 * The configureAgent intent for one change. It sets the dir and the mode together, null restoring
 * either default, so changing one passes the other on as it stands; Reset restores both.
 */
export function configure(
  agent: AgentView,
  change: { readonly skillsDir: string } | { readonly mode: ModeSetting } | "reset",
): Intent {
  const base = { kind: "configureAgent", agent: agent.id } as const;
  if (change === "reset") return { ...base, skillsDir: null, mode: null };
  const skillsDir =
    "skillsDir" in change
      ? (change.skillsDir as AgentView["skillsDir"])
      : hasCustomFolder(agent)
        ? agent.skillsDir
        : null;
  const mode = "mode" in change ? change.mode : agent.mode;
  return { ...base, skillsDir, mode: mode === "auto" ? null : mode };
}

/** Whether `folder` lies in gandalf's own folder, where no agent's skills may go. */
export function insideGandalf(folder: string, gandalfFolder: string): boolean {
  return folder === gandalfFolder || folder.startsWith(`${gandalfFolder}/`);
}

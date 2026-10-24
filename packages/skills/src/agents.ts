// Agent adapter registry.
//
// This table is the single list of agents. AgentId is derived from it, so adding an agent is one
// row and every exhaustive switch or Record<AgentId, ...> fails to compile until it handles the row.

import { join, sep } from "node:path";
import type { Fs } from "./env.js";
import type { AbsPath, ModeSetting, RootRole } from "./types.js";

interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Relative to HOME. Where gandalf projects skills. */
  readonly skillsDir: string;
  /** Relative to HOME. The agent counts as installed when this exists. */
  readonly detectDir: string;
  /** Relative to HOME. Read-only discovery dirs, scanned for adoption, never written by sync. */
  readonly scanDirs: readonly string[];
}

const AGENTS = [
  {
    id: "cursor",
    displayName: "Cursor",
    skillsDir: ".cursor/skills",
    detectDir: ".cursor",
    scanDirs: [],
  },
  {
    id: "claude_code",
    displayName: "Claude Code",
    skillsDir: ".claude/skills",
    detectDir: ".claude",
    scanDirs: [],
  },
  {
    id: "omp_agent",
    displayName: "OMP Agent",
    skillsDir: ".omp/agent/skills",
    detectDir: ".omp/agent",
    scanDirs: [],
  },
  {
    id: "codex",
    displayName: "Codex",
    skillsDir: ".codex/skills",
    detectDir: ".codex",
    scanDirs: [".agents/skills"],
  },
  { id: "grok", displayName: "Grok", skillsDir: ".grok/skills", detectDir: ".grok", scanDirs: [] },
  {
    id: "opencode",
    displayName: "OpenCode",
    skillsDir: ".config/opencode/skills",
    detectDir: ".config/opencode",
    scanDirs: [],
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    skillsDir: ".gemini/antigravity/skills",
    detectDir: ".gemini/antigravity",
    scanDirs: [],
  },
  {
    id: "amp",
    displayName: "Amp",
    skillsDir: ".config/agents/skills",
    detectDir: ".config/agents",
    scanDirs: [],
  },
  {
    id: "kilo_code",
    displayName: "Kilo Code",
    skillsDir: ".kilocode/skills",
    detectDir: ".kilocode",
    scanDirs: [],
  },
  {
    id: "roo_code",
    displayName: "Roo Code",
    skillsDir: ".roo/skills",
    detectDir: ".roo",
    scanDirs: [],
  },
  {
    id: "goose",
    displayName: "Goose",
    skillsDir: ".config/goose/skills",
    detectDir: ".config/goose",
    scanDirs: [],
  },
  {
    id: "gemini_cli",
    displayName: "Gemini CLI",
    skillsDir: ".gemini/skills",
    detectDir: ".gemini",
    scanDirs: [],
  },
  {
    id: "github_copilot",
    displayName: "GitHub Copilot",
    skillsDir: ".copilot/skills",
    detectDir: ".copilot",
    scanDirs: [".agents/skills"],
  },
] as const satisfies readonly AgentAdapter[];

export type AgentId = (typeof AGENTS)[number]["id"];

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id);

export function isAgentId(raw: string): raw is AgentId {
  return AGENTS.some((agent) => agent.id === raw);
}

/** Registry order, which every list of agents follows. */
export function byRegistryOrder(agents: Iterable<AgentId>): AgentId[] {
  const wanted = new Set(agents);
  return AGENT_IDS.filter((id) => wanted.has(id));
}

export interface AgentOverride {
  readonly skillsDir: AbsPath | null;
  readonly mode: ModeSetting | null;
}

export type AgentOverrides = Readonly<Partial<Record<AgentId, AgentOverride>>>;

/** Filesystem facts gathered once per observation. Resolution over them is pure. */
export interface AgentFacts {
  readonly home: AbsPath;
  readonly gandalfDir: AbsPath;
  readonly installed: readonly AgentId[];
  /** realpath of every candidate dir that exists. Missing dirs are absent from the map. */
  readonly realpaths: ReadonlyMap<AbsPath, AbsPath>;
}

/** Stats detect dirs and realpaths every built-in, overridden, and `extraDirs` candidate. */
export async function gatherAgentFacts(
  fs: Fs,
  home: AbsPath,
  gandalfDir: AbsPath,
  extraDirs: readonly AbsPath[],
): Promise<AgentFacts> {
  const installed: AgentId[] = [];
  const candidates = new Set<AbsPath>([gandalfDir, ...extraDirs]);
  for (const agent of AGENTS) {
    if ((await fs.stat(at(home, agent.detectDir))) === "dir") installed.push(agent.id);
    candidates.add(at(home, agent.skillsDir));
    for (const dir of agent.scanDirs) candidates.add(at(home, dir));
  }
  const realpaths = new Map<AbsPath, AbsPath>();
  for (const dir of candidates) {
    const real = await fs.realpath(dir);
    if (real !== null) realpaths.set(dir, real);
  }
  return { home, gandalfDir, installed, realpaths };
}

export interface ResolvedAgent {
  readonly id: AgentId;
  readonly displayName: string;
  readonly installed: boolean;
  readonly detectDir: AbsPath;
  readonly skillsDir: AbsPath;
  readonly scanDirs: readonly AbsPath[];
  readonly mode: ModeSetting;
  readonly overridden: boolean;
  /** The skills dir lies inside ~/.gandalf, so gandalf never reads or writes it as a root. */
  readonly guarded: boolean;
}

/**
 * A directory gandalf observes. Agents resolve to roots, deduplicated by realpath, so two agents
 * sharing ~/.agents/skills, or overrides pointing two agents at one dir, yield one root. A path that
 * is a target for any installed agent is a target root.
 */
export interface Root {
  /** The realpath when the dir exists, so every alias of one dir maps to one root. */
  readonly path: AbsPath;
  readonly role: RootRole;
  readonly readers: readonly AgentId[];
  readonly targets: readonly AgentId[];
}

export interface ResolvedAgents {
  /** Every agent in registry order, installed or not. */
  readonly agents: readonly ResolvedAgent[];
  /** Roots of installed agents only, sorted by path. */
  readonly roots: readonly Root[];
}

/**
 * Pure. Called with the current overrides for a snapshot and with the next overrides when a plan
 * changes them (configureAgent), so the old and new roots come out of one function.
 */
export function resolveAgents(facts: AgentFacts, overrides: AgentOverrides): ResolvedAgents {
  const keyOf = (dir: AbsPath): AbsPath => facts.realpaths.get(dir) ?? dir;
  const gandalfReal = keyOf(facts.gandalfDir);
  const guarded = (dir: AbsPath): boolean =>
    isInside(dir, facts.gandalfDir) || isInside(keyOf(dir), gandalfReal);

  const agents = AGENTS.map((adapter): ResolvedAgent => {
    const override = overrides[adapter.id];
    const skillsDir = override?.skillsDir ?? at(facts.home, adapter.skillsDir);
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      installed: facts.installed.includes(adapter.id),
      detectDir: at(facts.home, adapter.detectDir),
      skillsDir,
      scanDirs: adapter.scanDirs.map((dir) => at(facts.home, dir)),
      mode: override?.mode ?? "auto",
      overridden: override !== undefined,
      guarded: guarded(skillsDir),
    };
  });

  const roots = new Map<AbsPath, { readers: Set<AgentId>; targets: Set<AgentId> }>();
  const add = (dir: AbsPath, agent: AgentId, target: boolean): void => {
    if (guarded(dir)) return;
    const key = keyOf(dir);
    const root = roots.get(key) ?? { readers: new Set(), targets: new Set() };
    root.readers.add(agent);
    if (target) root.targets.add(agent);
    roots.set(key, root);
  };
  for (const agent of agents) {
    if (!agent.installed) continue;
    add(agent.skillsDir, agent.id, true);
    for (const dir of agent.scanDirs) add(dir, agent.id, false);
  }

  return {
    agents,
    roots: [...roots]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, root]) => ({
        path,
        role: root.targets.size > 0 ? "target" : "scan",
        readers: byRegistryOrder(root.readers),
        targets: byRegistryOrder(root.targets),
      })),
  };
}

/** The root an agent writes to, if it has one. */
export function targetRootOf(roots: readonly Root[], agent: AgentId): Root | undefined {
  return roots.find((root) => root.targets.includes(agent));
}

function at(home: AbsPath, relative: string): AbsPath {
  return join(home, relative) as AbsPath;
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

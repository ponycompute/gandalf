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
  /** Relative to HOME. The agent counts as installed when any of these exists. */
  readonly detectDirs: readonly string[];
  /** Relative to HOME. Read-only discovery dirs, scanned for adoption, never written by sync. */
  readonly scanDirs: readonly string[];
  /**
   * Relative to HOME. Skills dirs earlier versions of gandalf wrote to that the agent still reads.
   * Nothing is desired there, so sync removes the links and clean copies gandalf left, which would
   * otherwise load next to the ones in skillsDir, and leaves everything else alone.
   */
  readonly retiredDirs: readonly string[];
}

const AGENTS = [
  {
    id: "cursor",
    displayName: "Cursor",
    skillsDir: ".cursor/skills",
    detectDirs: [".cursor"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    id: "claude_code",
    displayName: "Claude Code",
    skillsDir: ".claude/skills",
    detectDirs: [".claude"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    id: "omp_agent",
    displayName: "OMP Agent",
    skillsDir: ".omp/agent/skills",
    detectDirs: [".omp/agent"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    id: "codex",
    displayName: "Codex",
    skillsDir: ".codex/skills",
    detectDirs: [".codex"],
    scanDirs: [".agents/skills"],
    retiredDirs: [],
  },
  {
    id: "grok",
    displayName: "Grok",
    skillsDir: ".grok/skills",
    detectDirs: [".grok"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    skillsDir: ".config/opencode/skills",
    detectDirs: [".config/opencode"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    // The App and the IDE share ~/.gemini/config. The IDE still reads its old skills dir as well.
    id: "antigravity",
    displayName: "Antigravity",
    skillsDir: ".gemini/config/skills",
    detectDirs: [".gemini/config", ".gemini/antigravity"],
    scanDirs: [],
    retiredDirs: [".gemini/antigravity/skills"],
  },
  {
    id: "antigravity_cli",
    displayName: "Antigravity CLI",
    skillsDir: ".gemini/antigravity-cli/skills",
    detectDirs: [".gemini/antigravity-cli"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    id: "amp",
    displayName: "Amp",
    skillsDir: ".config/agents/skills",
    detectDirs: [".config/agents"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    // Kilo always creates its XDG config dir. ~/.kilocode alone is the legacy extension, which does
    // not read ~/.kilo/skills, so it does not count; current Kilo still reads ~/.kilocode/skills.
    id: "kilo_code",
    displayName: "Kilo Code",
    skillsDir: ".kilo/skills",
    detectDirs: [".config/kilo", ".kilo"],
    scanDirs: [],
    retiredDirs: [".kilocode/skills"],
  },
  {
    id: "roo_code",
    displayName: "Roo Code",
    skillsDir: ".roo/skills",
    detectDirs: [".roo"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    id: "goose",
    displayName: "Goose",
    skillsDir: ".config/goose/skills",
    detectDirs: [".config/goose"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    id: "gemini_cli",
    displayName: "Gemini CLI",
    skillsDir: ".gemini/skills",
    detectDirs: [".gemini"],
    scanDirs: [],
    retiredDirs: [],
  },
  {
    id: "github_copilot",
    displayName: "GitHub Copilot",
    skillsDir: ".copilot/skills",
    detectDirs: [".copilot"],
    scanDirs: [".agents/skills"],
    retiredDirs: [],
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

/** Where `agent` keeps its skills without an override. */
export function builtInSkillsDir(home: AbsPath, agent: AgentId): AbsPath {
  const adapter = AGENTS.find((candidate) => candidate.id === agent);
  if (adapter === undefined) throw new Error(`unknown agent ${agent}`);
  return at(home, adapter.skillsDir);
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
    let found = false;
    for (const dir of agent.detectDirs) {
      if ((await fs.stat(at(home, dir))) === "dir") found = true;
      candidates.add(at(home, dir));
    }
    if (found) installed.push(agent.id);
    candidates.add(at(home, agent.skillsDir));
    for (const dir of [...agent.scanDirs, ...agent.retiredDirs]) candidates.add(at(home, dir));
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
  /** Watched while they exist, so installing or removing the agent refreshes the snapshot. */
  readonly detectDirs: readonly AbsPath[];
  readonly skillsDir: AbsPath;
  /** The skills dir the agent uses without an override. */
  readonly builtInSkillsDir: AbsPath;
  readonly scanDirs: readonly AbsPath[];
  readonly retiredDirs: readonly AbsPath[];
  readonly mode: ModeSetting;
  readonly overridden: boolean;
  /** The skills dir lies inside ~/.gandalf, so gandalf never reads or writes it as a root. */
  readonly guarded: boolean;
}

/**
 * A directory gandalf observes. Agents resolve to roots, deduplicated by realpath, so two agents
 * sharing ~/.agents/skills, or overrides pointing two agents at one dir, yield one root. A path that
 * is a target for any installed agent, or a retired skills dir of one, is a target root.
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
    const builtInSkillsDir = at(facts.home, adapter.skillsDir);
    const skillsDir = override?.skillsDir ?? builtInSkillsDir;
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      installed: facts.installed.includes(adapter.id),
      detectDirs: adapter.detectDirs.map((dir) => at(facts.home, dir)),
      skillsDir,
      builtInSkillsDir,
      scanDirs: adapter.scanDirs.map((dir) => at(facts.home, dir)),
      retiredDirs: adapter.retiredDirs.map((dir) => at(facts.home, dir)),
      mode: override?.mode ?? "auto",
      overridden: override !== undefined,
      guarded: guarded(skillsDir),
    };
  });

  const roots = new Map<
    AbsPath,
    { readers: Set<AgentId>; targets: Set<AgentId>; retired: boolean }
  >();
  const add = (dir: AbsPath, agent: AgentId, as: "target" | "scan" | "retired"): void => {
    if (guarded(dir)) return;
    const key = keyOf(dir);
    const root = roots.get(key) ?? { readers: new Set(), targets: new Set(), retired: false };
    root.readers.add(agent);
    if (as === "target") root.targets.add(agent);
    if (as === "retired") root.retired = true;
    roots.set(key, root);
  };
  for (const agent of agents) {
    if (!agent.installed) continue;
    add(agent.skillsDir, agent.id, "target");
    for (const dir of agent.scanDirs) add(dir, agent.id, "scan");
    for (const dir of agent.retiredDirs) add(dir, agent.id, "retired");
  }

  return {
    agents,
    roots: [...roots]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, root]) => ({
        path,
        // A retired dir is a target nobody desires anything in, so gandalf's leftovers come out extra.
        role: root.targets.size > 0 || root.retired ? "target" : "scan",
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

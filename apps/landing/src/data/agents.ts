export interface AgentEntry {
  /** The AgentId in packages/skills/src/agents.ts. agents.test.ts fails when the two drift. */
  readonly id: string;
  readonly name: string;
  /** The default skills folder, under ~. */
  readonly dir: string;
  /** File in public/agents. Marks are from @lobehub/icons-static-svg 1.100.0, except OMP's (omp.sh). */
  readonly logo: string;
  /** One-color marks take the label color so they read in both themes; the rest keep their colors. */
  readonly ink: boolean;
}

export const AGENTS: readonly AgentEntry[] = [
  {
    id: "claude_code",
    name: "Claude Code",
    dir: "~/.claude/skills",
    logo: "claude-color.svg",
    ink: false,
  },
  { id: "codex", name: "Codex", dir: "~/.codex/skills", logo: "openai.svg", ink: true },
  { id: "cursor", name: "Cursor", dir: "~/.cursor/skills", logo: "cursor.svg", ink: true },
  {
    id: "gemini_cli",
    name: "Gemini CLI",
    dir: "~/.gemini/skills",
    logo: "geminicli-color.svg",
    ink: false,
  },
  {
    id: "github_copilot",
    name: "GitHub Copilot",
    dir: "~/.copilot/skills",
    logo: "githubcopilot.svg",
    ink: true,
  },
  {
    id: "opencode",
    name: "OpenCode",
    dir: "~/.config/opencode/skills",
    logo: "opencode.svg",
    ink: true,
  },
  {
    id: "antigravity",
    name: "Antigravity",
    dir: "~/.gemini/antigravity/skills",
    logo: "antigravity-color.svg",
    ink: false,
  },
  { id: "amp", name: "Amp", dir: "~/.config/agents/skills", logo: "amp-color.svg", ink: false },
  { id: "goose", name: "Goose", dir: "~/.config/goose/skills", logo: "goose.svg", ink: true },
  {
    id: "kilo_code",
    name: "Kilo Code",
    dir: "~/.kilocode/skills",
    logo: "kilocode.svg",
    ink: true,
  },
  { id: "roo_code", name: "Roo Code", dir: "~/.roo/skills", logo: "roocode.svg", ink: true },
  { id: "grok", name: "Grok", dir: "~/.grok/skills", logo: "grok.svg", ink: true },
  { id: "omp_agent", name: "OMP Agent", dir: "~/.omp/agent/skills", logo: "omp.svg", ink: false },
];

export function findAgent(id: string): AgentEntry {
  const agent = AGENTS.find((entry) => entry.id === id);
  if (!agent) throw new Error(`No agent with id ${id}`);
  return agent;
}

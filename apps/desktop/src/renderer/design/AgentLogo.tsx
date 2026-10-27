import type { CSSProperties } from "react";
import type { AgentId } from "@gandalf/skills";

interface Logo {
  /** In ./agents, copied from the landing page's public/agents. */
  readonly file: string;
  /** One-color marks take the text color so they read in both themes; the rest keep their colors. */
  readonly ink: boolean;
}

/** The landing page's marks, from @lobehub/icons-static-svg 1.100.0 except OMP's (omp.sh). */
export const LOGOS: Readonly<Record<AgentId, Logo>> = {
  cursor: { file: "cursor.svg", ink: true },
  claude_code: { file: "claude-color.svg", ink: false },
  omp_agent: { file: "omp.svg", ink: false },
  codex: { file: "openai.svg", ink: true },
  grok: { file: "grok.svg", ink: true },
  opencode: { file: "opencode.svg", ink: true },
  antigravity: { file: "antigravity-color.svg", ink: false },
  antigravity_cli: { file: "antigravity-color.svg", ink: false },
  amp: { file: "amp-color.svg", ink: false },
  kilo_code: { file: "kilocode.svg", ink: true },
  roo_code: { file: "roocode.svg", ink: true },
  goose: { file: "goose.svg", ink: true },
  gemini_cli: { file: "geminicli-color.svg", ink: false },
  github_copilot: { file: "githubcopilot.svg", ink: true },
};

interface AgentLogoProps {
  readonly agent: AgentId;
  readonly size: number;
  readonly className?: string;
}

/** An agent's mark, decorative: the agent's name always sits beside it or in its label. */
export function AgentLogo({ agent, size, className = "" }: AgentLogoProps) {
  const { file, ink } = LOGOS[agent];
  const src = new URL(`./agents/${file}`, import.meta.url).href;
  if (ink) {
    return (
      <span
        aria-hidden="true"
        className={`block flex-none bg-current [mask:var(--logo)_center/contain_no-repeat] ${className}`}
        style={{ "--logo": `url("${src}")`, width: size, height: size } as CSSProperties}
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={`block flex-none ${className}`}
    />
  );
}

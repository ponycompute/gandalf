import Image from "next/image";
import type { CSSProperties } from "react";
import type { AgentEntry } from "@/data/agents";
import styles from "./AgentLogo.module.css";

interface AgentLogoProps {
  agent: AgentEntry;
  size: number;
  className?: string;
}

/** An agent's mark. One-ink marks are drawn as a mask in the label color; the rest as images. */
export function AgentLogo({ agent, size, className = "" }: AgentLogoProps) {
  const src = `/agents/${agent.logo}`;
  if (agent.ink) {
    return (
      <span
        className={`${styles.logo} ${styles.ink} ${className}`}
        style={{ "--logo": `url("${src}")`, width: size, height: size } as CSSProperties}
        aria-hidden="true"
      />
    );
  }
  return (
    <Image className={`${styles.logo} ${className}`} src={src} alt="" width={size} height={size} />
  );
}

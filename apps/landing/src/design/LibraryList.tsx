import { findAgent } from "@/data/agents";
import type { SampleSkill } from "@/data/library";
import { AgentLogo } from "./AgentLogo";
import styles from "./LibraryList.module.css";

/** How many marks a row shows before it sums up the rest as +N, as the app does. */
const STACK = 4;

export function Warning() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

function AgentStack({ skill }: { skill: SampleSkill }) {
  if (skill.on.length === 0) return <span className={styles.none}>Not in any agent</span>;
  const shown = skill.on.slice(0, STACK);
  return (
    <span className={styles.stack}>
      <span className={styles.marks} aria-hidden="true">
        {shown.map((id) => (
          <span key={id} className={styles.mark}>
            <AgentLogo agent={findAgent(id)} size={14} />
          </span>
        ))}
        {skill.on.length > shown.length ? (
          <span className={styles.more}>+{skill.on.length - shown.length}</span>
        ) : null}
      </span>
      <span className={styles.count}>
        {skill.on.length} {skill.on.length === 1 ? "agent" : "agents"}
      </span>
    </span>
  );
}

interface LibraryListProps {
  skills: readonly SampleSkill[];
  selected?: string | null;
  onSelect?: (name: string) => void;
  /** Laid out at the page's width, so it reflows on a phone instead of scaling as a picture. */
  fluid?: boolean;
}

/** The app's Library: one row per skill, a pill when something needs fixing, the agents it is on. */
export function LibraryList({
  skills,
  selected = null,
  onSelect,
  fluid = false,
}: LibraryListProps) {
  return (
    <div className={`${styles.list} ${fluid ? styles.fluid : ""}`}>
      {skills.map((skill) => (
        <div
          key={skill.name}
          className={styles.row}
          aria-selected={skill.name === selected}
          onClick={onSelect === undefined ? undefined : () => onSelect(skill.name)}
        >
          <span className={styles.text}>
            <span className={styles.name}>{skill.name}</span>
            <span className={styles.desc}>{skill.description}</span>
          </span>
          {skill.problem === undefined ? null : (
            <span className={`${styles.pill} ${styles[skill.problem.tone]}`}>
              <Warning />
              {skill.problem.pill}
            </span>
          )}
          <AgentStack skill={skill} />
        </div>
      ))}
    </div>
  );
}

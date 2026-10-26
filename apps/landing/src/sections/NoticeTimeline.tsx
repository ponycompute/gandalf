import { findAgent } from "@/data/agents";
import { AgentLogo } from "@/design/AgentLogo";
import styles from "./NoticeTimeline.module.css";

interface Entry {
  day: string;
  time: string;
  title: string;
  /** Set on the agent sessions that repeat the same work; they are drawn as cards. */
  agent?: string;
  detail?: string;
  tag?: { text: string; tone: "accent" | "ink" };
}

// Newest first, the way the timeline reads. The repeats match the evidence in the hero's draft.
const ENTRIES: readonly Entry[] = [
  {
    day: "Fri",
    time: "16:20",
    agent: "cursor",
    title: "Release again",
    detail: "“release again, same as last time”",
    tag: { text: "3rd time · Drafting", tone: "accent" },
  },
  { day: "Thu", time: "11:02", title: "Figma · Library matrix" },
  {
    day: "Wed",
    time: "13:20",
    agent: "codex",
    title: "The same release steps",
    detail: "Bump, e2e, build the DMG, tag",
    tag: { text: "Seen Monday", tone: "ink" },
  },
  { day: "Tue", time: "09:12", title: "Slack · standup notes" },
  {
    day: "Mon",
    time: "10:05",
    agent: "claude_code",
    title: "Release the desktop app",
    detail: "Bump, run e2e, build the dmg, tag",
  },
];

/** The Notice step: a local timeline where the repeated release stands out. */
export function NoticeTimeline() {
  return (
    <div className={styles.timeline}>
      {ENTRIES.map((entry) => (
        <div key={entry.day} className={`${styles.entry} ${entry.agent ? styles.hit : styles.dim}`}>
          <span className={styles.when}>
            {entry.day}
            <b>{entry.time}</b>
          </span>
          <span className={styles.ruler} aria-hidden="true" />
          <div className={styles.body}>
            <div className={styles.title}>
              {entry.agent && <AgentLogo agent={findAgent(entry.agent)} size={14} />}
              <span className={styles.titleText}>{entry.title}</span>
            </div>
            {entry.detail && <div className={styles.detail}>{entry.detail}</div>}
            {entry.tag && (
              <span className={`${styles.tag} ${styles[entry.tag.tone]}`}>{entry.tag.text}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

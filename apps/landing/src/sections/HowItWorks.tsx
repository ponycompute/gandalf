import type { ReactNode } from "react";
import { findAgent } from "@/data/agents";
import { AgentLogo } from "@/design/AgentLogo";
import { Dither } from "@/design/Dither";
import { NoticeTimeline } from "./NoticeTimeline";
import { SectionHead } from "./SectionHead";
import styles from "./HowItWorks.module.css";

const DIFF = [
  { sign: " ", text: "# Release the desktop app" },
  { sign: "−", text: "2. Run the tests", kind: "remove" },
  { sign: "+", text: "2. Run the e2e lane", kind: "add" },
  { sign: " ", text: "3. Build and notarize the DMG" },
  { sign: "+", text: "4. Tag and update CHANGELOG", kind: "add" },
] as const;

// The sessions the draft came from, the same three the Notice timeline flags.
const SEEN_IN = ["claude_code", "codex", "cursor"] as const;

export function HowItWorks() {
  return (
    <section id="how">
      <div className="wrap">
        <SectionHead
          eyebrow={{ label: "How it works", href: "#faq" }}
          title="From the third repeat to a skill every agent reads."
        />
        <div className={styles.steps}>
          <Step
            fill
            lead="Notice."
            caption="gandalf keeps a timeline of your screen, calls and agent sessions on your Mac, and spots work that comes back."
          >
            <div className={styles.head}>
              <span className={styles.title}>Timeline</span>
              <span className={styles.note}>This week</span>
            </div>
            <NoticeTimeline />
          </Step>
          <Step
            lead="Draft."
            caption="It writes the SKILL.md and shows where each step came from. You approve, edit or dismiss it."
          >
            <div className={styles.head}>
              <span className={styles.title}>release-desktop</span>
              <span className={styles.pill}>Draft</span>
            </div>
            <div className={styles.seen}>
              <span className={styles.marks} aria-hidden="true">
                {SEEN_IN.map((id) => (
                  <span key={id} className={styles.mark}>
                    <AgentLogo agent={findAgent(id)} size={12} />
                  </span>
                ))}
              </span>
              Seen 3 times this week
            </div>
            <div className={styles.skillMd}>
              <div className={`gd-diff ${styles.diff}`}>
                {DIFF.map((line, index) => (
                  <div
                    key={index}
                    className={`gd-diff-line${"kind" in line ? ` gd-diff-${line.kind}` : ""}`}
                  >
                    <span className="gd-diff-sign">{line.sign}</span>
                    {line.text}
                  </div>
                ))}
              </div>
            </div>
            <div className={styles.actions}>
              <span className="gd-btn">Dismiss</span>
              <span className="gd-btn gd-btn-primary">Approve</span>
            </div>
          </Step>
          <Step
            lead="Link."
            caption="One library on disk, linked into each agent's skills folder. You see every change before it is made."
          >
            <div className={styles.sheetTitle}>Install release-desktop?</div>
            <div className={styles.tile}>
              <b>release-desktop</b>
              <span>Bump, run e2e, build the DMG, tag</span>
              <span>Drafted from 3 sessions</span>
            </div>
            <div className={styles.fact}>
              Adds it to your library
              <span className={styles.mono}>~/.gandalf/skills/release-desktop</span>
            </div>
            <div className={styles.fact}>
              Links it into Claude Code, Codex and Cursor
              <span>Each agent reads the library copy, so updates reach all three.</span>
            </div>
            <div className={styles.disclosure}>
              <span aria-hidden="true">›</span> Show the 3 changes on disk
            </div>
            <div className={styles.actions}>
              <span className="gd-btn">Cancel</span>
              <span className="gd-btn gd-btn-primary">Install</span>
            </div>
          </Step>
        </div>
      </div>
    </section>
  );
}

interface StepProps {
  lead: string;
  caption: string;
  /** Let the panel run off the bottom of the scene instead of floating in it. */
  fill?: boolean;
  children: ReactNode;
}

function Step({ lead, caption, fill = false, children }: StepProps) {
  return (
    <div>
      <div className={`${styles.scene} ${fill ? styles.sceneFill : ""}`}>
        <Dither />
        <div className={`${styles.panel} ${fill ? styles.fill : ""}`}>{children}</div>
      </div>
      <p className={styles.caption}>
        <b>{lead}</b> {caption}
      </p>
    </div>
  );
}

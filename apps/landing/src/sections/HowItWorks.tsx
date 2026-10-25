import type { ReactNode } from "react";
import { StatusGlyph } from "@/design/StatusGlyph";
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

const CHANGES = [
  { verdict: "missing", what: "Link release-desktop into Cursor", why: "Approved today" },
  { verdict: "missing", what: "Link release-desktop into Codex", why: "Approved today" },
  { verdict: "repair", what: "Fix review-pr in Gemini CLI", why: "The link points at an old copy" },
] as const;

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
            <PanelHead title="Timeline" note="this week" />
            <NoticeTimeline />
          </Step>
          <Step
            lead="Draft."
            caption="It writes the SKILL.md and shows where each step came from. You approve, edit or dismiss it."
          >
            <PanelHead title="release-desktop" note="draft" />
            <div className="gd-diff">
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
            <div className={styles.actions}>
              <span className="gd-btn">Edit</span>
              <span className="gd-btn gd-btn-primary">Approve</span>
            </div>
          </Step>
          <Step
            lead="Link."
            caption="One library on disk, linked into each agent's skills folder. You see every change before it is made."
          >
            <PanelHead title="Sync" note="3 changes" />
            {CHANGES.map((change) => (
              <div key={change.what} className="gd-change">
                <StatusGlyph verdict={change.verdict} withWord />
                <span>
                  {change.what}
                  <span className="gd-change-why">{change.why}</span>
                </span>
              </div>
            ))}
          </Step>
        </div>
      </div>
    </section>
  );
}

interface StepProps {
  lead: string;
  caption: string;
  /** Let the panel run off the bottom of the scene instead of sitting on it. */
  fill?: boolean;
  children: ReactNode;
}

function Step({ lead, caption, fill = false, children }: StepProps) {
  return (
    <div>
      <div className={styles.scene}>
        <div className={`${styles.panel} ${fill ? styles.fill : ""}`}>{children}</div>
      </div>
      <p className={styles.caption}>
        <b>{lead}</b> {caption}
      </p>
    </div>
  );
}

function PanelHead({ title, note }: { title: string; note: string }) {
  return (
    <div className={styles.panelHead}>
      {title}
      <span>{note}</span>
    </div>
  );
}

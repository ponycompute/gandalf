import type { ReactNode } from "react";
import { GITHUB_URL } from "@/data/links";
import { AGENT_COLUMNS, SAMPLE_SKILLS } from "@/data/skills";
import { SkillMatrix } from "@/design/SkillMatrix";
import { StatusGlyph } from "@/design/StatusGlyph";
import { SectionHead } from "./SectionHead";
import styles from "./Roadmap.module.css";

const ADOPT_DIFF = [
  { sign: " ", text: "## Checklist" },
  { sign: "−", text: "- Run the tests", kind: "remove" },
  { sign: "+", text: "- Run the tests and lint", kind: "add" },
  { sign: " ", text: "- Leave one summary comment" },
] as const;

export function Roadmap() {
  return (
    <section id="roadmap">
      <div className="wrap">
        <SectionHead
          eyebrow={{ label: "Roadmap", href: GITHUB_URL }}
          title="The library works today. Capture is next."
        />
        <div className={styles.bento}>
          <Card
            wide
            title="Library and sync"
            text="One folder of skills, linked into 13 agents. Every change is shown before it is made."
          >
            <div className={styles.panel}>
              <SkillMatrix skills={SAMPLE_SKILLS.slice(0, 5)} columns={AGENT_COLUMNS} compact />
            </div>
          </Card>
          <Card
            title="Discover and adopt"
            text="Pull skills you already wrote into the library. When copies differ, you pick the one to keep."
          >
            <div className={styles.panel}>
              <div className={styles.panelHead}>
                review-pr<span>2 copies</span>
              </div>
              <div className="gd-diff">
                {ADOPT_DIFF.map((line, index) => (
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
                <span className="gd-btn gd-btn-primary">Keep This Version</span>
              </div>
            </div>
          </Card>
          <Card title="Install" text="Add a skill from a local folder or a git URL.">
            <pre className={`${styles.panel} ${styles.term}`}>
              <span className={styles.prompt}>$</span> gandalf skills install \{"\n"}
              {"    "}github.com/acme/pdf-tools{"\n"}
              <StatusGlyph verdict="ok" /> pdf-tools linked into 13 agents
            </pre>
          </Card>
          <Card
            soon
            title="Capture"
            text="Screen, audio and agent sessions on one local timeline, kept on your Mac."
          >
            <div className={styles.sources}>
              <span>Screen</span>
              <span>Audio</span>
              <span>Agent sessions</span>
            </div>
          </Card>
          <Card
            soon
            title="Drafts"
            text="Repeated work turned into SKILL.md drafts, with the sessions they came from."
          >
            <pre className={`${styles.term} ${styles.sketch}`}>
              {"---\nname: release-desktop\ndescription: Ship the desktop app.\n---"}
            </pre>
          </Card>
        </div>
      </div>
    </section>
  );
}

interface CardProps {
  title: string;
  text: string;
  /** Spans two columns of the grid. */
  wide?: boolean;
  /** Not shipped yet. */
  soon?: boolean;
  children: ReactNode;
}

function Card({ title, text, wide = false, soon = false, children }: CardProps) {
  return (
    <article className={`${styles.card} ${wide ? styles.wide : ""} ${soon ? styles.soon : ""}`}>
      {soon && <span className={styles.badge}>Coming soon</span>}
      <h3>{title}</h3>
      <p>{text}</p>
      <div className={styles.visual}>{children}</div>
    </article>
  );
}

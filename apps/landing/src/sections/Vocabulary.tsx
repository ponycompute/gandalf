"use client";

import { useState } from "react";
import { SAMPLE_LIBRARY, verdictOf, type SampleAgent } from "@/data/library";
import { STATUS, VERDICTS } from "@/data/status";
import { LibraryList } from "@/design/LibraryList";
import { StatusGlyph } from "@/design/StatusGlyph";
import { SectionHead } from "./SectionHead";
import styles from "./Vocabulary.module.css";

const SKILLS = [
  "api-client",
  "design-review",
  "git-hygiene",
  "review-pull-request",
  "sql-helper",
].map((name) => SAMPLE_LIBRARY.find((skill) => skill.name === name)!);
// The agents as `gandalf skills list` heads its columns.
const COLUMNS: readonly SampleAgent[] = ["claude_code", "codex", "cursor", "gemini_cli"];
const NAME_WIDTH = 21;
const CELL_WIDTH = 13;

const pad = (text: string, width: number) => text + " ".repeat(Math.max(1, width - text.length));

type Pane = "app" | "cli";

/** The same five skills in the app's Library and as `gandalf skills list` prints them. */
export function Vocabulary() {
  const [pane, setPane] = useState<Pane>("app");

  return (
    <section className={styles.vocab}>
      <div className="wrap">
        <SectionHead
          eyebrow={{ label: "One vocabulary", href: "#cli" }}
          title="The app and the CLI read the same."
        >
          Every entry in an agent&apos;s folder gets one verdict. The app says what needs fixing in
          words; the CLI prints one glyph per agent.
        </SectionHead>
        <div className={styles.switch}>
          <div className="gd-seg" role="group" aria-label="Show the library in">
            {(["app", "cli"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="gd-seg-item"
                aria-pressed={pane === option}
                onClick={() => setPane(option)}
              >
                {option === "app" ? "App" : "CLI"}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.stage} id="cli">
          {pane === "app" ? (
            <div className={styles.app}>
              <LibraryList skills={SKILLS} fluid />
            </div>
          ) : (
            <pre className={styles.term}>
              <span className={styles.prompt}>$</span> gandalf skills list
              {"\n"}
              <span className={styles.prompt}>
                {pad("skill", NAME_WIDTH)}
                {COLUMNS.map((column) => pad(column, CELL_WIDTH)).join("")}
              </span>
              {SKILLS.map((skill) => (
                <span key={skill.name}>
                  {"\n"}
                  {pad(skill.name, NAME_WIDTH)}
                  {COLUMNS.map((column) => (
                    <span key={column}>
                      <StatusGlyph verdict={verdictOf(skill, column)} />
                      {" ".repeat(CELL_WIDTH - 1)}
                    </span>
                  ))}
                </span>
              ))}
              {"\n"}
              <span className={styles.prompt}>
                {VERDICTS.map((verdict) => `${STATUS[verdict].glyph} ${verdict}`).join("  ")}
              </span>
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}

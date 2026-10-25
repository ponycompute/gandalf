"use client";

import { useState } from "react";
import { SAMPLE_SKILLS } from "@/data/skills";
import { STATUS, VERDICTS } from "@/data/status";
import { SkillMatrix } from "@/design/SkillMatrix";
import { StatusGlyph } from "@/design/StatusGlyph";
import { SectionHead } from "./SectionHead";
import styles from "./Vocabulary.module.css";

const SKILLS = SAMPLE_SKILLS.slice(0, 5);
const COLUMNS = ["Claude", "Codex", "Cursor", "Gemini"];
const SUMMARY = "2 will add · 1 will update · 1 conflict · 1 not managed";
const NAME_WIDTH = 18;
const CELL_WIDTH = 8;

const pad = (text: string, width: number) => text + " ".repeat(Math.max(1, width - text.length));

type Pane = "app" | "cli";

/** The same five skills in the app's matrix and as `gandalf skills list` prints them. */
export function Vocabulary() {
  const [pane, setPane] = useState<Pane>("app");

  return (
    <section className={styles.vocab}>
      <div className="wrap">
        <SectionHead
          eyebrow={{ label: "One vocabulary", href: "#cli" }}
          title="The app and the CLI read the same."
        >
          Every entry in an agent&apos;s folder gets one verdict, shown with the same glyph in both
          places.
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
            <>
              <SkillMatrix skills={SKILLS} columns={COLUMNS} compact />
              <div className={styles.count}>
                {SKILLS.length} skills in {COLUMNS.length} agents · {SUMMARY}
              </div>
            </>
          ) : (
            <pre className={styles.term}>
              <span className={styles.prompt}>$</span> gandalf skills list
              {"\n"}
              <span className={styles.prompt}>
                {pad("skill", NAME_WIDTH)}
                {COLUMNS.map((column) => pad(column.toLowerCase(), CELL_WIDTH)).join("")}
              </span>
              {SKILLS.map((skill) => (
                <span key={skill.name}>
                  {"\n"}
                  {pad(skill.name, NAME_WIDTH)}
                  {skill.cells.slice(0, COLUMNS.length).map((verdict, column) => (
                    <span key={column}>
                      <StatusGlyph verdict={verdict} />
                      {" ".repeat(CELL_WIDTH - 1)}
                    </span>
                  ))}
                </span>
              ))}
              {"\n\n"}
              <span className={styles.prompt}>
                {SKILLS.length} skills · {COLUMNS.length} agents · {SUMMARY}
              </span>
            </pre>
          )}
        </div>
        <div className={styles.legend}>
          {VERDICTS.map((verdict) => (
            <span key={verdict} className="gd-status">
              <StatusGlyph verdict={verdict} />
              <span className={styles.word}>{STATUS[verdict].word}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { findAgent } from "@/data/agents";
import { librarySummary, SAMPLE_AGENTS, SAMPLE_LIBRARY, type SampleSkill } from "@/data/library";
import { AgentLogo } from "@/design/AgentLogo";
import { LibraryList, Warning } from "@/design/LibraryList";
import styles from "./AppWindow.module.css";

const ICONS = {
  library: (
    <>
      <rect x="4" y="4" width="6" height="16" rx="1.5" />
      <rect x="14" y="4" width="6" height="16" rx="1.5" />
    </>
  ),
  install: (
    <>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
} satisfies Record<string, ReactNode>;

const SECTIONS = [
  { label: "Library", icon: "library" },
  { label: "Install", icon: "install" },
] as const;

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}

/** The gandalf app as it is: the Library, and the selected skill's detail beside it. */
export function AppWindow() {
  const [selected, setSelected] = useState("git-hygiene");
  const skill = SAMPLE_LIBRARY.find((entry) => entry.name === selected) ?? SAMPLE_LIBRARY[0]!;

  return (
    <div
      className={`gd-window ${styles.window}`}
      role="img"
      aria-label="The gandalf app showing the Library: one row per skill with the agents it is on, and the selected skill's detail with a broken link to repair"
    >
      <div className="gd-window-traffic" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <nav className={`gd-source gd-glass ${styles.source}`} aria-hidden="true">
        {SECTIONS.map((section) => (
          <span
            key={section.label}
            className={`gd-source-item ${styles.item}`}
            aria-current={section.label === "Library" ? "page" : undefined}
          >
            <Icon name={section.icon} />
            <span className="gd-source-label">{section.label}</span>
          </span>
        ))}
        <span className={`gd-source-item ${styles.item} ${styles.settings}`}>
          <Icon name="settings" />
          <span className="gd-source-label">Settings</span>
        </span>
      </nav>

      <div className="gd-window-main">
        <div className="gd-toolbar">
          <div className="gd-toolbar-title">
            Library
            <span className="gd-toolbar-subtitle">{librarySummary(SAMPLE_LIBRARY)}</span>
          </div>
          <div className="gd-capsule" aria-hidden="true">
            <span className="gd-btn gd-btn-primary">Sync</span>
          </div>
        </div>
        <div className="gd-window-content">
          <LibraryList skills={SAMPLE_LIBRARY} selected={selected} onSelect={setSelected} />
        </div>
      </div>

      <SkillDetail skill={skill} />
    </div>
  );
}

function SkillDetail({ skill }: { skill: SampleSkill }) {
  const { problem } = skill;
  return (
    <aside className={`gd-glass ${styles.detail}`} aria-hidden="true">
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <span className={styles.title}>{skill.name}</span>
          <span className={styles.chrome}>···</span>
          <span className={styles.chrome}>×</span>
        </div>
        <p className={styles.description}>{skill.description}</p>
        <dl className={styles.facts}>
          <dt>Source</dt>
          <dd className={skill.source.startsWith("Adopted") ? undefined : styles.mono}>
            {skill.source}
          </dd>
          <dt>Library</dt>
          <dd className={styles.mono}>~/.gandalf/skills/{skill.name}</dd>
          <dt>Added</dt>
          <dd>Oct 26, 2026</dd>
        </dl>
        <div className={styles.agentsHead}>
          Agents
          <span>
            On in {skill.on.length} of {SAMPLE_AGENTS.length}
          </span>
        </div>
        <div className={styles.chips}>
          {SAMPLE_AGENTS.map((id) => {
            const agent = findAgent(id);
            const on = skill.on.includes(id);
            const hurt = problem?.agent === id;
            return (
              <span
                key={id}
                className={`${styles.chip} ${on ? styles.on : ""} ${hurt ? styles[problem.tone] : ""}`}
              >
                <AgentLogo agent={agent} size={14} />
                {agent.name}
                {hurt ? <Warning /> : on ? <span className={styles.tick}>✓</span> : null}
              </span>
            );
          })}
        </div>
        {problem === undefined ? null : (
          <div className={`${styles.banner} ${styles[problem.tone]}`}>
            <Warning />
            <span className={styles.bannerText}>{problem.line}</span>
            <b>{problem.action}</b>
          </div>
        )}
      </div>
      <div className={styles.skillMd}>
        <div className={styles.skillMdHead}>SKILL.md</div>
        <pre>{`---\nname: ${skill.name}\ndescription: ${skill.description}\n---`}</pre>
      </div>
    </aside>
  );
}

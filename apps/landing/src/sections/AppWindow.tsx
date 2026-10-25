"use client";

import { useState, type ReactNode } from "react";
import { AGENT_COLUMNS, SAMPLE_SKILLS } from "@/data/skills";
import { SkillMatrix } from "@/design/SkillMatrix";
import styles from "./AppWindow.module.css";

type View = "library" | "drafts";

const ICONS = {
  skills: (
    <>
      <path d="m16 6 4 14" />
      <path d="M12 6v14" />
      <path d="M8 8v12" />
      <path d="M4 4v16" />
    </>
  ),
  drafts: (
    <>
      <path d="M12 20h9" />
      <path d="M16.4 3.6a2 2 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  discover: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  agent: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
} satisfies Record<string, ReactNode>;

interface SourceItem {
  label: string;
  icon: keyof typeof ICONS;
  count?: number;
  view: View;
}

const SOURCES: readonly { header: string; items: readonly SourceItem[] }[] = [
  {
    header: "Library",
    items: [
      { label: "Skills", icon: "skills", count: 12, view: "library" },
      { label: "Drafts", icon: "drafts", count: 3, view: "drafts" },
      { label: "Discover", icon: "discover", count: 2, view: "library" },
    ],
  },
  {
    header: "Agents",
    items: [
      { label: "Claude Code", icon: "agent", count: 12, view: "library" },
      { label: "Codex", icon: "agent", count: 10, view: "library" },
      { label: "Cursor", icon: "agent", count: 11, view: "library" },
      { label: "Gemini CLI", icon: "agent", count: 9, view: "library" },
      { label: "9 More", icon: "more", view: "library" },
    ],
  },
];

const TITLES: Record<View, [string, string]> = {
  library: ["Skills", "12 skills in 13 agents · 2 changes"],
  drafts: ["Drafts", "3 drafts from this week"],
};

const EVIDENCE = [
  { when: "Mon 10:05", where: "Claude Code", what: "“bump, run e2e, build the dmg, tag”" },
  { when: "Tue 10:31", where: "Terminal", what: "pnpm --filter @gandalf/desktop e2e" },
  { when: "Wed 13:20", where: "Codex", what: "The same four steps, from the start" },
  { when: "Fri 16:20", where: "Cursor", what: "“release again, same as last time”" },
];

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}

/** The gandalf app drawn with the design system's Window, SourceList, Toolbar and SkillMatrix. */
export function AppWindow() {
  // Sidebar rows are keyed by label; the selected one decides the view.
  const [current, setCurrent] = useState("Skills");
  const view = SOURCES.flatMap((group) => group.items).find((item) => item.label === current)!.view;
  const [title, subtitle] = TITLES[view];

  return (
    <div
      className="gd-window"
      role="img"
      aria-label="The gandalf app showing the Library: skills in rows, agents in columns, a status glyph in each cell"
    >
      <div className="gd-window-traffic" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <nav className="gd-source gd-glass" aria-hidden="true">
        {SOURCES.map((group) => (
          <div key={group.header} className={styles.group}>
            <div className="gd-source-header">{group.header}</div>
            {group.items.map((item) => (
              <button
                key={item.label}
                type="button"
                tabIndex={-1}
                className="gd-source-item"
                aria-current={item.label === current ? "page" : undefined}
                onClick={() => setCurrent(item.label)}
              >
                <Icon name={item.icon} />
                <span className="gd-source-label">{item.label}</span>
                {item.count !== undefined && <span className="gd-count">{item.count}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="gd-window-main">
        <div className="gd-toolbar">
          <div className="gd-toolbar-title">
            {title}
            <span className="gd-toolbar-subtitle">{subtitle}</span>
          </div>
          <div className="gd-capsule" aria-hidden="true">
            <span className="gd-capsule-item">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span className="gd-capsule-item">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              >
                <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </span>
          </div>
          <div className="gd-capsule" aria-hidden="true">
            <span className="gd-btn gd-btn-primary">Sync</span>
          </div>
        </div>

        <div className="gd-window-content">
          {view === "library" ? (
            <SkillMatrix skills={SAMPLE_SKILLS} columns={AGENT_COLUMNS} selected={0} />
          ) : (
            <DraftView />
          )}
        </div>
      </div>
    </div>
  );
}

function DraftView() {
  return (
    <div className={styles.draft}>
      <div>
        <h3 className={styles.draftName}>release-desktop</h3>
        <p className={styles.why}>
          Drafted from 4 sessions this week. Approve to add it to the library.
        </p>
        <div className={styles.code}>
          <span className={styles.frontmatter}>
            {"---\nname: release-desktop\ndescription: Cut a signed desktop release.\n---"}
          </span>
          {`

# Release the desktop app

1. Bump the version in apps/desktop
2. Run the e2e lane; stop on any failure
3. Build and notarize the DMG
4. Tag vX.Y.Z and update CHANGELOG.md`}
        </div>
      </div>
      <div>
        <div className={styles.evidenceHead}>Seen in</div>
        {EVIDENCE.map((row) => (
          <div key={row.when} className={styles.evidenceRow}>
            <span className={styles.when}>{row.when}</span>
            <span className={styles.what}>
              <b>{row.where}</b>
              {row.what}
            </span>
          </div>
        ))}
        <div className={styles.actions}>
          <span className="gd-btn">Dismiss</span>
          <span className="gd-btn">Edit</span>
          <span className="gd-btn gd-btn-primary">Approve</span>
        </div>
      </div>
    </div>
  );
}

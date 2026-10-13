# Gandalf Design Theme

> Visual identity for the Gandalf landing page (`apps/landing`). Tokens live in
> `apps/landing/src/styles/theme.css`; this file explains how to use them.
> Last updated: 2026-10-13

---

## Principles

The page is an engineering document, not an ad. It follows the restraint of the
best-designed recent devtool sites: real product artifacts, plain copy, one type
family, monochrome, hairline rules.

1. **Show the artifact, not a metaphor.** Every section proves its claim with the
   thing Gandalf actually produces: terminal output, a `SKILL.md`, a diff, a check
   run, a table. No abstract illustrations, icon grids, or stock imagery.
2. **Plain, specific copy.** Say what the product does in one sentence. Name real
   files and commands. No slogans, no three-part rhythm, no "seamless/supercharge".
3. **Motion only where it explains.** The hero terminal replays real commands;
   artifact lines print in order once. Nothing else moves.
4. **Honest scope.** Capabilities that have not shipped (session capture and
   handoff) carry a `Preview` tag. Never present them as available.
5. **Real terminals only.** Every terminal on the page is the same xterm.js
   component (`components/ui/Terminal.tsx`) replaying output recorded from the
   actual CLI by `apps/landing/scripts/record-terminal.sh`. Never hand-write
   terminal output; re-record it when the CLI changes.

### Do not use

Gradient or shader backgrounds, glow and blur effects, blur-in or split-letter
headline animations, serif-italic accent words, magnetic or tilting elements,
cursor spotlights, rotating borders, marquees, text scramble, emoji in page copy, icon-card
grids, fabricated testimonials, logos, or usage numbers.

---

## Color

```yaml
bg:               "#fafaf9"   # Page (warm paper)
surface:          "#ffffff"   # Artifact frames
surface-strong:   "#f4f4f2"   # Diff file headers, table stripes
foreground:       "#0c0c0b"   # Text, primary buttons
muted-foreground: "#6b6b67"   # Secondary text
faint-foreground: "#a3a39e"   # Step numbers, meta
border:           "#e7e6e3"   # Hairlines, frames
border-strong:    "#d6d5d0"   # Outline buttons, preview tags
brand:            "#ff5f6a"   # Terminal `$` sigil only
term-bg:          "#0c0c0b"   # Terminal and install panels
```

The brand coral appears only as the `$` prompt sigil. Diff green and check red
are allowed inside artifacts because they are part of the artifact, never as
decoration.

---

## Typography

Self-hosted via `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`.

| Role | Size | Weight | Tracking | Font |
|---|---|---|---|---|
| Hero `h1` | clamp(2.5rem, 6vw, 4.25rem) | 600 | -0.04em | Geist |
| Section `h2` (`.h2`) | clamp(1.75rem, 3vw, 2.25rem) | 600 | -0.025em | Geist |
| Step `h3` | 1.25rem | 600 | -0.015em | Geist |
| Body | 1rem | 400 | 0 | Geist |
| Lede | 1.0625rem | 400 | 0 | Geist, muted |
| Eyebrow, meta, code | 0.75–0.875rem | 400 | 0 | Geist Mono |

Headings are sentence case, end with a period, and use `text-wrap: balance`.
Everything is left-aligned.

---

## Layout

- Container: 1120px max, 24px gutter (16px under 720px).
- Sections: 112px vertical rhythm (72px on mobile), separated by one hairline
  inside the container.
- Two-column rows use a 5 / 7 split: copy left, artifact right. They stack under 860px.
- Radius: 8px frames, 6px buttons, 4px tags. No shadows.

---

## Components

- **Artifact** (`.artifact`, `.artifact__head`): white frame with a mono header
  naming what the artifact is ("Recorded workflow", "Work contract").
  `.artifact--dark` for terminal-like content.
- **Print reveal** (`data-print`): direct children fade in, in order, the first
  time the artifact is 35% visible. Disabled under `prefers-reduced-motion`.
- **Preview tag** (`.preview-tag`): dashed mono tag for unshipped capabilities.
- **Buttons**: `.btn--primary` (ink on paper) and `.btn--outline`. One primary
  action per view.
- **Terminal** (`ui/Terminal.tsx` inside `TerminalSlot.astro`): a macOS-style
  window around a real xterm.js screen. Sessions come from
  `src/data/terminal-sessions.json`; tabs switch sessions, the hero one accepts
  typed commands, and `typeOnly` sessions type a command without running it
  (install). `TerminalSlot` reserves the height so nothing shifts on load.

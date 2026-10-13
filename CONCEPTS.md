# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Product Identity

### Gandalf
A local tool for people who use more than one coding agent. It manages skills across agents and hands work from one agent to the next. Earlier identities (IaC layer for agent environments, local control console, team manifest loop) covered MCP servers, hooks, snapshots, and restore; those were removed and survive only in git history and `docs/plans/`.

### Current Supported Agent Set
Claude Code, Codex, and Cursor for skills. Claude Code and Codex for Work Handoff.

## Skills

### Skill
A directory containing a `SKILL.md` entrypoint, located directly inside an agent's Skill Root. The directory name is the skill's name.

### Skill Root
The directory where one agent keeps skills for one Scope: `~/.<agent>/skills` for user scope, `<project>/.<agent>/skills` for project scope.

### Scope
Whether a skill lives in the user's home (`user`) or in the current repository (`project`). Skills with the same name in different scopes are separate skills.

### Install
One agent's copy of a skill. A skill has at most one install per agent per scope.

### Inventory
The cross-agent view of skills: every skill name with the installs found and a Skill Status.

### Skill Status
How one skill lines up across the agents in view. `synced`: every agent has identical content. `partial`: existing copies are identical but some agents lack it. `diverged`: at least two agents hold different content.

### Agents in View
The agents an operation considers. Defaults to the supported agents that have a config directory in the user's home; `--agent` overrides it. Skill Status is always relative to this set.

### Content Hash
The SHA-256 digest of a skill directory's file paths and contents, used to decide whether two installs are the same. Permissions, timestamps, `.DS_Store`, and `.git` are excluded.

### Linked Skill
An install whose directory is a symlink. Gandalf reads through it but never writes through it or replaces it; removing it only removes the link.

## Operations

### Sync
Copying skills so every agent in view holds the same content. Sync fills gaps on its own but never overwrites a differing copy unless a Sync Source is named.

### Sync Source
The agent named with `--from` whose copy wins when installs differ.

### Change
One planned or applied mutation to a single install (install, replace, remove, unlink, skip, or conflict). Dry runs and real runs return the same list.

### Conflict
A Change that Gandalf refused to make because it would overwrite differing content without explicit direction. Any conflict makes the command exit non-zero.

### Trash
`~/.gandalf/trash`, where replaced and removed installs are moved instead of being deleted. Gandalf never empties it.

## Sessions to Skills

### Trace
A compressed, redacted trajectory of one session: what the user typed, every failure with its error and what followed, and collapsed counts of routine tool use. Built locally; the only thing sent to a model.

### Lesson
One instruction a fresh agent would need in this repository, distilled from a Trace by the user's own coding agent, with the trace steps that support it, a kind (procedure, gotcha, environment fact, decision, preference), and a cost (how much the session lost without it).

### Group
Lessons from several sessions clustered by the area of work an agent would need them in. Each group goes to one Destination: a skill, an always-on rule for `CLAUDE.md`/`AGENTS.md`, or discarded.

### Draft
A `SKILL.md` written from one skill-destined Group, kept with a `provenance.json` under `~/.gandalf/distill/<project>/drafts/` until the user installs it with `gandalf skill add`.

### Distilling Agent
The coding agent that answers distill, group, and draft requests: the same agent the session came from, run non-interactively with no tools and no persisted session, on the user's subscription. Gandalf provides no model.

## Work Handoff

### Activity Event
An immutable, normalized record of something an agent did, decoded from a Claude Code or Codex source record.

### Evidence
Native transcript material kept encrypted on disk and owner-only. It backs activity events but is never treated as authority for agent instructions.

### Work
A project-scoped unit of agent activity tracked by the work graph.

### Work Contract
The handoff document for one piece of Work: status, completed steps, blockers, artifacts, verification, and bounded next actions. Claude Code and Codex read the same contract over local MCP.

### Runtime
The background service (`com.gandalf.runtime`) that ingests activity and answers the CLI, TUI, and MCP server over owner-only IPC. Skill commands never use it.

### Forget
An explicit action that removes one piece of Work or all data for a project.

### Handoff Boundary
Gandalf provides handoff context only. It is not an agent executor or work-assignment system, and it has no cloud sync.

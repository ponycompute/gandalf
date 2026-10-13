# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Product Identity

### Gandalf
A local skill manager for coding agents. It shows the skills installed across the Current Supported Agent Set side by side and adds, syncs, and removes them. Earlier identities (IaC layer for agent environments, local control console, team manifest loop) covered MCP servers, hooks, snapshots, and restore; those were removed to focus on skills first and survive only in git history and `docs/plans/`.

### Current Supported Agent Set
Claude Code, Codex, and Cursor.

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

## Boost

### Skill Profile
A named set of skills declared under `[profiles.<name>]` in a project `gandalf.toml`. `gandalf boost <profile>` symlinks that set from `.gandalf/skills/` into agent skill directories. This is the only remaining use of `gandalf.toml`.

# Gandalf Architecture

Gandalf is a **local skill manager for coding agents** (Claude Code, OpenAI Codex, Cursor). It inventories the skills each agent has installed, compares copies by content, and adds, syncs, and removes skills across agents. It needs no manifest, account, or network.

---

## 1. Repository Shape

```text
gandalf/
├── cmd/gandalf              # CLI entrypoint (Go)
├── internal/
│   ├── cli/                 # Cobra command wiring (root, skill, boost)
│   └── gandalfcore/
│       ├── skills/          # Skill inventory, content hashing, add/sync/remove
│       ├── agents/          # Supported agent set and display names
│       ├── boost/           # Profile-based skill symlink switching
│       ├── manifest/        # gandalf.toml parser (used by boost)
│       ├── fsutil/          # Atomic file writes
│       ├── pathconfinement/ # Root containment checks
│       └── types/           # Agent IDs and CLI error shape
│
├── apps/
│   ├── landing/             # Landing page (Astro + React)
│   └── docs/                # Mintlify documentation
│
├── packages/config-typescript/
├── turbo.json, package.json # Turborepo + Bun workspaces for apps/
└── Makefile                 # Go build and test
```

---

## 2. The `skills` Package

| File | Responsibility |
| :--- | :--- |
| `skills.go` | Resolves each agent's skill root per scope, scans it, and groups copies by name into an `Inventory` with a `synced` / `partial` / `diverged` status. |
| `tree.go` | One directory walk shared by hashing and copying, so a copy always hashes equal to its source. |
| `ops.go` | `Add`, `Sync`, and `Remove`. Each plans a list of `Change` values and applies them unless `DryRun` is set. |

A skill is a directory directly under an agent skill root that contains `SKILL.md`. Roots are `<home>/.<agent>/skills` for user scope and `<project>/.<agent>/skills` for project scope.

### Planning and applying

Every mutating operation builds `[]Change` first. A dry run returns that plan untouched; a real run applies it in order and returns the changes that landed. `ActionConflict` records a change Gandalf refused to make, and the CLI exits non-zero when one is present.

### Safety rules

* Differing copies are only overwritten when the caller names a source (`Sync` with `From`) or forces it (`Add` with `Force`).
* A displaced or removed copy is moved to `~/.gandalf/trash/<timestamp>/<scope>/<agent>/<name>`, never deleted.
* Symlinked skill directories are never written through; `Remove` only unlinks them.
* Copies are staged in a hidden sibling directory and renamed into place.
* Symlinks inside a skill are copied only when they are relative and stay inside the skill.

---

## 3. Boost

`gandalf boost <profile>` predates the skill manager. It reads `[[skills]]` and `[profiles.*]` from a project `gandalf.toml` and symlinks the profile's skills from `.gandalf/skills/` into agent skill directories, tracking state in `.gandalf/.boost.json`. It does not yet share code with the `skills` package.

---

## 4. Distribution & CI

* **Binary distribution**: Homebrew (`brew install qyinm/tap/gandalf`), `install.sh`, or `go install`. GoReleaser publishes on `v*` tags.
* **CI (`.github/workflows/ci.yml`)**: GoReleaser config check, `bun run typecheck`, `bun run build`, `bun run test` (which runs `go test ./...`), and the install script smoke test.

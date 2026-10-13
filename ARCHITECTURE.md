# Gandalf Architecture

Gandalf is a local tool for people who use more than one coding agent. It has two parts that share one binary:

- **Skills**: a stateless manager that inventories skills across Claude Code, Codex, and Cursor and adds, syncs, and removes them.
- **Work handoff**: a background service that records what Claude Code and Codex did in a project and serves the next agent a handoff contract over a local MCP server.

---

## 1. Repository Shape

```text
gandalf/
├── crates/
│   ├── gandalf-cli/         # The `gandalf` binary: argument surface, commands, TUI, setup
│   ├── gandalf-skills/      # Skill inventory, content hashing, add/sync/remove
│   ├── gandalf-core/        # Shared domain types and the application API
│   ├── gandalf-adapters/    # Decoders for Claude Code and Codex session records
│   ├── gandalf-ingest/      # Bounded ingestion of agent activity into events
│   ├── gandalf-store/       # SQLite state and encrypted evidence
│   ├── gandalf-workgraph/   # Deterministic work graph and handoff contracts
│   └── gandalf-service/     # Daemon, owner-only IPC, and the MCP server
├── tools/gandalf-release-gate/  # Release thresholds and corpus checks
│
├── apps/
│   ├── landing/             # Landing page (Astro + React)
│   └── docs/                # Mintlify documentation
│
├── docs/handoff/            # Plans, specs, and learnings for the handoff runtime
├── Cargo.toml               # Rust workspace
├── turbo.json, package.json # Turborepo + Bun workspaces for apps/
└── Makefile                 # cargo build, test, and lint
```

---

## 2. Skills (`gandalf-skills`)

`gandalf-skills` depends on none of the runtime crates. Its commands run in-process, need no daemon, and keep no state.

| File | Responsibility |
| :--- | :--- |
| `inventory.rs` | Resolves each agent's skill root per scope, scans it, and groups copies by name into an `Inventory` with a `synced` / `partial` / `diverged` status. |
| `tree.rs` | One directory walk shared by hashing and copying, so a copy always hashes equal to its source. |
| `ops.rs` | `add`, `sync`, and `remove`. Each plans a list of `Change` values and applies them unless `dry_run` is set. |

A skill is a directory directly under an agent skill root that contains `SKILL.md`. Roots are `<home>/.<agent>/skills` for user scope and `<project>/.<agent>/skills` for project scope.

Safety rules:

* Differing copies are only overwritten when the caller names a source (`sync` with `from`) or forces it (`add` with `force`). A refused change is reported as a `Conflict` and makes the command exit with status 1.
* A displaced or removed copy is moved to `~/.gandalf/trash/<timestamp>/<scope>/<agent>/<name>`, never deleted.
* Symlinked skill directories are never written through; `remove` only unlinks them.
* Copies are staged in a hidden sibling directory and renamed into place.
* Symlinks inside a skill are copied only when they are relative and stay inside the skill.

---

## 3. Work Handoff

```text
Claude Code / Codex session records
        │  gandalf-adapters (decode)
        ▼
gandalf-ingest ──► gandalf-store (state.db + encrypted evidence)
                          │
                          ▼
                  gandalf-workgraph (work contracts)
                          │
        gandalf-service: daemon ── owner-only IPC ── CLI / TUI
                          └────── MCP over stdio ─── agents
```

* **Events and evidence**: source records become immutable normalized activity events. Native transcript material is kept as encrypted local evidence and is never treated as instructions.
* **Work contracts**: the work graph produces project-scoped contracts with status, completed steps, blockers, artifacts, verification, and bounded next actions. Claude Code and Codex read the same contract over MCP.
* **State**: `~/.gandalf/state.db` plus `~/.gandalf/evidence`, owner-only. The evidence key lives in the macOS keychain.
* **Service**: `gandalf init` registers the integration with each agent and installs the `com.gandalf.runtime` LaunchAgent.
* **Boundaries**: Gandalf does not execute commands, launch agents, or assign work. The only network client is restricted to a loopback endpoint.

---

## 4. Platform, Distribution & CI

* **Platform**: macOS only. Setup and key storage use launchd and the keychain, and `gandalf-cli` does not yet build elsewhere. `gandalf-skills` itself only needs Unix.
* **Binary distribution**: Homebrew (`brew install qyinm/tap/gandalf`) and `install.sh`. GoReleaser builds the Rust binary for `aarch64-apple-darwin` and `x86_64-apple-darwin` on `v*` tags.
* **CI (`.github/workflows/ci.yml`)**: a macOS job runs `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace --all-features`, and a release build. An Ubuntu job checks the GoReleaser config, builds and tests the apps, and runs the install script smoke test.

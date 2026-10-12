# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Product Identity

### Gandalf
The selected product identity for Gandalf. Gandalf is the Infrastructure as Code layer for AI agents: teams declare MCP servers, skills, hooks, and env requirements in `gandalf.toml`, catch configuration drift in CI, apply non-destructively with pre-apply snapshots, and roll back safely. The setup console, snapshot store, and restore trust layer are supporting infrastructure behind this manifest loop.

### Manifest Loop
The core product loop and current identity: `gandalf init` or `gandalf export` -> declare `gandalf.toml` -> `gandalf check --ci` -> `gandalf apply` (snapshot + merge) -> `gandalf restore`. See PLAN.md and PRODUCT.md current contract.

### Drift
Any divergence between the team manifest (`gandalf.toml`) and a developer's local agent setup: missing MCP servers, missing or stale skills, absent hooks, or unset required env keys. Drift is detected read-only by `gandalf check` and reported per agent.

### CI Drift Gate
The `gandalf check --ci` contract: exit non-zero when drift or errors are detected so pull requests can be blocked before agent environments diverge. The packaged GitHub Action (PLAN.md M1) is the productized form of this gate.

### Project-Only Scope
The CI/automation scope that reads and writes repository agent files without touching user-home configs. `gandalf check --project-only` (and the GitHub Action) compare `gandalf.toml` with committed `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, skill sources, and `[env_template]`. `gandalf apply --project-only` reconciles those project MCP files to the manifest set (including removing undeclared servers), revalidates disk content at apply time, and keeps `${ENV}` templates uninterpolated so the CI check can pass. Default `gandalf apply` remains user-home Smart Merge and still preserves personal servers.

### Setup Container
A historical/future portability concept for captured AI agent setup state. It can describe snapshots or bundles, but it is not the current product identity and should not imply an OS container, remote agent runtime, or active profile system.

### Local Control Console
The v0.5.0-era product direction: a local TUI-first console for user-global AI agent setup. Historical as a product identity; the console shipped and remains as the TUI surface behind the manifest loop.

### Global Agent Setup Manager
Older wording for the console-era direction. Historical; prefer "IaC layer" / "manifest loop" in new product docs.

### Current Supported Agent Set
The product-visible agent boundary for the current Gandalf loop: Codex, Claude Code, and Cursor. Cursor includes editor-shared `.cursor/` surfaces (MCP, skills, hooks) and Cursor Agent CLI config (`~/.cursor/cli-config.json`, project `.cursor/cli.json`). Gandalf may keep legacy scanners or type constants for compatibility; OpenCode, Pi Agent, and broader coverage remain deferred (depth over breadth).

### First-Run Overview
The output of bare `gandalf` (also `gandalf overview`): a read-only, zero-config summary of the user's global agent setup that must deliver value to an individual within seconds. It lines up MCP servers across the Current Supported Agent Set (flagging cross-agent mismatches such as differing package versions) and lists the few highest-signal findings, leaving noisy findings to `gandalf report`. It reports where secrets live, never their values.

### Unified Inventory
The normalized cross-agent setup inventory used by the setup console. It presents skills, hooks, MCP servers, and plugins as global/user setup rows with compact agent identity rather than forcing users through an agent picker first.

### Setup Console
The current target information structure for Gandalf's default TUI. It uses top-level setup tabs for hooks, plugins, agent-native marketplace/source browsing, skills, and MCP servers while preserving cross-agent rows inside each tab.

### Changes-First Home
The default Gandalf TUI surface that summarizes drift from the latest supported baselines before users enter inventory browsing or recovery flows.

It is read-only: Review opens the detailed environment diff, while rollback must enter Review Changes before apply.

### Environment Diff Surface
A TUI-visible unit of environment drift for one semantic setup object or raw source artifact. It exists so semantic object changes and raw source changes both remain navigable and cannot be hidden behind a clean summary.

### Agent-Native Marketplace/Source
A marketplace, registry, plugin repository, or source exposed by an agent ecosystem and browsed through Gandalf. Gandalf can group and display source-backed entries, but install, update, uninstall, add-source, and remove-source actions are available only through agent-native provider-backed actions; Gandalf does not own or certify the catalog itself.

### Provider-Backed Action
A setup action backed by a provider that can describe the target, expected effect, Review Changes preview, and execution mechanism. Inventory visibility does not imply action executability; Gandalf can truthfully mark an action available only when a provider-backed action exists.

### Marketplace-Originated Review Action
A Review Changes-style flow that starts from an agent-native marketplace/source entry. The first safe version can produce non-mutating setup instructions or source-backed guidance, but install, update, uninstall, add-source, and remove-source remain unavailable until an agent-native provider can preview and execute a concrete effect.

### Setup Action Provider
The component that turns a visible setup inventory item into a provider-backed edit, remove, add, install, update, uninstall, or dry-run action.

### Skill Markdown Overlay Viewer
A read-only Setup Console overlay that opens from a selected skill and renders its `SKILL.md` entrypoint as terminal markdown. It makes inspection the primary Skills tab `Enter` behavior while keeping setup mutations behind explicit provider-backed actions.

## Restore

### Trust Contract
The safety boundary Gandalf promises for scan, snapshot, diff, restore, and bundle flows. In this project it means read-only discovery, confined writes under declared home/project roots, symlink refusal on write targets, and restore behavior that matches the evidence kind rather than falling back to unsafe generic file mutation.

### Evidence
A discovered configuration artifact Gandalf tracks for drift and restore planning. Each evidence record has a kind (config file, MCP server entry, permission rule, env key, etc.), a source path, and optional structured value metadata.

### Evidence Kind
The typed category of an evidence record that determines how restore planning and apply handlers treat it. Kinds with structured JSON values (MCP server, permission, env key) require dedicated apply handlers rather than whole-file replacement.

### Restore Plan
The diff-shaped output of comparing a baseline snapshot to current state. Lists planned items with actions (update, delete), risk metadata, and target state—but does not mutate the filesystem until apply.

### Review Changes
The user-facing preview step before a mutating action applies. Internally it can be backed by a restore plan or action preview, but product language should describe the concrete changes, unsupported items, rollback availability, and required apply confirmation rather than asking users to learn a separate plan concept.

A Review Changes surface is not itself apply authority. Mutating flows that depend on it must refresh or revalidate the underlying plan at apply time so the action still matches what the user reviewed.

### Restore Item
An executable unit derived from a restore plan item. Carries resolved destination path, structured `target_content`, handler `item_type`, and rollback state after apply.

### Apply Handler Registry
The dispatch table mapping restore item types to apply functions. Plan generation and apply execution share type labels; a missing registry entry surfaces as a handler error at apply time even when the plan looks valid.

### Path Confinement
The trust boundary that restricts restore and bundle writes to declared home and project roots. Confinement must be active in plan parsing, apply, rollback, and bundle import, and it only holds when the path that is actually written is the same path that was validated. Callers must supply roots or apply fails closed.

## Snapshots and Store

### Baseline Coverage
The per-agent completeness state of the Changes-First Home, which may be empty, partial, or complete across the Current Supported Agent Set.

Capturing missing baselines preserves existing agent baselines and fills only uncovered agents so established comparison points do not move silently.

### Snapshot
A named capture of project and user-global evidence at a point in time. Snapshots may be metadata-only or content-backed depending on capture policy.

### Content-Backed Snapshot
A snapshot whose store entry includes captured file bytes in addition to metadata and structured evidence. Restore safety depends on content-backed snapshots when byte-exact restoration of agent config files is required.

### Store
The on-disk persistence layer for snapshots, timeline entries, and related Gandalf state. CLI and TUI surfaces read the same store APIs for snapshot listing and changelog, so snapshot replacement must be atomic enough that readers never observe new metadata paired with partial or missing content blobs.

## Team Manifest & Sync

### Agent Environment as Code
The declarative paradigm where team-wide AI agent environments (MCP servers, skills, hooks, instructions) are defined in a Git-tracked manifest (`gandalf.toml`) and synchronized safely across team members' local agents.

### Team Manifest (`gandalf.toml`)
The standardized TOML configuration file placed at the root of a project repository declaring target agents (`codex`, `claude-code`), shared MCP servers with `${ENV_VAR}` templates, team skills (`.gandalf/skills/`), and hooks.

### Smart Merge
The non-destructive merge algorithm that injects and updates team-declared MCP servers and skills into local agent configurations without deleting existing personal user keys or sections. Current contract: manifest-owned entries are applied or replaced; user-owned keys/sections are preserved; every apply takes a SHA-256 pre-apply snapshot first. Not yet guaranteed (PLAN.md M3): JSON key order, comments inside manifest-owned TOML sections, or AST-level format preservation — do not claim "lossless" or "comment-preserving" until M3 ships.

### Policy Export
The planned strategy (PLAN.md M2) of generating vendor-native enforcement artifacts — Claude Code `managed-settings.json`, Codex requirements — from `gandalf.toml`, so Gandalf is the git-reviewable source of policy rather than a competitor to vendor runtime enforcement or MCP gateways.

### Manifest Export
The reverse-engineering workflow (`gandalf export`) that generates a canonical `gandalf.toml` and mirrors team skills from existing native agent configurations (Cursor `.cursor/mcp.json`, `~/.cursor/mcp.json`, Claude Code `.mcp.json`, `~/.claude.json`, OpenAI Codex `.codex/config.toml`, `~/.codex/config.toml`). Cursor Agent CLI permissions live in `~/.cursor/cli-config.json` and project `.cursor/cli.json` and are discovered by scan/snapshot on the same `cursor` agent; they are not a separate export schema. Export still extracts secrets into `[env_template]` with symlink-safe path confinement and atomic skill rollback. `gandalf import` is a backward-compatible alias for the same command. Applying the generated manifest onto local agent configs is `gandalf apply`.


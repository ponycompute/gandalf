<h1 align="center">Gandalf</h1>

<p align="center">
  <strong>One config for every coding agent your team uses.</strong>
</p>

<p align="center">
  Claude Code, Codex, and Cursor each manage their own MCP servers, skills, and hooks.
  Gandalf puts all of them in one <code>gandalf.toml</code> — reviewed in PRs, enforced in CI, rolled back in one command.
</p>

<p align="center">
  <a href="https://github.com/qyinm/gandalf/actions/workflows/ci.yml"><img alt="CI" src="https://shieldcn.dev/github/qyinm/gandalf/ci.svg"></a>
  <a href="https://github.com/qyinm/gandalf/releases"><img alt="Release" src="https://shieldcn.dev/github/qyinm/gandalf/release.svg"></a>
  <a href="https://github.com/qyinm/gandalf/blob/main/LICENSE"><img alt="License" src="https://shieldcn.dev/github/qyinm/gandalf/license.svg"></a>
  <a href="https://github.com/qyinm/homebrew-tap/blob/main/Formula/gandalf.rb"><img alt="Homebrew tap" src="https://shieldcn.dev/badge/homebrew-qyinm%2Ftap%2Fgandalf-2ea44f.svg"></a>
</p>

---

## 🎯 Why Gandalf?

> *"It works on my agent is the new it works on my machine."*

Your team doesn't use one coding agent — it uses three. Each keeps its own MCP servers, skills, and hooks in its own format, so every new hire copies someone's `~/.claude` by hand and every hook change breaks someone silently.

- 🤝 **Built for mixed-agent teams**: One `gandalf.toml` declares MCP servers, skills, hooks, and required env for Claude Code, Codex, and Cursor. Changes go through the same PR review as your code.
- 🚦 **Drift gate in CI**: `gandalf check --ci` fails the PR when a repo's agent config drifts from the team manifest — before anyone's environment diverges.
- 🛡️ **Safe by default (snapshot + restore)**: Every `gandalf apply` takes a SHA-256 pre-apply snapshot and merges non-destructively, keeping personal settings. `gandalf restore` rolls it all back in one command.
- 🔒 **Local-first**: The CLI is free and open source, forever — a pure Go binary with no account and no network runtime dependency. Team features are optional. **[Join the Team plan waitlist →](https://usegandalf.com/#team)**

---

## 🚀 Quick Start (3-Step Workflow)

### 1. Initialize Team Manifest
In your project repository:

```bash
gandalf init
```
This generates a starter `gandalf.toml` and `.gandalf/skills/` directory.

### 2. Declare Team Agent Environment (`gandalf.toml`)
Commit your team requirements to Git:

```toml
# gandalf.toml (team agent environment specification)
version = "1.0"
agents  = ["claude-code", "codex", "cursor"]

[mcp_servers.postgres-db]
command      = "npx"
args         = ["-y", "@mcp/postgres", "${DB_URL}"]
required_env = ["DB_URL"]

[[skills]]
name   = "team-reviewer"
source = "./.gandalf/skills/team-reviewer"

[hooks.pre_save]
command = "bun run lint:fix"
target  = "codex"
```

### 3. Check Drift & Apply Safely

```bash
# Check configuration drift (used locally & in CI)
gandalf check --ci

# Preview planned changes without modifying files
gandalf apply --dry-run

# Safely merge changes with automatic rollback snapshot
gandalf apply --yes
```

---

## 📦 Install

### Homebrew (Recommended)

```bash
brew install qyinm/tap/gandalf
gandalf --help
```

### Standalone Script

```bash
curl -fsSL https://raw.githubusercontent.com/qyinm/gandalf/main/install.sh | sh
```

### From Source

```bash
go install github.com/qyinm/gandalf/cmd/gandalf@latest
```

---

## 💻 CLI Commands

| Command | Description |
| :--- | :--- |
| `gandalf init` | Initialize a starter `gandalf.toml` in the current repository. |
| `gandalf export` | Generate `gandalf.toml` from local agent config (manifest only). Secrets, logins, and agent installs are out of scope; other machines need `apply`. `gandalf import` is a backward-compatible alias. |
| `gandalf check [--ci]` | Check for drift between `gandalf.toml` and local agent setups. `--project-only` compares repository MCP files. Exits with code 1 if drift detected in `--ci` mode. |
| `gandalf apply [--dry-run]` | Non-destructively merge team manifest into local agent environments with pre-apply snapshot backup. `--project-only` writes repository MCP files instead of user-home. |
| `gandalf restore --snapshot <id> --apply` | Instantly roll back agent configurations to a previous safety snapshot. |
| `gandalf snapshot list` | List available pre-apply and manual safety snapshots. |
| `gandalf` | Launch the interactive Bubble Tea TUI control console. |

---

## 🛡️ Target Agent Support Matrix

| Agent | Target Config Files | MCP Support | Skills Support | Guardrail Hooks |
| :--- | :--- | :---: | :---: | :---: |
| **Claude Code** | `~/.claude/settings.json`, `~/.claude/skills/`, project `.mcp.json` | ✅ Smart Merge | ✅ Markdown/Dir | ✅ Allowed Tools |
| **OpenAI Codex** | `~/.codex/config.toml`, `.codex/` | ✅ Smart Merge | ✅ Skill repo | ✅ Pre-save Hooks |
| **Cursor** | `.cursor/mcp.json`, `~/.cursor/mcp.json`, `.cursor/cli.json`, `~/.cursor/cli-config.json`, `.cursor/skills/`, `~/.cursor/skills/` | ✅ Smart Merge | ✅ Markdown/Dir | ✅ Hooks scan |
| **Custom / Team Agents** | `.gandalf/skills/`, `.gandalf/hooks/` | ✅ Extensible | ✅ Versioned | ✅ Git-tracked |

Default `gandalf apply` Smart-Merges user-home configs. `gandalf check --project-only` / `gandalf apply --project-only` compare and reconcile repository MCP files (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`). See the [support matrix](apps/docs/reference/support-matrix.mdx) for exact scan, check, apply, and restore boundaries.

---

## 🔒 Trust & Safety Contract

- **Non-Destructive**: Never overwrites existing unmanaged personal keys in `settings.json` or `config.toml`.
- **Confined Writes**: Path validation prevents any writes outside user home agent configs and project root.
- **Pre-Apply Safety Net**: Every mutating `gandalf apply` creates an automatic SHA-256 backup snapshot before touching any file.
- **Zero Cloud Leaks**: No credentials, prompts, or MCP configurations are ever transmitted to any third-party server.

---

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). © 2026 Gandalf Contributors.

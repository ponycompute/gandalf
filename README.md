<h1 align="center">Gandalf</h1>

<p align="center">
  <strong>One place to manage skills for every coding agent you use.</strong>
</p>

<p align="center">
  Claude Code, Codex, and Cursor each keep skills in their own directory.
  Gandalf shows them side by side, flags the ones that are missing or differ, and syncs them in one command.
</p>

<p align="center">
  <a href="https://github.com/qyinm/gandalf/actions/workflows/ci.yml"><img alt="CI" src="https://shieldcn.dev/github/qyinm/gandalf/ci.svg"></a>
  <a href="https://github.com/qyinm/gandalf/releases"><img alt="Release" src="https://shieldcn.dev/github/qyinm/gandalf/release.svg"></a>
  <a href="https://github.com/qyinm/gandalf/blob/main/LICENSE"><img alt="License" src="https://shieldcn.dev/github/qyinm/gandalf/license.svg"></a>
  <a href="https://github.com/qyinm/homebrew-tap/blob/main/Formula/gandalf.rb"><img alt="Homebrew tap" src="https://shieldcn.dev/badge/homebrew-qyinm%2Ftap%2Fgandalf-2ea44f.svg"></a>
</p>

---

## 🎯 Why Gandalf?

You write a skill for one agent, and the other two never get it. Or you copy it over, edit one copy, and the three quietly drift apart.

- 👀 **See everything at once**: `gandalf` lists every skill with one column per agent.
- 🔍 **Catches edited copies**: skills are compared by content hash, so a changed copy shows up as `diverged` instead of passing as installed.
- 🔁 **Sync in one command**: `gandalf skill sync` copies skills to the agents missing them. Differing copies are only overwritten when you say which agent wins.
- 🛡️ **Nothing is deleted outright**: replaced and removed skills move to `~/.gandalf/trash`.
- 🔒 **Local-first**: a pure Go binary with no account, no config file, and no network access.

---

## 🚀 Quick Start

```bash
gandalf
```

```text
SKILL          CLAUDE CODE  CODEX    CURSOR  STATUS
code-review    yes          yes      yes     synced
pr-summary     yes          -        -       partial
team-reviewer  3f9a1c2      b81e07d  -       diverged

3 skill(s): 1 synced, 1 partial, 1 diverged
```

```bash
# Copy skills to the agents missing them (preview first)
gandalf skill sync --dry-run
gandalf skill sync

# Two agents disagree: pick the copy that wins
gandalf skill sync team-reviewer --from claude-code

# Install a local skill into every agent, or remove it everywhere
gandalf skill add ./my-skill
gandalf skill remove my-skill
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
| `gandalf` | List skills and how they line up across agents. Same as `gandalf skill list`. |
| `gandalf skill list` | List skills. `--scope user\|project\|all`, `--agent`, `--json`. |
| `gandalf skill show <name>` | Show where a skill is installed and print its `SKILL.md`. |
| `gandalf skill add <path>` | Install a local skill directory into your agents. `--force` replaces differing copies. |
| `gandalf skill sync [name...]` | Copy skills to the agents missing them. `--from <agent>` resolves differing copies. |
| `gandalf skill remove <name>` | Remove a skill from your agents. |
| `gandalf boost [profile]` | Switch the project's active skill profile declared in `gandalf.toml`. |

Every mutating command accepts `--dry-run`.

---

## 🛡️ Supported Agents

| Agent | User skills | Project skills (`--scope project`) |
| :--- | :--- | :--- |
| **Claude Code** | `~/.claude/skills/` | `.claude/skills/` |
| **OpenAI Codex** | `~/.codex/skills/` | `.codex/skills/` |
| **Cursor** | `~/.cursor/skills/` | `.cursor/skills/` |

A skill is a directory containing `SKILL.md`. Gandalf does not manage MCP servers, hooks, or agent settings.

---

## 🔒 Trust & Safety Contract

- **Read-only by default**: listing and showing skills never writes.
- **Confined writes**: only agent skill directories and `~/.gandalf/trash` are written.
- **Recoverable**: replaced and removed skills are moved to trash, never deleted.
- **No silent overwrites**: differing copies need an explicit `--from` or `--force`.
- **Offline**: Gandalf never uses the network and never executes a skill.

---

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). © 2026 Gandalf Contributors.

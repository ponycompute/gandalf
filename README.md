<h1 align="center">Gandalf</h1>

<p align="center">
  <strong>Skills and work context that follow you across coding agents.</strong>
</p>

<p align="center">
  Gandalf keeps the skills in Claude Code, Codex, and Cursor in line,
  and hands the work one agent started over to the next.
</p>

<p align="center">
  <a href="https://github.com/ponycompute/gandalf/actions/workflows/ci.yml"><img alt="CI" src="https://shieldcn.dev/github/ponycompute/gandalf/ci.svg"></a>
  <a href="https://github.com/ponycompute/gandalf/releases"><img alt="Release" src="https://shieldcn.dev/github/ponycompute/gandalf/release.svg"></a>
  <a href="https://github.com/ponycompute/gandalf/blob/main/LICENSE"><img alt="License" src="https://shieldcn.dev/github/ponycompute/gandalf/license.svg"></a>
</p>

---

## 🎯 Why Gandalf?

Switching agents mid-task costs you twice: the new agent lacks the skills you built for the old one, and it has no idea what the old one already did.

- 👀 **Skills, side by side**: `gandalf` lists every skill with one column per agent.
- 🔍 **Catches edited copies**: skills are compared by content hash, so a changed copy shows up as `diverged` instead of passing as installed.
- 🔁 **Sync in one command**: `gandalf skill sync` copies skills to the agents missing them. Differing copies are only overwritten when you say which agent wins.
- 🤝 **Work handoff**: a local service records what Claude Code and Codex did in a project and serves the next agent a handoff contract over MCP: status, completed steps, blockers, and next actions.
- 🔒 **Local-first**: one binary, no account, no cloud. Recorded evidence is encrypted on disk, and replaced or removed skills move to `~/.gandalf/trash`.

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

3 skills: 1 synced, 1 partial, 1 diverged
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

### Work handoff (Claude Code and Codex)

```bash
# Connect your agents and start the local service
gandalf init

# What is in progress in this project?
gandalf work current

# Print the handoff contract for one piece of work
gandalf handoff <work-id>
```

Skill commands work on their own; you only need `gandalf init` for handoff.

---

## 🧪 Turn sessions into skills

What you work out with an agent during a session usually stays in that session. `gandalf distill` reads your recent Claude Code and Codex sessions for the current repository and asks the agent each came from, run non-interactively, what a fresh agent would need to know next time. `gandalf suggest` groups those lessons by area of work and drafts a `SKILL.md` for each. `gandalf tui` shows the drafts in an inbox where you approve or dismiss them.

```bash
gandalf distill --dry-run      # which sessions would be sent, and how big the traces are
gandalf distill                # about $0.15 per session on your own subscription
gandalf suggest                # group lessons, write skill drafts to ~/.gandalf/distill/<project>/drafts
gandalf tui                    # inbox: a approves a draft into this project, x dismisses it
```

Redacted excerpts go only to the agent the session came from. Gandalf has no server and no model of its own.

## 📦 Install

Gandalf currently supports **macOS** (Apple silicon and Intel).

### Install Script (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/ponycompute/gandalf/main/install.sh | sh
gandalf --help
```

The script downloads the latest release for your Mac, verifies its checksum, and installs `gandalf` to `~/.local/bin`. Set `GANDALF_INSTALL_DIR` to install somewhere else.

### From Source

Requires the Rust toolchain pinned in `rust-toolchain.toml`.

```bash
git clone https://github.com/ponycompute/gandalf.git
cd gandalf
make build
./target/release/gandalf --help
```

---

## 💻 CLI Commands

**Skills** (Claude Code, Codex, Cursor)

| Command | Description |
| :--- | :--- |
| `gandalf` | List skills and how they line up across agents. Same as `gandalf skill list`. |
| `gandalf skill list` | List skills. `--scope user\|project\|all`, `--agent`. |
| `gandalf skill show <name>` | Show where a skill is installed and print its `SKILL.md`. |
| `gandalf skill add <path>` | Install a local skill directory into your agents. `--force` replaces differing copies. |
| `gandalf skill sync [name...]` | Copy skills to the agents missing them. `--from <agent>` resolves differing copies. |
| `gandalf skill remove <name>` | Remove a skill from your agents. |
| `gandalf tui` | Review skill drafts and installed skills in a terminal UI. |

Every mutating skill command accepts `--dry-run`.

**Work handoff** (Claude Code, Codex)

| Command | Description |
| :--- | :--- |
| `gandalf init` | Connect Claude Code and Codex and install the background service. |
| `gandalf status` / `gandalf doctor` | Check the service and the local installation. |
| `gandalf daemon start\|stop\|logs` | Control the background service. |
| `gandalf work list\|current\|show <id>` | List and show tracked work in this project. |
| `gandalf handoff <id>` | Print the handoff contract for one piece of work. |
| `gandalf search <query>` | Search what you and your agents said and did in this project's sessions. |
| `gandalf evidence <id>` | Show one piece of recorded evidence (redacted unless `--raw`). |
| `gandalf tui --work` | Browse tracked work in a terminal UI. |
| `gandalf mcp --provider claude\|codex` | Serve handoff context to an agent over MCP. |
| `gandalf agent list\|connect\|disconnect` | Manage agent connections. |
| `gandalf config show\|set` | Show or change settings such as retention. |
| `gandalf forget work <id>\|project` | Delete recorded work or all data for this project. |

Global flags: `--output text|json`, `--project-root <dir>`.

---

## 🛡️ Supported Agents

| Agent | Skills | Work handoff |
| :--- | :---: | :---: |
| **Claude Code** | ✅ `~/.claude/skills/`, `.claude/skills/` | ✅ |
| **OpenAI Codex** | ✅ `~/.agents/skills/`, `.agents/skills/` | ✅ |
| **Cursor** | ✅ `~/.agents/skills/`, `.agents/skills/` (also reads `.cursor/skills/` and `.claude/skills/`) | — |

A skill is a directory containing `SKILL.md`. Gandalf does not manage MCP servers, hooks, or agent settings beyond registering its own handoff integration.

---

## 🔒 Trust & Safety Contract

- **Skill commands are stateless**: they read and write only agent skill directories and `~/.gandalf/trash`, and never contact the background service.
- **Recoverable**: replaced and removed skills are moved to trash, never deleted.
- **No silent overwrites**: differing skill copies need an explicit `--from` or `--force`.
- **Handoff is opt-in**: nothing is recorded until you run `gandalf init`.
- **Local only**: state lives in `~/.gandalf`, evidence is encrypted with a key held in the macOS keychain, and nothing is sent to a remote server.
- **Never executes**: Gandalf does not run agent commands, launch agents, or assign work.

---

## 📄 License

Licensed under the [Apache License 2.0](LICENSE). © 2026 Gandalf Contributors.

//! Exact, non-executing command-line surface for gandalf.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "gandalf",
    version,
    about = "Skill manager and local work handoff for coding agents",
    long_about = "Skill manager and local work handoff for coding agents.\n\nRun without a command to see every skill and how it lines up across your agents.",
    after_help = EXAMPLES
)]
pub struct Cli {
    /// Output format; `json` is stable for scripts.
    #[arg(long, global = true, value_enum, default_value_t = Output::Text)]
    pub output: Output,
    /// Project to work in (default: the current directory).
    #[arg(long, global = true, value_name = "DIR")]
    pub project_root: Option<PathBuf>,
    /// Runs `skill list` when omitted.
    #[command(subcommand)]
    pub command: Option<Command>,
}

const EXAMPLES: &str = "\
Examples:
  gandalf                         List skills across your agents
  gandalf skill sync --dry-run    Preview copying skills to the agents missing them
  gandalf skill show <name>       See where a skill is installed and read it
  gandalf distill                 Turn this project's recent sessions into lessons
  gandalf suggest                 Draft skills from those lessons
  gandalf init                    Connect agents and start the background service
  gandalf work list               List tracked work in this project
  gandalf tui                     Browse tracked work interactively";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum Output {
    #[default]
    Text,
    Json,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum ProviderArg {
    Claude,
    Codex,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// See and manage skills across Claude Code, Codex, and Cursor.
    #[command(alias = "skills")]
    Skill {
        #[command(subcommand)]
        command: SkillCommand,
    },
    /// Turn recent sessions in this project into lessons, using your own
    /// coding agent.
    Distill(DistillArgs),
    /// Group distilled lessons into skill drafts you can review and install.
    Suggest(SuggestArgs),
    /// Connect Claude Code and Codex and install the background service.
    Init(InitArgs),
    /// Show whether the background service is ready.
    Status,
    /// Check the local installation for problems.
    Doctor,
    /// Start, stop, or inspect the background service.
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
    /// List, connect, or disconnect agents.
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    /// List and show tracked work in this project.
    Work {
        #[command(subcommand)]
        command: WorkCommand,
    },
    /// Print the handoff contract for one piece of work.
    Handoff {
        /// Work id, as shown by `gandalf work list`.
        work_id: String,
    },
    /// Show one piece of recorded evidence.
    Evidence {
        /// Evidence id, as referenced by a handoff contract.
        evidence_id: String,
        /// Print the unredacted evidence instead of the redacted preview.
        #[arg(long)]
        raw: bool,
    },
    /// Search tracked work in this project.
    Search {
        /// Words to look for.
        query: String,
        /// Maximum number of results.
        #[arg(long, default_value_t = 20)]
        limit: u16,
    },
    /// Browse tracked work in a terminal UI.
    Tui,
    /// Serve handoff context to an agent over MCP (stdio).
    Mcp {
        /// Agent the server is speaking to.
        #[arg(long, value_enum)]
        provider: ProviderArg,
    },
    /// Show or change settings.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Delete recorded work or all data for this project.
    Forget {
        #[command(subcommand)]
        command: ForgetCommand,
    },
    #[command(hide = true)]
    Hook {
        #[command(subcommand)]
        command: HookCommand,
    },
}

#[derive(Debug, Args)]
pub struct DistillArgs {
    /// Only sessions changed in the last N days.
    #[arg(long, default_value_t = 30, value_name = "DAYS")]
    pub since: u64,
    /// At most this many sessions per run.
    #[arg(long, default_value_t = 5, value_name = "N")]
    pub limit: usize,
    /// List the sessions that would be sent without calling the agent.
    #[arg(long)]
    pub dry_run: bool,
    /// Only sessions from this agent.
    #[arg(long, value_enum)]
    pub agent: Option<DistillAgentArg>,
}

#[derive(Debug, Args)]
pub struct SuggestArgs {
    /// Group the lessons but write no drafts.
    #[arg(long)]
    pub dry_run: bool,
    /// Agent that groups and drafts (default: the one most lessons came from).
    #[arg(long, value_enum)]
    pub agent: Option<DistillAgentArg>,
    /// Ignore the previous grouping and start over.
    #[arg(long)]
    pub fresh: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum DistillAgentArg {
    ClaudeCode,
    Codex,
}

#[derive(Debug, Args)]
pub struct InitArgs {
    /// Print nothing on success.
    #[arg(long)]
    pub quiet: bool,
}

#[derive(Debug, Subcommand)]
pub enum DaemonCommand {
    /// Start the background service.
    Start {
        /// Run in this terminal instead of as a background service.
        #[arg(long)]
        foreground: bool,
    },
    /// Stop the background service.
    Stop,
    /// Print recent service log entries.
    Logs {
        /// Keep printing new entries as they arrive.
        #[arg(long)]
        follow: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum AgentCommand {
    /// Show which agents are connected for work handoff.
    List,
    /// Connect Claude Code and Codex (same as `gandalf init`).
    Connect,
    /// Remove gandalf from agent configuration; other settings are kept.
    Disconnect,
}

#[derive(Debug, Subcommand)]
pub enum WorkCommand {
    /// List recent work in this project.
    List,
    /// Show the work an agent is on right now.
    Current,
    /// Show one piece of work in full.
    Show {
        /// Work id, as shown by `gandalf work list`.
        work_id: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// Print current settings.
    Show,
    /// Change one setting.
    Set {
        /// Setting to change.
        key: ConfigKey,
        /// New value (retention-days: 1 to 3650).
        value: String,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum ConfigKey {
    RetentionDays,
}
#[derive(Debug, Subcommand)]
pub enum ForgetCommand {
    /// Delete one piece of recorded work.
    Work {
        /// Work id, as shown by `gandalf work list`.
        work_id: String,
    },
    /// Delete everything recorded for this project.
    Project,
}
#[derive(Debug, Subcommand)]
pub enum HookCommand {
    Ingest {
        #[arg(long, value_enum)]
        provider: ProviderArg,
        #[arg(long, default_value_t = 65_536)]
        max_bytes: usize,
    },
    ActiveIndex {
        #[arg(long, value_enum)]
        provider: ProviderArg,
        #[arg(long, default_value_t = 10)]
        max_items: u16,
    },
}

/// An agent whose skill directory a skill command reads or writes.
#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum AgentArg {
    ClaudeCode,
    Codex,
    Cursor,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum ScopeArg {
    #[default]
    User,
    Project,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum ListScopeArg {
    #[default]
    User,
    Project,
    All,
}

/// Which copies of a skill a command works on.
#[derive(Debug, Args)]
pub struct SkillTarget {
    /// Skill scope.
    #[arg(long, value_enum, default_value_t = ScopeArg::User)]
    pub scope: ScopeArg,
    /// Limit to these agents (default: agents found in your home directory).
    #[arg(long = "agent", value_enum, value_delimiter = ',')]
    pub agents: Vec<AgentArg>,
}

#[derive(Debug, Default, Args)]
pub struct SkillListArgs {
    /// Skill scope.
    #[arg(long, value_enum, default_value_t = ListScopeArg::User)]
    pub scope: ListScopeArg,
    /// Limit to these agents (default: agents found in your home directory).
    #[arg(long = "agent", value_enum, value_delimiter = ',')]
    pub agents: Vec<AgentArg>,
}

#[derive(Debug, Subcommand)]
pub enum SkillCommand {
    /// List skills and how they line up across agents.
    #[command(alias = "ls")]
    List(SkillListArgs),
    /// Show where a skill is installed and print its SKILL.md.
    Show {
        /// Skill name, as shown by `gandalf skill list`.
        name: String,
        #[command(flatten)]
        target: SkillTarget,
    },
    /// Install a local skill directory into your agents.
    Add {
        /// Directory containing a SKILL.md.
        path: PathBuf,
        /// Install under this name (default: the source directory name).
        #[arg(long)]
        name: Option<String>,
        /// Replace copies that differ from the source.
        #[arg(long)]
        force: bool,
        /// Show what would change without writing.
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        target: SkillTarget,
    },
    /// Copy skills to the agents that are missing them.
    Sync {
        /// Skills to sync (default: every skill).
        names: Vec<String>,
        /// Agent whose copy wins when copies differ.
        #[arg(long, value_enum)]
        from: Option<AgentArg>,
        /// Show what would change without writing.
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        target: SkillTarget,
    },
    /// Remove a skill from your agents (moved to ~/.gandalf/trash).
    #[command(alias = "rm")]
    Remove {
        /// Skill name, as shown by `gandalf skill list`.
        name: String,
        /// Show what would change without writing.
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        target: SkillTarget,
    },
}

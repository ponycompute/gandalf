//! Exact, non-executing command-line surface for gandalf.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "gandalf",
    version,
    about = "Skill manager and local work handoff for coding agents",
    long_about = "Skill manager and local work handoff for coding agents.\n\nRun without a command to see every skill and how it lines up across your agents."
)]
pub struct Cli {
    #[arg(long, global = true, value_enum, default_value_t = Output::Text)]
    pub output: Output,
    #[arg(long, global = true)]
    pub project_root: Option<PathBuf>,
    /// Runs `skill list` when omitted.
    #[command(subcommand)]
    pub command: Option<Command>,
}

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
    Handoff { work_id: String },
    /// Show one piece of recorded evidence.
    Evidence {
        evidence_id: String,
        #[arg(long)]
        raw: bool,
    },
    /// Search tracked work in this project.
    Search {
        query: String,
        #[arg(long, default_value_t = 20)]
        limit: u16,
    },
    /// Browse tracked work in a terminal UI.
    Tui,
    /// Serve handoff context to an agent over MCP (stdio).
    Mcp {
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
pub struct InitArgs {
    #[arg(long)]
    pub quiet: bool,
}
#[derive(Debug, Subcommand)]
pub enum DaemonCommand {
    Start {
        #[arg(long)]
        foreground: bool,
    },
    Stop,
    Logs {
        #[arg(long)]
        follow: bool,
    },
}
#[derive(Debug, Subcommand)]
pub enum AgentCommand {
    List,
    Connect,
    Disconnect,
}
#[derive(Debug, Subcommand)]
pub enum WorkCommand {
    List,
    Current,
    Show { work_id: String },
}
#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    Show,
    Set { key: ConfigKey, value: String },
}
#[derive(Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum ConfigKey {
    RetentionDays,
}
#[derive(Debug, Subcommand)]
pub enum ForgetCommand {
    Work { work_id: String },
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
        name: String,
        #[command(flatten)]
        target: SkillTarget,
    },
    /// Install a local skill directory into your agents.
    Add {
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
        name: String,
        /// Show what would change without writing.
        #[arg(long)]
        dry_run: bool,
        #[command(flatten)]
        target: SkillTarget,
    },
}

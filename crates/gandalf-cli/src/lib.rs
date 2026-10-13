//! Native setup and command boundary for gandalf.

use std::{fmt::Write as _, io::Write};

pub mod args;
pub mod commands;
pub mod config;
pub mod init;
pub mod paths;
pub mod platform;
pub mod tui;

pub use init::{InitOptions, InitReport, Initializer};
pub use paths::GandalfPaths;
pub use platform::{Change, Platform, PlatformError, ServiceSpec};

/// Executes the approved CLI surface.
///
/// # Errors
///
#[allow(clippy::too_many_lines)]
pub async fn run(cli: args::Cli) -> Result<(), CliError> {
    let output = cli.output;
    let command = cli.command.unwrap_or(args::Command::Skill {
        command: args::SkillCommand::List(args::SkillListArgs::default()),
    });
    match command {
        args::Command::Skill { command } => commands::skill::run(
            output,
            &user_home()?,
            &project_root(cli.project_root)?,
            command,
        ),
        args::Command::Distill(arguments) => commands::distill::distill(
            output,
            &user_home()?,
            &project_root(cli.project_root)?,
            &commands::distill::DistillOptions {
                since_days: arguments.since,
                limit: arguments.limit,
                dry_run: arguments.dry_run,
                agent: arguments.agent.map(distill_tool),
            },
        ),
        args::Command::Suggest(arguments) => commands::distill::suggest(
            output,
            &user_home()?,
            &project_root(cli.project_root)?,
            &commands::distill::SuggestOptions {
                dry_run: arguments.dry_run,
                agent: arguments.agent.map(distill_tool),
                fresh: arguments.fresh,
            },
        ),
        args::Command::Init(arguments) => {
            let report = Initializer::new(current_platform()?)
                .run(InitOptions {
                    quiet: arguments.quiet,
                })
                .await?;
            if !arguments.quiet {
                print!(
                    "{}",
                    render_init(commands::style::Palette::stdout(), &report)
                );
            }
            Ok(())
        }
        args::Command::Daemon { command } => {
            commands::daemon::run(command, &GandalfPaths::from_home(&user_home()?)).await
        }
        args::Command::Status => {
            let client = human_client(cli.project_root).await?;
            let value = call(&client, gandalf_core::api::AppRequest::Health).await?;
            commands::output::response(output, value)
        }
        args::Command::Doctor => {
            let paths = GandalfPaths::from_home(&user_home()?);
            let daemon_reachable = match project_root(cli.project_root) {
                Ok(root) => commands::client::scoped_client(
                    &paths,
                    &root,
                    gandalf_service::ipc::WireActor::HumanCli,
                )
                .await
                .is_ok(),
                Err(_) => false,
            };
            render_doctor(
                output,
                &commands::doctor::DoctorReport::inspect(&paths, daemon_reachable),
            )
        }
        args::Command::Agent { command } => run_agent(command).await,
        args::Command::Config { command } => run_config(output, command),
        args::Command::Work { command } => {
            let client = human_client(cli.project_root).await?;
            let request = match command {
                args::WorkCommand::List => gandalf_core::api::AppRequest::ListWork {
                    status: None,
                    limit: 20,
                },
                args::WorkCommand::Current => gandalf_core::api::AppRequest::CurrentWork,
                args::WorkCommand::Show { work_id } => gandalf_core::api::AppRequest::GetWork {
                    work_id: parse_work_id(&work_id)?,
                },
            };
            commands::output::response(output, call(&client, request).await?)
        }
        args::Command::Handoff { work_id } => {
            let client = human_client(cli.project_root).await?;
            let value = call(
                &client,
                gandalf_core::api::AppRequest::GetWork {
                    work_id: parse_work_id(&work_id)?,
                },
            )
            .await?;
            commands::output::response(output, value)
        }
        args::Command::Evidence { evidence_id, raw } => {
            let client = human_client(cli.project_root).await?;
            let evidence_id = gandalf_core::EvidenceId::parse_wire(&evidence_id)
                .ok_or(CliError::InvalidIdentifier)?;
            let disclosure = if raw {
                gandalf_core::api::EvidenceDisclosure::AuthorizedRaw
            } else {
                gandalf_core::api::EvidenceDisclosure::Redacted
            };
            let value = call(
                &client,
                gandalf_core::api::AppRequest::GetEvidence {
                    evidence_id,
                    disclosure,
                },
            )
            .await?;
            commands::output::response(output, value)
        }
        args::Command::Search { query, limit } => {
            let client = human_client(cli.project_root).await?;
            let value = call(
                &client,
                gandalf_core::api::AppRequest::SearchWork { query, limit },
            )
            .await?;
            commands::output::response(output, value)
        }
        args::Command::Tui => {
            let client = human_client(cli.project_root).await?;
            let value = call(
                &client,
                gandalf_core::api::AppRequest::ListWork {
                    status: None,
                    limit: 100,
                },
            )
            .await?;
            let gandalf_core::api::AppResponse::WorkList(page) = value else {
                return Err(CliError::Unavailable);
            };
            tui::run(page.items, client)
                .await
                .map_err(|_| CliError::Unavailable)
        }
        args::Command::Forget { command } => {
            let client = human_client(cli.project_root).await?;
            let request = match command {
                args::ForgetCommand::Work { work_id } => {
                    gandalf_core::api::AppRequest::ForgetWork {
                        work_id: parse_work_id(&work_id)?,
                    }
                }
                args::ForgetCommand::Project => gandalf_core::api::AppRequest::ForgetProject,
            };
            commands::output::response(output, call(&client, request).await?)
        }
        args::Command::Mcp { provider } => {
            let root = project_root(cli.project_root)?;
            let provider = match provider {
                args::ProviderArg::Claude => gandalf_core::Provider::Claude,
                args::ProviderArg::Codex => gandalf_core::Provider::Codex,
            };
            let client = commands::client::scoped_client(
                &GandalfPaths::from_home(&user_home()?),
                &root,
                gandalf_service::ipc::WireActor::Agent { provider },
            )
            .await?;
            gandalf_service::serve_stdio(gandalf_service::HandoffMcpServer::new(
                std::sync::Arc::new(client),
            ))
            .await
            .map_err(|_| CliError::Unavailable)
        }
        args::Command::Hook { command } => {
            let root = project_root(cli.project_root)?;
            let paths = GandalfPaths::from_home(&user_home()?);
            match command {
                args::HookCommand::Ingest {
                    provider,
                    max_bytes,
                } => {
                    let provider = match provider {
                        args::ProviderArg::Claude => gandalf_core::Provider::Claude,
                        args::ProviderArg::Codex => gandalf_core::Provider::Codex,
                    };
                    gandalf_ingest::ProjectResolver::new(&root)
                        .and_then(|resolver| resolver.resolve(&root))
                        .map_err(|_| CliError::InvalidProject)?;
                    commands::hook::ingest_stdin(&paths, &user_home()?, provider, max_bytes)
                }
                args::HookCommand::ActiveIndex {
                    provider,
                    max_items,
                } => {
                    let provider = match provider {
                        args::ProviderArg::Claude => gandalf_core::Provider::Claude,
                        args::ProviderArg::Codex => gandalf_core::Provider::Codex,
                    };
                    commands::hook::active_index(&paths, &root, provider, max_items).await
                }
            }
        }
    }
}

/// Bounded public CLI failures.
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("the gandalf background service is not reachable")]
    Unavailable,
    #[error("the gandalf background service refused the request")]
    Rejected,
    #[error("this directory is not inside a Git repository gandalf can use")]
    InvalidProject,
    #[error("your home directory could not be determined")]
    HomeUnavailable,
    #[error("that identifier is not valid")]
    InvalidIdentifier,
    #[error("unable to write output")]
    Output,
    #[error("that configuration value is not valid")]
    InvalidConfig,
    #[error("hook payload is invalid or does not name a verified local source")]
    InvalidHook,
    #[error("{0}")]
    Platform(#[from] PlatformError),
    #[error("{0}")]
    Skill(#[from] gandalf_skills::SkillError),
    #[error("{0}")]
    Distill(gandalf_distill::DistillError),
    #[error("some skills were left unchanged; see the reasons above")]
    SkillConflict,
}

fn project_root(configured: Option<std::path::PathBuf>) -> Result<std::path::PathBuf, CliError> {
    configured
        .map_or_else(std::env::current_dir, Ok)
        .map_err(|_| CliError::InvalidProject)
}

fn user_home() -> Result<std::path::PathBuf, CliError> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or(CliError::HomeUnavailable)
}

impl CliError {
    #[must_use]
    pub const fn exit_code(&self) -> u8 {
        match self {
            Self::Skill(_) | Self::SkillConflict | Self::Distill(_) => 1,
            _ => 69,
        }
    }

    /// What the user can do about this failure, when there is a useful answer.
    #[must_use]
    pub fn hint(&self) -> Option<&'static str> {
        match self {
            Self::Unavailable => Some(
                "Start it with `gandalf daemon start`, or run `gandalf doctor` to see what is wrong.",
            ),
            Self::Rejected => Some(
                "The service is running but could not answer. Run `gandalf doctor`, and check `gandalf daemon logs`.",
            ),
            Self::InvalidProject => {
                Some("Run this inside a Git repository, or pass --project-root <DIR>.")
            }
            Self::HomeUnavailable => Some("Set the HOME environment variable and try again."),
            Self::InvalidIdentifier => Some("Copy the id from `gandalf work list`."),
            Self::InvalidConfig => Some("retention-days takes a whole number from 1 to 3650."),
            Self::Distill(gandalf_distill::DistillError::AgentUnavailable(_)) => Some(
                "Distilling uses the coding agent each session came from. Install it and sign in, then try again.",
            ),
            Self::Distill(gandalf_distill::DistillError::AgentFailed { agent, .. }) => {
                if *agent == "codex" {
                    Some(
                        "`codex exec hi` should answer. If it rejects your default model, set GANDALF_CODEX_MODEL to a model your account can use non-interactively.",
                    )
                } else {
                    Some(
                        "Check that the agent is signed in and not rate limited: `claude -p hi` should answer.",
                    )
                }
            }
            Self::Platform(PlatformError::UnsafePath) => Some(
                "gandalf requires your home directory and ~/.gandalf to be owned by you, with no access for group or other users.",
            ),
            Self::Platform(PlatformError::Service) => {
                Some("Run `gandalf doctor` to see what is wrong.")
            }
            _ => None,
        }
    }
}

const fn distill_tool(agent: args::DistillAgentArg) -> gandalf_distill::Tool {
    match agent {
        args::DistillAgentArg::ClaudeCode => gandalf_distill::Tool::ClaudeCode,
        args::DistillAgentArg::Codex => gandalf_distill::Tool::Codex,
    }
}

/// Resolves the platform boundary for the user running the command.
fn current_platform() -> Result<platform::macos::MacOsPlatform, CliError> {
    let executable = std::env::current_exe().map_err(|_| PlatformError::ExecutableUnavailable)?;
    Ok(platform::macos::MacOsPlatform::for_current_user(
        executable,
    )?)
}

fn render_init(palette: commands::style::Palette, report: &InitReport) -> String {
    let describe = |change: &Change, changed: &'static str, unchanged: &'static str| match change {
        Change::Changed => palette.good(changed),
        Change::Unchanged => palette.dim(unchanged),
        Change::Unsupported => palette.warn("not supported on this platform"),
    };
    let rows = [
        (
            "Data directory",
            describe(&report.paths, "created", "already in place"),
        ),
        (
            "Claude Code",
            describe(&report.claude, "connected", "already connected"),
        ),
        (
            "Codex",
            describe(&report.codex, "connected", "already connected"),
        ),
        (
            "Background service",
            describe(&report.service, "installed", "already installed"),
        ),
    ];
    let mut text = format!("{} gandalf is set up\n\n", palette.good("✓"));
    for (label, value) in rows {
        let _ = writeln!(text, "  {label:<20}{value}");
    }
    let _ = writeln!(
        text,
        "\nRestart your agents so they pick up gandalf, then check with {}.",
        palette.command("`gandalf status`")
    );
    text
}

async fn human_client(
    configured: Option<std::path::PathBuf>,
) -> Result<gandalf_service::IpcAppClient, CliError> {
    let root = project_root(configured)?;
    commands::client::scoped_client(
        &GandalfPaths::from_home(&user_home()?),
        &root,
        gandalf_service::ipc::WireActor::HumanCli,
    )
    .await
}

async fn run_agent(command: args::AgentCommand) -> Result<(), CliError> {
    let platform = current_platform()?;
    match command {
        args::AgentCommand::List => {
            let palette = commands::style::Palette::stdout();
            let home = platform.home()?;
            for (name, config) in [
                ("Claude Code", ".claude.json"),
                ("Codex", ".codex/config.toml"),
            ] {
                let state = if home.join(config).is_file() {
                    palette.good("configured")
                } else {
                    palette.dim("not configured")
                };
                println!("{name:<13}{state}");
            }
            Ok(())
        }
        args::AgentCommand::Connect => {
            Initializer::new(platform)
                .run(InitOptions { quiet: true })
                .await?;
            println!("Connected Claude Code and Codex. Restart them to pick up gandalf.");
            Ok(())
        }
        args::AgentCommand::Disconnect => {
            commands::agent::disconnect(&platform)?;
            println!("Disconnected Claude Code and Codex. Your other agent settings were kept.");
            Ok(())
        }
    }
}

fn run_config(output: args::Output, command: args::ConfigCommand) -> Result<(), CliError> {
    let settings = commands::config::run(&current_platform()?, command)?;
    match output {
        args::Output::Json => {
            let encoded = serde_json::to_vec(&settings).map_err(|_| CliError::Output)?;
            std::io::stdout()
                .lock()
                .write_all(&encoded)
                .and_then(|()| std::io::stdout().lock().write_all(b"\n"))
                .map_err(|_| CliError::Output)
        }
        args::Output::Text => {
            println!("retention_days={}", settings.retention_days);
            Ok(())
        }
    }
}

async fn call(
    client: &gandalf_service::IpcAppClient,
    request: gandalf_core::api::AppRequest,
) -> Result<gandalf_core::api::AppResponse, CliError> {
    use gandalf_service::AppClient;

    client.call(request).await.map_err(|error| match error {
        gandalf_service::ClientError::Rejected => CliError::Rejected,
        gandalf_service::ClientError::Unavailable => CliError::Unavailable,
    })
}

fn parse_work_id(value: &str) -> Result<gandalf_core::WorkId, CliError> {
    gandalf_core::WorkId::parse_wire(value).ok_or(CliError::InvalidIdentifier)
}

fn render_doctor(
    output: args::Output,
    report: &commands::doctor::DoctorReport,
) -> Result<(), CliError> {
    match output {
        args::Output::Json => {
            let encoded = serde_json::to_vec(report).map_err(|_| CliError::Output)?;
            std::io::stdout()
                .lock()
                .write_all(&encoded)
                .and_then(|()| std::io::stdout().lock().write_all(b"\n"))
                .map_err(|_| CliError::Output)
        }
        args::Output::Text => {
            print!(
                "{}",
                commands::doctor::render(commands::style::Palette::stdout(), report)
            );
            Ok(())
        }
    }
}

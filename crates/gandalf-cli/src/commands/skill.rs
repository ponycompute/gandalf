//! Skill inventory and management commands. These run in-process and never
//! talk to the daemon.

use std::{
    fmt::Write as _,
    fs,
    io::{self, Write as _},
    path::Path,
};

use gandalf_skills::{
    Action, AddOptions, Agent, Change, ENTRYPOINT, Inventory, Location, RemoveOptions, Report,
    Scope, Skill, SkillError, Status, SyncOptions, add, detect_agents, discover, has_conflicts,
    remove, sync,
};
use serde::Serialize;

use crate::{
    CliError,
    args::{AgentArg, ListScopeArg, Output, ScopeArg, SkillCommand, SkillTarget},
};

/// Runs one `gandalf skill` subcommand.
///
/// # Errors
///
/// Returns a CLI error when the operation fails, when a change was refused,
/// or when stdout cannot be written.
pub fn run(
    output: Output,
    home: &Path,
    project_root: &Path,
    command: SkillCommand,
) -> Result<(), CliError> {
    let location = Location {
        home_dir: home.to_path_buf(),
        project_path: project_root.to_path_buf(),
    };
    match command {
        SkillCommand::List(arguments) => {
            let scopes: &[Scope] = match arguments.scope {
                ListScopeArg::User => &[Scope::User],
                ListScopeArg::Project => &[Scope::Project],
                ListScopeArg::All => &[Scope::User, Scope::Project],
            };
            let agents = agents_in_view(&arguments.agents, &location);
            let inventory = discover(&location, &agents, scopes)?;
            match output {
                Output::Json => json(&inventory),
                Output::Text => write_out(&render_inventory(&inventory, scopes.len() > 1)),
            }
        }
        SkillCommand::Show { name, target } => {
            let (scope, agents) = resolve(&target, &location);
            let inventory = discover(&location, &agents, &[scope])?;
            let skill = inventory
                .find(&name, scope)
                .ok_or(SkillError::NotInstalled { name, scope })?;
            match output {
                Output::Json => json(skill),
                Output::Text => write_out(&render_skill(skill)?),
            }
        }
        SkillCommand::Add {
            path,
            name,
            force,
            dry_run,
            target,
        } => {
            let (scope, agents) = resolve(&target, &location);
            let report = add(
                &path,
                &AddOptions {
                    location: &location,
                    scope,
                    agents: &agents,
                    name: name.as_deref(),
                    force,
                    dry_run,
                },
            )?;
            finish(output, report, dry_run)
        }
        SkillCommand::Sync {
            names,
            from,
            dry_run,
            target,
        } => {
            let (scope, agents) = resolve(&target, &location);
            let report = sync(&SyncOptions {
                location: &location,
                scope,
                names: &names,
                from: from.map(agent),
                to: &agents,
                dry_run,
            })?;
            finish(output, report, dry_run)
        }
        SkillCommand::Remove {
            name,
            dry_run,
            target,
        } => {
            let (scope, agents) = resolve(&target, &location);
            let report = remove(
                &name,
                &RemoveOptions {
                    location: &location,
                    scope,
                    agents: &agents,
                    dry_run,
                },
            )?;
            finish(output, report, dry_run)
        }
    }
}

const fn agent(argument: AgentArg) -> Agent {
    match argument {
        AgentArg::ClaudeCode => Agent::ClaudeCode,
        AgentArg::Codex => Agent::Codex,
        AgentArg::Cursor => Agent::Cursor,
    }
}

fn agents_in_view(requested: &[AgentArg], location: &Location) -> Vec<Agent> {
    if requested.is_empty() {
        detect_agents(location)
    } else {
        requested.iter().copied().map(agent).collect()
    }
}

fn resolve(target: &SkillTarget, location: &Location) -> (Scope, Vec<Agent>) {
    let scope = match target.scope {
        ScopeArg::User => Scope::User,
        ScopeArg::Project => Scope::Project,
    };
    (scope, agents_in_view(&target.agents, location))
}

fn write_out(text: &str) -> Result<(), CliError> {
    io::stdout()
        .lock()
        .write_all(text.as_bytes())
        .map_err(|_| CliError::Output)
}

fn json<T: Serialize>(value: &T) -> Result<(), CliError> {
    let mut encoded = serde_json::to_string_pretty(value).map_err(|_| CliError::Output)?;
    encoded.push('\n');
    write_out(&encoded)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangeReport<'a> {
    dry_run: bool,
    changes: &'a [Change],
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Prints the outcome of a mutating command. Changes that landed before a
/// failure are still reported, and a refused change makes the command fail.
fn finish(output: Output, report: Report, dry_run: bool) -> Result<(), CliError> {
    match output {
        Output::Json => json(&ChangeReport {
            dry_run,
            changes: &report.changes,
            error: report.error.as_ref().map(ToString::to_string),
        })?,
        Output::Text => write_out(&render_changes(&report.changes, dry_run))?,
    }
    if let Some(error) = report.error {
        return Err(error.into());
    }
    if has_conflicts(&report.changes) {
        return Err(CliError::SkillConflict);
    }
    Ok(())
}

fn render_changes(changes: &[Change], dry_run: bool) -> String {
    if changes.is_empty() {
        return "Nothing to do: skills already line up.\n".to_owned();
    }
    let mut text = String::new();
    for change in changes {
        let verb = match (change.action, dry_run) {
            (Action::Install, false) => "installed",
            (Action::Install, true) => "would install",
            (Action::Replace, false) => "replaced",
            (Action::Replace, true) => "would replace",
            (Action::Remove, false) => "removed",
            (Action::Remove, true) => "would remove",
            (Action::Unlink, false) => "unlinked",
            (Action::Unlink, true) => "would unlink",
            (Action::Skip, _) => "unchanged",
            (Action::Conflict, false) => "skipped",
            (Action::Conflict, true) => "would skip",
        };
        // Writing to a String cannot fail.
        let _ = write!(text, "{verb:<14} {}", change.skill);
        if let Some(agent) = change.agent {
            let _ = write!(text, " [{}]", agent.display_name());
        }
        if let Some(reason) = &change.reason {
            let _ = write!(text, ": {reason}");
        }
        if let Some(backup) = &change.backup {
            let _ = write!(text, " (previous copy: {})", backup.display());
        }
        text.push('\n');
    }
    if dry_run {
        text.push_str("\nDry run: nothing was written.\n");
    }
    text
}

fn render_inventory(inventory: &Inventory, show_scope: bool) -> String {
    if inventory.skills.is_empty() {
        let agents: Vec<&str> = inventory
            .agents
            .iter()
            .map(|agent| agent.display_name())
            .collect();
        return format!(
            "No skills found for {}.\nAdd one with `gandalf skill add <path-to-skill-dir>`.\n",
            agents.join(", ")
        );
    }

    let mut rows = Vec::with_capacity(inventory.skills.len() + 1);
    let mut header = vec!["SKILL".to_owned()];
    if show_scope {
        header.push("SCOPE".to_owned());
    }
    header.extend(
        inventory
            .agents
            .iter()
            .map(|agent| agent.display_name().to_uppercase()),
    );
    header.push("STATUS".to_owned());
    rows.push(header);

    let (mut synced, mut partial, mut diverged) = (0_usize, 0_usize, 0_usize);
    for skill in &inventory.skills {
        match skill.status {
            Status::Synced => synced += 1,
            Status::Partial => partial += 1,
            Status::Diverged => diverged += 1,
        }
        let mut row = vec![skill.name.clone()];
        if show_scope {
            row.push(skill.scope.as_str().to_owned());
        }
        row.extend(inventory.agents.iter().map(|&agent| cell(skill, agent)));
        row.push(skill.status.as_str().to_owned());
        rows.push(row);
    }

    let mut text = table(&rows);
    let _ = writeln!(
        text,
        "\n{} skill(s): {synced} synced, {partial} partial, {diverged} diverged",
        inventory.skills.len()
    );
    if partial > 0 {
        text.push_str(
            "Run `gandalf skill sync` to copy partial skills to the agents missing them.\n",
        );
    }
    if diverged > 0 {
        text.push_str("Diverged skills differ between agents: `gandalf skill sync <name> --from <agent>` picks the copy that wins.\n");
    }
    text
}

/// Renders one agent's copy: present, missing, or — for diverged skills — the
/// short content hash so differing copies can be told apart.
fn cell(skill: &Skill, agent: Agent) -> String {
    let Some(install) = skill.install_for(agent) else {
        return "-".to_owned();
    };
    let mut cell = if skill.status == Status::Diverged {
        short_hash(&install.hash).to_owned()
    } else {
        "yes".to_owned()
    };
    if install.linked {
        cell.push_str(" (link)");
    }
    cell
}

fn short_hash(hash: &str) -> &str {
    hash.get(..7).unwrap_or(hash)
}

/// Lays rows out in left-aligned columns separated by two spaces.
fn table(rows: &[Vec<String>]) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns)
        .map(|column| {
            rows.iter()
                .filter_map(|row| row.get(column))
                .map(|value| value.chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    let mut text = String::new();
    for row in rows {
        let mut line = String::new();
        for (value, width) in row.iter().zip(&widths) {
            let _ = write!(line, "{value:<width$}  ");
        }
        text.push_str(line.trim_end());
        text.push('\n');
    }
    text
}

fn render_skill(skill: &Skill) -> Result<String, CliError> {
    let mut text = format!(
        "{} ({} scope, {})\n",
        skill.name,
        skill.scope,
        skill.status.as_str()
    );
    if let Some(description) = &skill.description {
        let _ = writeln!(text, "{description}");
    }
    text.push('\n');

    let mut rows = Vec::new();
    for install in &skill.installs {
        let mut path = install.path.display().to_string();
        if let Some(target) = &install.link_target {
            let _ = write!(path, " -> {}", target.display());
        }
        rows.push(vec![
            install.agent.display_name().to_owned(),
            short_hash(&install.hash).to_owned(),
            path,
        ]);
    }
    for agent in &skill.missing {
        rows.push(vec![
            agent.display_name().to_owned(),
            "-".to_owned(),
            "not installed".to_owned(),
        ]);
    }
    text.push_str(&table(&rows));

    // For a diverged skill the first copy is only one of several; say which.
    if let Some(shown) = skill.installs.first() {
        let entrypoint = shown.path.join(ENTRYPOINT);
        let body = fs::read_to_string(&entrypoint).map_err(|source| SkillError::Io {
            context: format!("read {}", entrypoint.display()),
            source,
        })?;
        let _ = write!(
            text,
            "\n--- {ENTRYPOINT} ({}) ---\n{body}",
            shown.agent.display_name()
        );
        if !body.ends_with('\n') {
            text.push('\n');
        }
    }
    Ok(text)
}

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
    args::{AgentArg, ListScopeArg, Output, ScopeArg, SkillCommand, SkillListArgs, SkillTarget},
    commands::style::{Palette, count, table, tilde},
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
        SkillCommand::List(arguments) => list(output, &location, &arguments),
        SkillCommand::Show { name, target } => show(output, home, &location, name, &target),
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
            finish(output, home, report, dry_run)
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
            finish(output, home, report, dry_run)
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
            finish(output, home, report, dry_run)
        }
    }
}

fn list(output: Output, location: &Location, arguments: &SkillListArgs) -> Result<(), CliError> {
    let scopes: &[Scope] = match arguments.scope {
        ListScopeArg::User => &[Scope::User],
        ListScopeArg::Project => &[Scope::Project],
        ListScopeArg::All => &[Scope::User, Scope::Project],
    };
    let agents = agents_in_view(&arguments.agents, location);
    let inventory = discover(location, &agents, scopes)?;
    match output {
        Output::Json => json(&inventory),
        Output::Text => write_out(&render_inventory(
            Palette::stdout(),
            &inventory,
            scopes.len() > 1,
        )),
    }
}

fn show(
    output: Output,
    home: &Path,
    location: &Location,
    name: String,
    target: &SkillTarget,
) -> Result<(), CliError> {
    let (scope, agents) = resolve(target, location);
    let inventory = discover(location, &agents, &[scope])?;
    let skill = inventory
        .find(&name, scope)
        .ok_or(SkillError::NotInstalled { name, scope })?;
    match output {
        Output::Json => json(skill),
        Output::Text => write_out(&render_skill(Palette::stdout(), home, skill)?),
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
fn finish(output: Output, home: &Path, report: Report, dry_run: bool) -> Result<(), CliError> {
    match output {
        Output::Json => json(&ChangeReport {
            dry_run,
            changes: &report.changes,
            error: report.error.as_ref().map(ToString::to_string),
        })?,
        Output::Text => write_out(&render_changes(
            Palette::stdout(),
            home,
            &report.changes,
            dry_run,
        ))?,
    }
    if let Some(error) = report.error {
        return Err(error.into());
    }
    if has_conflicts(&report.changes) {
        return Err(CliError::SkillConflict);
    }
    Ok(())
}

fn render_changes(palette: Palette, home: &Path, changes: &[Change], dry_run: bool) -> String {
    if changes.is_empty() {
        return format!(
            "{} Nothing to do: skills already line up.\n",
            palette.good("✓")
        );
    }
    let mut text = String::new();
    let (mut applied, mut refused) = (0_usize, 0_usize);
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
        let padded = format!("{verb:<14}");
        let verb = match change.action {
            Action::Install | Action::Replace => {
                applied += 1;
                palette.good(&padded)
            }
            Action::Remove | Action::Unlink => {
                applied += 1;
                palette.warn(&padded)
            }
            Action::Skip => palette.dim(&padded),
            Action::Conflict => {
                refused += 1;
                palette.bad(&padded)
            }
        };
        // Writing to a String cannot fail.
        let _ = write!(text, "{verb} {}", palette.bold(&change.skill));
        if let Some(agent) = change.agent {
            let _ = write!(
                text,
                " {}",
                palette.dim(&format!("[{}]", agent.display_name()))
            );
        }
        if let Some(reason) = &change.reason {
            let _ = write!(text, ": {reason}");
        }
        if let Some(backup) = &change.backup {
            let _ = write!(
                text,
                " {}",
                palette.dim(&format!("(previous copy: {})", tilde(backup, home)))
            );
        }
        text.push('\n');
    }
    text.push('\n');
    if dry_run {
        let _ = writeln!(
            text,
            "Dry run: nothing was written. {} would be applied, {refused} skipped.",
            count(applied, "change")
        );
    } else {
        let _ = writeln!(
            text,
            "{} applied, {refused} skipped.",
            count(applied, "change")
        );
    }
    text
}

fn render_inventory(palette: Palette, inventory: &Inventory, show_scope: bool) -> String {
    if inventory.skills.is_empty() {
        let agents: Vec<&str> = inventory
            .agents
            .iter()
            .map(|agent| agent.display_name())
            .collect();
        return format!(
            "No skills found for {}.\nAdd one with {}.\n",
            agents.join(", "),
            palette.command("`gandalf skill add <path-to-skill-dir>`")
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
    let status_column = header.len() - 1;
    let first_agent_column = if show_scope { 2 } else { 1 };
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

    let mut text = table(&rows, |row, column, value| {
        if row == 0 {
            palette.dim(value)
        } else if column == status_column {
            status_style(palette, value)
        } else if column == 0 {
            palette.bold(value)
        } else if column < first_agent_column || value == "-" {
            palette.dim(value)
        } else if value.starts_with("yes") {
            palette.good(value)
        } else {
            // A content hash: this agent's copy of a diverged skill.
            palette.warn(value)
        }
    });
    let _ = writeln!(
        text,
        "\n{}: {}, {}, {}",
        count(inventory.skills.len(), "skill"),
        tally(palette, synced, "synced"),
        tally(palette, partial, "partial"),
        tally(palette, diverged, "diverged"),
    );
    if let Some(note) = recheck_note(palette, inventory) {
        let _ = writeln!(text, "{note}");
    }
    if partial > 0 {
        let _ = writeln!(
            text,
            "Run {} to copy partial skills to the agents missing them.",
            palette.command("`gandalf skill sync`")
        );
    }
    if diverged > 0 {
        let _ = writeln!(
            text,
            "Diverged skills differ between agents: {} picks the copy that wins.",
            palette.command("`gandalf skill sync <name> --from <agent>`")
        );
    }
    text
}

fn status_style(palette: Palette, status: &str) -> String {
    match status {
        "synced" => palette.good(status),
        "partial" => palette.warn(status),
        "diverged" => palette.bad(status),
        _ => status.to_owned(),
    }
}

/// One summary count, colored only when it is non-zero so a clean inventory
/// stays quiet.
fn tally(palette: Palette, number: usize, status: &str) -> String {
    let text = format!("{number} {status}");
    if number == 0 {
        return palette.dim(&text);
    }
    match status {
        "synced" => palette.good(&text),
        "partial" => palette.warn(&text),
        _ => palette.bad(&text),
    }
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

/// Names the session-derived skills whose seen-once facts are due for a
/// re-check.
fn recheck_note(palette: Palette, inventory: &Inventory) -> Option<String> {
    let today = today();
    let due: Vec<&str> = inventory
        .skills
        .iter()
        .filter(|skill| {
            skill
                .provenance
                .as_ref()
                .is_some_and(|provenance| provenance.recheck_due(&today))
        })
        .map(|skill| skill.name.as_str())
        .collect();
    if due.is_empty() {
        return None;
    }
    Some(palette.warn(&format!(
        "Due for a re-check (seen in one session): {}. `gandalf skill show <name>` for details.",
        due.join(", ")
    )))
}

fn today() -> String {
    time::OffsetDateTime::now_utc()
        .date()
        .format(&time::macros::format_description!("[year]-[month]-[day]"))
        .unwrap_or_default()
}

/// One line on where a session-derived skill came from, and whether its
/// seen-once facts are due for a re-check.
fn render_provenance(palette: Palette, provenance: &gandalf_skills::Provenance) -> String {
    let today = today();
    let mut line = format!(
        "From: {} · {} · drafted {}",
        palette.command("your sessions"),
        count(provenance.lesson_titles.len(), "lesson"),
        provenance.drafted_on
    );
    match &provenance.recheck_after {
        Some(date) if provenance.recheck_due(&today) => {
            let _ = write!(
                line,
                "\n{}",
                palette.warn(&format!(
                    "Seen in one session and due for a re-check since {date}: confirm its facts still hold."
                ))
            );
        }
        Some(date) => {
            let _ = write!(
                line,
                "\n{}",
                palette.dim(&format!("Seen in one session · re-check after {date}"))
            );
        }
        None => {}
    }
    line
}

fn render_skill(palette: Palette, home: &Path, skill: &Skill) -> Result<String, CliError> {
    let mut text = format!(
        "{} {}\n",
        palette.bold(&skill.name),
        palette.dim(&format!("({} scope)", skill.scope)),
    );
    if let Some(description) = &skill.description {
        let _ = writeln!(text, "{description}");
    }
    let _ = writeln!(
        text,
        "\nStatus: {}\n",
        status_style(palette, skill.status.as_str())
    );
    if let Some(provenance) = &skill.provenance {
        let _ = writeln!(text, "{}", render_provenance(palette, provenance));
    }

    let mut rows = Vec::new();
    for install in &skill.installs {
        let mut path = tilde(&install.path, home);
        if let Some(target) = &install.link_target {
            let _ = write!(path, " -> {}", tilde(target, home));
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
    text.push_str(&table(&rows, |_, column, value| {
        if column == 0 {
            value.to_owned()
        } else {
            palette.dim(value)
        }
    }));

    // For a diverged skill the first copy is only one of several; say which.
    if let Some(shown) = skill.installs.first() {
        let entrypoint = shown.path.join(ENTRYPOINT);
        let body = fs::read_to_string(&entrypoint).map_err(|source| SkillError::Io {
            context: format!("read {}", entrypoint.display()),
            source,
        })?;
        let _ = write!(
            text,
            "\n{}\n{body}",
            palette.dim(&format!(
                "--- {ENTRYPOINT} ({}) ---",
                shown.agent.display_name()
            )),
        );
        if !body.ends_with('\n') {
            text.push('\n');
        }
    }
    Ok(text)
}

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;
use time::{OffsetDateTime, macros::format_description};

use crate::{
    SkillError,
    inventory::{
        Agent, ENTRYPOINT, Install, Location, Scope, Skill, Status, discover, inspect, root,
        validate_name,
    },
    tree::{copy_raw, copy_tree, hash_dir},
};

/// What a [`Change`] does to one agent's copy of a skill.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    /// Copy a skill into an agent that lacks it.
    Install,
    /// Overwrite a differing copy; the old copy goes to trash.
    Replace,
    /// Move a copy to trash.
    Remove,
    /// Remove a symlinked skill without touching its target.
    Unlink,
    /// Nothing needed doing.
    Skip,
    /// Gandalf refused to act; `reason` says why.
    Conflict,
}

/// One planned or applied mutation. A dry run returns the same values
/// without touching the filesystem.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub action: Action,
    pub skill: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<Agent>,
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Where the previous copy was moved, when one was displaced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<PathBuf>,
}

/// The outcome of a mutating operation: the changes that were planned (dry
/// run) or that landed, and the failure that stopped it early, if any.
#[derive(Debug)]
pub struct Report {
    pub changes: Vec<Change>,
    pub error: Option<SkillError>,
}

/// Reports whether any change was refused.
#[must_use]
pub fn has_conflicts(changes: &[Change]) -> bool {
    changes
        .iter()
        .any(|change| change.action == Action::Conflict)
}

/// Collapses changes that target the same directory. Codex and Cursor both
/// read `.agents/skills`, so one write there serves both; the later agent's
/// change becomes a `Skip` that says so instead of a second write.
fn dedupe_shared_paths(changes: &mut [Change]) {
    let mut first_by_path: Vec<(PathBuf, Option<Agent>)> = Vec::new();
    for change in changes.iter_mut() {
        let Some(path) = change.path.clone() else {
            continue;
        };
        match first_by_path.iter().find(|(seen, _)| *seen == path) {
            Some((_, owner)) if change.action != Action::Skip => {
                change.action = Action::Skip;
                change.reason = Some(match owner {
                    Some(agent) => format!("same directory as {}", agent.display_name()),
                    None => "same directory".to_owned(),
                });
            }
            Some(_) => {}
            None => first_by_path.push((path, change.agent)),
        }
    }
}

/// Where displaced and removed skills are kept for recovery.
#[must_use]
pub fn trash_dir(location: &Location) -> PathBuf {
    location.home_dir.join(".gandalf").join("trash")
}

/// Options for [`add`].
#[derive(Clone, Debug)]
pub struct AddOptions<'a> {
    pub location: &'a Location,
    pub scope: Scope,
    pub agents: &'a [Agent],
    /// Overrides the skill name; defaults to the source directory name.
    pub name: Option<&'a str>,
    pub force: bool,
    pub dry_run: bool,
}

/// Installs the skill directory at `src` into every agent in `options.agents`.
///
/// # Errors
///
/// Returns an error when `src` is not a skill or the name is unsafe. Failures
/// while applying are reported in [`Report::error`] alongside the changes
/// that landed.
pub fn add(src: &Path, options: &AddOptions<'_>) -> Result<Report, SkillError> {
    let absolute = std::path::absolute(src)
        .map_err(|error| SkillError::io(format!("skill source {}", src.display()), error))?;
    let absolute = if absolute.file_name().is_some_and(|name| name == ENTRYPOINT) {
        absolute
            .parent()
            .map_or(absolute.clone(), Path::to_path_buf)
    } else {
        absolute
    };
    let resolved = fs::canonicalize(&absolute)
        .map_err(|error| SkillError::io(format!("skill source {}", src.display()), error))?;
    if !resolved.join(ENTRYPOINT).is_file() {
        return Err(SkillError::NotASkill(src.to_path_buf()));
    }
    let name = match options.name {
        Some(name) => name.to_owned(),
        None => absolute
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned(),
    };
    validate_name(&name)?;
    let hash = hash_dir(&resolved)
        .map_err(|error| SkillError::io(format!("read skill {}", src.display()), error))?;

    let source = Source {
        name: &name,
        scope: options.scope,
        path: &resolved,
        hash: &hash,
    };
    let changes = options
        .agents
        .iter()
        .map(|&agent| {
            let dest = root(agent, options.scope, options.location).join(&name);
            plan_write(
                &source,
                agent,
                dest,
                options.force,
                "use --force to replace it",
            )
        })
        .collect();
    let mut changes: Vec<Change> = changes;
    dedupe_shared_paths(&mut changes);
    Ok(apply(changes, options.location, options.dry_run))
}

/// Options for [`sync`].
#[derive(Clone, Debug)]
pub struct SyncOptions<'a> {
    pub location: &'a Location,
    pub scope: Scope,
    /// Limits the sync to these skills; empty means every skill.
    pub names: &'a [String],
    /// The agent whose copy wins. When `None`, only skills whose existing
    /// copies already agree are propagated.
    pub from: Option<Agent>,
    pub to: &'a [Agent],
    pub dry_run: bool,
}

/// Copies skills across agents so every agent in `options.to` holds the same
/// content. Copies that differ are only overwritten when `options.from` is
/// set.
///
/// # Errors
///
/// Returns an error when a skill root cannot be read or a named skill is not
/// installed. Failures while applying are reported in [`Report::error`].
pub fn sync(options: &SyncOptions<'_>) -> Result<Report, SkillError> {
    let mut view = options.to.to_vec();
    if let Some(from) = options.from
        && !view.contains(&from)
    {
        view.push(from);
    }
    let inventory = discover(options.location, &view, &[options.scope])?;

    let selected: Vec<&Skill> = if options.names.is_empty() {
        inventory.skills.iter().collect()
    } else {
        options
            .names
            .iter()
            .map(|name| {
                inventory
                    .find(name, options.scope)
                    .ok_or_else(|| SkillError::NotInstalled {
                        name: name.clone(),
                        scope: options.scope,
                    })
            })
            .collect::<Result<_, _>>()?
    };

    let mut changes = Vec::new();
    for skill in selected {
        let install = match pick_source(skill, options.from) {
            Ok(install) => install,
            Err(reason) => {
                // Without explicit names, a skill the --from agent lacks is
                // simply not that agent's to propagate.
                if options.from.is_none() || !options.names.is_empty() {
                    changes.push(Change {
                        action: Action::Conflict,
                        skill: skill.name.clone(),
                        agent: None,
                        scope: skill.scope,
                        path: None,
                        source: None,
                        reason: Some(reason),
                        backup: None,
                    });
                }
                continue;
            }
        };
        let resolved = fs::canonicalize(&install.path).map_err(|error| {
            SkillError::io(format!("resolve {}", install.path.display()), error)
        })?;
        let source = Source {
            name: &skill.name,
            scope: options.scope,
            path: &resolved,
            hash: &install.hash,
        };
        for &agent in options.to {
            if agent == install.agent {
                continue;
            }
            let dest = root(agent, options.scope, options.location).join(&skill.name);
            let change = plan_write(
                &source,
                agent,
                dest,
                options.from.is_some(),
                "pass --from <agent> to choose which copy wins",
            );
            if change.action != Action::Skip {
                changes.push(change);
            }
        }
    }
    dedupe_shared_paths(&mut changes);
    changes.retain(|change| change.action != Action::Skip);
    Ok(apply(changes, options.location, options.dry_run))
}

fn pick_source(skill: &Skill, from: Option<Agent>) -> Result<&Install, String> {
    if let Some(from) = from {
        return skill
            .install_for(from)
            .ok_or_else(|| format!("not installed in {from}"));
    }
    if skill.status == Status::Diverged {
        return Err("copies differ; pass --from <agent> to choose which copy wins".to_owned());
    }
    skill
        .installs
        .first()
        .ok_or_else(|| "no copy found".to_owned())
}

struct Source<'a> {
    name: &'a str,
    scope: Scope,
    path: &'a Path,
    hash: &'a str,
}

/// Decides how to bring `dest` in line with the source skill.
fn plan_write(
    source: &Source<'_>,
    agent: Agent,
    dest: PathBuf,
    replace: bool,
    replace_hint: &str,
) -> Change {
    let (action, reason) = decide_write(source, agent, &dest, replace, replace_hint);
    Change {
        action,
        skill: source.name.to_owned(),
        agent: Some(agent),
        scope: source.scope,
        path: Some(dest),
        source: Some(source.path.to_path_buf()),
        reason,
        backup: None,
    }
}

fn decide_write(
    source: &Source<'_>,
    agent: Agent,
    dest: &Path,
    replace: bool,
    replace_hint: &str,
) -> (Action, Option<String>) {
    let Ok(metadata) = fs::symlink_metadata(dest) else {
        return (Action::Install, None);
    };
    if fs::canonicalize(dest).is_ok_and(|resolved| resolved == source.path) {
        return (
            Action::Skip,
            Some("already points at the source".to_owned()),
        );
    }
    let existing = inspect(dest, agent, source.scope);
    if existing
        .as_ref()
        .is_some_and(|install| install.hash == source.hash)
    {
        return (Action::Skip, Some("already up to date".to_owned()));
    }
    if metadata.file_type().is_symlink() {
        return (
            Action::Conflict,
            Some("is a symlink with different content; remove the link first".to_owned()),
        );
    }
    if !replace {
        let what = if existing.is_some() {
            "a different copy is already installed"
        } else {
            "path exists and is not a skill"
        };
        return (Action::Conflict, Some(format!("{what}; {replace_hint}")));
    }
    (Action::Replace, None)
}

/// Options for [`remove`].
#[derive(Clone, Debug)]
pub struct RemoveOptions<'a> {
    pub location: &'a Location,
    pub scope: Scope,
    pub agents: &'a [Agent],
    pub dry_run: bool,
}

/// Takes the named skill out of every agent in `options.agents`. Real
/// directories move to trash; symlinked skills are only unlinked.
///
/// # Errors
///
/// Returns an error when a skill root cannot be read or the skill is not
/// installed. Failures while applying are reported in [`Report::error`].
pub fn remove(name: &str, options: &RemoveOptions<'_>) -> Result<Report, SkillError> {
    let inventory = discover(options.location, options.agents, &[options.scope])?;
    let skill = inventory
        .find(name, options.scope)
        .ok_or_else(|| SkillError::NotInstalled {
            name: name.to_owned(),
            scope: options.scope,
        })?;
    let changes = skill
        .installs
        .iter()
        .map(|install| Change {
            action: if install.linked {
                Action::Unlink
            } else {
                Action::Remove
            },
            skill: name.to_owned(),
            agent: Some(install.agent),
            scope: install.scope,
            path: Some(install.path.clone()),
            source: None,
            reason: None,
            backup: None,
        })
        .collect();
    let mut changes: Vec<Change> = changes;
    dedupe_shared_paths(&mut changes);
    changes.retain(|change| change.action != Action::Skip);
    Ok(apply(changes, options.location, options.dry_run))
}

fn apply(mut changes: Vec<Change>, location: &Location, dry_run: bool) -> Report {
    if dry_run {
        return Report {
            changes,
            error: None,
        };
    }
    let stamp = trash_stamp();
    for index in 0..changes.len() {
        if let Err(source) = apply_one(&mut changes[index], location, &stamp) {
            let failed = &changes[index];
            let context = format!(
                "{} {} for {}",
                verb(failed.action),
                failed.skill,
                failed.agent.map_or("unknown agent", Agent::as_str),
            );
            changes.truncate(index);
            return Report {
                changes,
                error: Some(SkillError::io(context, source)),
            };
        }
    }
    Report {
        changes,
        error: None,
    }
}

const fn verb(action: Action) -> &'static str {
    match action {
        Action::Install => "install",
        Action::Replace => "replace",
        Action::Remove => "remove",
        Action::Unlink => "unlink",
        Action::Skip | Action::Conflict => "skip",
    }
}

fn apply_one(change: &mut Change, location: &Location, stamp: &str) -> io::Result<()> {
    let missing = || io::Error::new(io::ErrorKind::InvalidInput, "change has no target path");
    match change.action {
        Action::Install => {
            let path = change.path.as_deref().ok_or_else(missing)?;
            let source = change.source.as_deref().ok_or_else(missing)?;
            copy_tree(source, path)
        }
        Action::Replace => {
            let path = change.path.clone().ok_or_else(missing)?;
            let source = change.source.clone().ok_or_else(missing)?;
            let backup = move_to_trash(&path, location, stamp, change)?;
            if let Err(error) = copy_tree(&source, &path) {
                // Put the previous copy back so a failed replace is not a removal.
                let _ = fs::rename(&backup, &path);
                return Err(error);
            }
            change.backup = Some(backup);
            Ok(())
        }
        Action::Remove => {
            let path = change.path.clone().ok_or_else(missing)?;
            change.backup = Some(move_to_trash(&path, location, stamp, change)?);
            Ok(())
        }
        Action::Unlink => fs::remove_file(change.path.as_deref().ok_or_else(missing)?),
        Action::Skip | Action::Conflict => Ok(()),
    }
}

fn trash_stamp() -> String {
    let format = format_description!("[year][month][day]T[hour][minute][second]Z");
    OffsetDateTime::now_utc()
        .format(&format)
        .unwrap_or_else(|_| "unknown-time".to_owned())
}

/// Moves `path` under the trash directory and returns its new location. It
/// falls back to copy-then-delete when a rename cannot cross filesystems.
fn move_to_trash(
    path: &Path,
    location: &Location,
    stamp: &str,
    change: &Change,
) -> io::Result<PathBuf> {
    let parent = trash_dir(location)
        .join(stamp)
        .join(change.scope.as_str())
        .join(change.agent.map_or("unknown", Agent::as_str));
    fs::create_dir_all(&parent)?;
    let mut dest = parent.join(&change.skill);
    let mut suffix = 2_u32;
    while fs::symlink_metadata(&dest).is_ok() {
        dest = parent.join(format!("{}-{suffix}", change.skill));
        suffix += 1;
    }
    if fs::rename(path, &dest).is_ok() {
        return Ok(dest);
    }
    if let Err(error) = copy_raw(path, &dest) {
        let _ = fs::remove_dir_all(&dest);
        return Err(error);
    }
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(dest)
}

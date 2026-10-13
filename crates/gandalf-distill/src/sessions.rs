//! Finds the session files a coding agent keeps for one project.

use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::Serialize;

use crate::DistillError;

/// A coding agent whose sessions can be distilled.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tool {
    ClaudeCode,
}

impl Tool {
    #[must_use]
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
        }
    }
}

/// One session file worth distilling.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub tool: Tool,
    pub id: String,
    pub path: PathBuf,
    pub modified: SystemTime,
    /// Top-level messages typed by the user, after injected context is
    /// dropped. Sessions with fewer than two are not worth a model call.
    pub human_messages: usize,
}

/// Lists Claude Code sessions for `project_root` modified in the last
/// `since_days` days, newest first.
///
/// Claude Code keeps one JSONL file per session under
/// `~/.claude/projects/<encoded project path>/`. Resuming or forking a
/// conversation copies its earlier records into a new file, so files whose
/// user messages are all contained in another file are dropped: distilling
/// them again would cost a model call and produce duplicate lessons.
///
/// # Errors
///
/// Returns [`DistillError::Io`] when the project directory exists but cannot
/// be read. A missing directory yields an empty list.
pub fn find_sessions(
    home: &Path,
    project_root: &Path,
    since_days: u64,
) -> Result<Vec<Session>, DistillError> {
    let directory = home
        .join(".claude")
        .join("projects")
        .join(encode_project(project_root));
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(DistillError::io(
                format!("read {}", directory.display()),
                error,
            ));
        }
    };
    let cutoff = SystemTime::now().checked_sub(Duration::from_secs(since_days * 86_400));

    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry
            .map_err(|error| DistillError::io(format!("read {}", directory.display()), error))?;
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if cutoff.is_some_and(|cutoff| modified < cutoff) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let ids = human_message_ids(&text);
        let id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_owned();
        candidates.push((
            Session {
                tool: Tool::ClaudeCode,
                id,
                path,
                modified,
                human_messages: ids.len(),
            },
            ids,
        ));
    }

    // Keep the file with the most user messages for each conversation.
    candidates.sort_by(|a, b| {
        b.1.len()
            .cmp(&a.1.len())
            .then(b.0.modified.cmp(&a.0.modified))
    });
    let mut kept: Vec<(Session, BTreeSet<String>)> = Vec::new();
    for (session, ids) in candidates {
        let duplicate = !ids.is_empty()
            && kept
                .iter()
                .any(|(_, seen)| ids.iter().all(|id| seen.contains(id)));
        if !duplicate {
            kept.push((session, ids));
        }
    }
    let mut sessions: Vec<Session> = kept.into_iter().map(|(session, _)| session).collect();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.modified));
    Ok(sessions)
}

/// Claude Code names a project directory after the project path with every
/// character that is not an ASCII letter or digit replaced by `-`.
fn encode_project(project_root: &Path) -> String {
    project_root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Returns the `uuid` of every top-level user message that the user typed.
fn human_message_ids(text: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if record["type"] != "user" || record["isSidechain"] == true || record["isMeta"] == true {
            continue;
        }
        let Some(content) = record["message"]["content"].as_str() else {
            continue;
        };
        if !crate::trace::is_typed_by_user(content) {
            continue;
        }
        if let Some(uuid) = record["uuid"].as_str() {
            ids.insert(uuid.to_owned());
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_directory_name_replaces_separators() {
        assert_eq!(
            encode_project(Path::new("/Users/alice/01_projects/plot.v2")),
            "-Users-alice-01-projects-plot-v2"
        );
    }
}

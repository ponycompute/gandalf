use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::{SkillError, tree::hash_dir};

/// The file that makes a directory a skill.
pub const ENTRYPOINT: &str = "SKILL.md";

/// A coding agent whose skills Gandalf manages.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Agent {
    ClaudeCode,
    Codex,
    Cursor,
}

impl Agent {
    /// Every supported agent, in display order.
    pub const ALL: [Self; 3] = [Self::ClaudeCode, Self::Codex, Self::Cursor];

    /// The identifier used on the command line and in JSON.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }

    #[must_use]
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
        }
    }

    /// Parses a command-line identifier.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|agent| agent.as_str() == value)
    }

    const fn config_dir(self) -> &'static str {
        match self {
            Self::ClaudeCode => ".claude",
            Self::Codex => ".codex",
            Self::Cursor => ".cursor",
        }
    }

    /// The directories this agent loads skills from, relative to the home or
    /// project directory, in the agent's own precedence order. These follow
    /// each agent's published documentation: Codex and Cursor read the shared
    /// `.agents/skills`, Cursor additionally reads the Claude Code and Codex
    /// directories for compatibility, and Claude Code reads only its own.
    const fn skill_dirs(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &[".claude/skills"],
            Self::Codex => &[".agents/skills", ".codex/skills"],
            Self::Cursor => &[
                ".agents/skills",
                ".cursor/skills",
                ".claude/skills",
                ".codex/skills",
            ],
        }
    }
}

impl fmt::Display for Agent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Whether a skill lives in the user's home or in a project.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    User,
    Project,
}

impl Scope {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
        }
    }
}

impl fmt::Display for Scope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// How one skill lines up across the agents in view.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    /// Every agent in view has identical content.
    Synced,
    /// Content is identical where present, but some agents lack it.
    Partial,
    /// At least two agents hold different content.
    Diverged,
}

impl Status {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Synced => "synced",
            Self::Partial => "partial",
            Self::Diverged => "diverged",
        }
    }
}

/// The directories skill roots are resolved against.
#[derive(Clone, Debug)]
pub struct Location {
    pub home_dir: PathBuf,
    pub project_path: PathBuf,
}

/// One copy of a skill inside one agent's skill root.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub agent: Agent,
    pub scope: Scope,
    pub path: PathBuf,
    pub hash: String,
    /// True when the skill directory is a symlink. Gandalf never writes
    /// through a linked skill; it only unlinks it.
    pub linked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<PathBuf>,
}

/// One named skill within a scope, with every agent copy found.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: Status,
    pub installs: Vec<Install>,
    pub missing: Vec<Agent>,
}

impl Skill {
    /// Returns the copy held by `agent`, if any.
    #[must_use]
    pub fn install_for(&self, agent: Agent) -> Option<&Install> {
        self.installs.iter().find(|install| install.agent == agent)
    }
}

/// The cross-agent view of skills for the requested scopes.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Inventory {
    pub agents: Vec<Agent>,
    pub skills: Vec<Skill>,
}

impl Inventory {
    /// Returns the skill with the given name and scope.
    #[must_use]
    pub fn find(&self, name: &str, scope: Scope) -> Option<&Skill> {
        self.skills
            .iter()
            .find(|skill| skill.name == name && skill.scope == scope)
    }
}

/// Returns the directory Gandalf writes `agent`'s skills to for `scope`: the
/// first directory the agent reads. Codex and Cursor share `.agents/skills`,
/// so one copy there serves both.
#[must_use]
pub fn root(agent: Agent, scope: Scope, location: &Location) -> PathBuf {
    scope_base(scope, location).join(agent.skill_dirs()[0])
}

/// Returns every directory `agent` reads skills from for `scope`, write
/// directory first.
#[must_use]
pub fn read_roots(agent: Agent, scope: Scope, location: &Location) -> Vec<PathBuf> {
    let base = scope_base(scope, location);
    agent
        .skill_dirs()
        .iter()
        .map(|dir| base.join(dir))
        .collect()
}

fn scope_base(scope: Scope, location: &Location) -> &Path {
    match scope {
        Scope::User => &location.home_dir,
        Scope::Project => &location.project_path,
    }
}

/// Returns the supported agents that have a config directory in the user's
/// home. Falls back to every supported agent when none is found, so a fresh
/// machine still gets a meaningful view.
#[must_use]
pub fn detect_agents(location: &Location) -> Vec<Agent> {
    let detected: Vec<Agent> = Agent::ALL
        .into_iter()
        .filter(|agent| location.home_dir.join(agent.config_dir()).is_dir())
        .collect();
    if detected.is_empty() {
        Agent::ALL.to_vec()
    } else {
        detected
    }
}

/// Rejects names that could not be a single safe directory name.
///
/// # Errors
///
/// Returns [`SkillError::InvalidName`] for an empty name, a name starting
/// with punctuation, or one containing anything but ASCII letters, digits,
/// `.`, `_`, and `-`.
pub fn validate_name(name: &str) -> Result<(), SkillError> {
    let mut characters = name.chars();
    let starts_well = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric());
    let rest_is_safe =
        characters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if starts_well && rest_is_safe {
        Ok(())
    } else {
        Err(SkillError::InvalidName(name.to_owned()))
    }
}

/// Builds the inventory for the given agents and scopes.
///
/// # Errors
///
/// Returns [`SkillError::Io`] when an existing skill root cannot be read.
pub fn discover(
    location: &Location,
    agents: &[Agent],
    scopes: &[Scope],
) -> Result<Inventory, SkillError> {
    let mut grouped: BTreeMap<(Scope, String), (Option<String>, Vec<Install>)> = BTreeMap::new();
    for &scope in scopes {
        for &agent in agents {
            // An agent that reads several directories sees the first copy of
            // a name, matching the precedence it applies itself.
            let mut seen = BTreeSet::new();
            for read_root in read_roots(agent, scope, location) {
                for found in scan_root(&read_root, agent, scope)? {
                    if !seen.insert(found.name.clone()) {
                        continue;
                    }
                    let entry = grouped.entry((scope, found.name)).or_default();
                    if entry.0.is_none() {
                        entry.0 = found.description;
                    }
                    entry.1.push(found.install);
                }
            }
        }
    }

    let skills = grouped
        .into_iter()
        .map(|((scope, name), (description, installs))| {
            let (missing, status) = classify(&installs, agents);
            Skill {
                name,
                scope,
                description,
                status,
                installs,
                missing,
            }
        })
        .collect();
    Ok(Inventory {
        agents: agents.to_vec(),
        skills,
    })
}

fn classify(installs: &[Install], agents: &[Agent]) -> (Vec<Agent>, Status) {
    let mut missing = Vec::new();
    let mut hashes = BTreeSet::new();
    for &agent in agents {
        match installs.iter().find(|install| install.agent == agent) {
            Some(install) => {
                hashes.insert(install.hash.as_str());
            }
            None => missing.push(agent),
        }
    }
    let status = if hashes.len() > 1 {
        Status::Diverged
    } else if missing.is_empty() {
        Status::Synced
    } else {
        Status::Partial
    };
    (missing, status)
}

struct Found {
    name: String,
    description: Option<String>,
    install: Install,
}

/// Lists the skills directly under one agent skill root. A missing root is
/// an empty result, not an error.
fn scan_root(root: &Path, agent: Agent, scope: Scope) -> Result<Vec<Found>, SkillError> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(SkillError::io(
                format!("read skill directory {}", root.display()),
                error,
            ));
        }
    };

    let mut found = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            SkillError::io(format!("read skill directory {}", root.display()), error)
        })?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Some(install) = inspect(&path, agent, scope) else {
            continue;
        };
        found.push(Found {
            description: read_description(&path.join(ENTRYPOINT)),
            name,
            install,
        });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}

/// Reports the install at `path`, or `None` when `path` is not a skill.
pub(crate) fn inspect(path: &Path, agent: Agent, scope: Scope) -> Option<Install> {
    let metadata = fs::symlink_metadata(path).ok()?;
    let linked = metadata.file_type().is_symlink();
    let link_target = if linked {
        fs::read_link(path).ok()
    } else {
        None
    };

    let resolved = fs::canonicalize(path).ok()?;
    if !resolved.is_dir() || !resolved.join(ENTRYPOINT).is_file() {
        return None;
    }
    Some(Install {
        agent,
        scope,
        path: path.to_path_buf(),
        hash: hash_dir(&resolved).ok()?,
        linked,
        link_target,
    })
}

/// Extracts a single-line `description:` from `SKILL.md` frontmatter. Block
/// scalars and missing values yield `None`.
fn read_description(entrypoint: &Path) -> Option<String> {
    let text = fs::read_to_string(entrypoint).ok()?;
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        let Some(value) = line.strip_prefix("description:") else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() || value.starts_with('|') || value.starts_with('>') {
            return None;
        }
        let unquoted = ['"', '\'']
            .into_iter()
            .find_map(|quote| value.strip_prefix(quote)?.strip_suffix(quote))
            .unwrap_or(value);
        return Some(unquoted.to_owned());
    }
    None
}

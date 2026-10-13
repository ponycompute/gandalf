//! Inventory and management of agent skills (directories holding a
//! `SKILL.md` entrypoint) across the supported coding agents.

mod inventory;
mod ops;
mod tree;

pub use inventory::{
    Agent, ENTRYPOINT, Install, Inventory, Location, Scope, Skill, Status, detect_agents, discover,
    read_roots, root, validate_name,
};
pub use ops::{
    Action, AddOptions, Change, RemoveOptions, Report, SyncOptions, add, has_conflicts, remove,
    sync, trash_dir,
};
pub use tree::hash_dir;

use std::{io, path::PathBuf};

/// Failures of skill discovery and skill operations.
#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error(
        "invalid skill name {0:?}: use letters, digits, '.', '_' or '-', starting with a letter or digit"
    )]
    InvalidName(String),
    #[error("{} is not a skill: no SKILL.md found", .0.display())]
    NotASkill(PathBuf),
    #[error("skill {name:?} is not installed in {scope} scope")]
    NotInstalled { name: String, scope: Scope },
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
}

impl SkillError {
    pub(crate) fn io(context: impl Into<String>, source: io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }
}

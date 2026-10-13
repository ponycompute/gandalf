//! Turns coding-agent sessions into skills.
//!
//! The pipeline has four steps, each validated by hand before it was written
//! here:
//!
//! 1. [`trace`]: compress one session file into a short, redacted trajectory
//!    that keeps what the user said, what the agent ran, and what failed.
//! 2. [`distill`]: ask the user's own coding agent, run non-interactively,
//!    what a fresh agent would need to know next time. Session excerpts only
//!    go back to the agent they came from; nothing goes anywhere else.
//! 3. [`group`]: cluster the lessons from several sessions by the area of
//!    work they belong to and decide whether each group is a skill, an
//!    always-on rule, or noise.
//! 4. [`draft`]: write a `SKILL.md` for each skill group.
//!
//! Lessons and drafts are kept as plain files under `~/.gandalf/distill` so
//! they can be inspected, edited, and installed with `gandalf skill add`.

pub mod agent;
pub mod draft;
pub mod group;
pub mod lesson;
pub mod sessions;
pub mod store;
pub mod trace;

pub use agent::{Agent, ClaudeCode, CompletionRequest, FakeAgent, Usage};
pub use draft::{Draft, draft_skill, write_draft};
pub use group::{Destination, Group, GroupScope, Grouping, group_lessons};
pub use lesson::{Cost, Distilled, Lesson, LessonKind, LessonScope, distill_trace};
pub use sessions::{Session, Tool, find_sessions};
pub use store::{SessionRecord, Store, StoredLesson};
pub use trace::{Kind, Trace, build_trace, build_trace_from_text, redact};

use std::{io, path::PathBuf};

/// Failures of the distillation pipeline.
#[derive(Debug, thiserror::Error)]
pub enum DistillError {
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
    #[error("{0} is not installed or not on PATH")]
    AgentUnavailable(&'static str),
    #[error("{agent} exited with status {status}: {stderr}")]
    AgentFailed {
        agent: &'static str,
        status: String,
        stderr: String,
    },
    #[error("{agent} returned something other than the requested structure: {detail}")]
    BadResponse { agent: &'static str, detail: String },
    #[error("session file {} is not readable", .0.display())]
    UnreadableSession(PathBuf),
    #[error("no sessions found for this project under {}", .0.display())]
    NoSessions(PathBuf),
    #[error("invalid skill name {0:?}")]
    InvalidName(String),
}

impl DistillError {
    pub(crate) fn io(context: impl Into<String>, source: io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }
}

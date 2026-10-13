//! Keeps distilled lessons and drafts as plain files under `~/.gandalf/distill`.
//!
//! Layout, per project (the project path hashed into a directory name):
//!
//! ```text
//! ~/.gandalf/distill/<project>/
//!   project.json             the project root this directory is for
//!   lessons/<session id>.json  one file per distilled session
//!   drafts/<skill name>/SKILL.md, provenance.json
//! ```

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{DistillError, group::Grouping, lesson::Lesson};

/// One distilled session as stored.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: String,
    pub tool: String,
    /// Date of the session file's last change, `YYYY-MM-DD`.
    pub session_date: String,
    pub distilled_at: String,
    pub session_goal: String,
    pub total_steps: usize,
    pub sent_steps: usize,
    pub cost_usd: f64,
    pub lessons: Vec<Lesson>,
}

/// A lesson together with the session it came from.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredLesson {
    pub session_id: String,
    pub session_date: String,
    pub lesson: Lesson,
}

/// The per-project store.
#[derive(Clone, Debug)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// Opens (creating if needed) the store for `project_root` under `home`.
    ///
    /// # Errors
    ///
    /// Returns [`DistillError::Io`] when the directory cannot be created.
    pub fn open(home: &Path, project_root: &Path) -> Result<Self, DistillError> {
        let name = format!(
            "{}-{}",
            project_root
                .file_name()
                .map_or_else(
                    || "project".to_owned(),
                    |n| n.to_string_lossy().into_owned()
                )
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect::<String>(),
            short_hash(&project_root.to_string_lossy())
        );
        let root = home.join(".gandalf").join("distill").join(name);
        fs::create_dir_all(root.join("lessons"))
            .map_err(|error| DistillError::io(format!("create {}", root.display()), error))?;
        fs::create_dir_all(root.join("drafts"))
            .map_err(|error| DistillError::io(format!("create {}", root.display()), error))?;
        let marker = serde_json::json!({ "projectRoot": project_root });
        fs::write(
            root.join("project.json"),
            serde_json::to_vec_pretty(&marker).unwrap_or_default(),
        )
        .map_err(|error| DistillError::io("write project.json", error))?;
        Ok(Self { root })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    #[must_use]
    pub fn drafts_dir(&self) -> PathBuf {
        self.root.join("drafts")
    }

    /// Whether `session_id` has already been distilled.
    #[must_use]
    pub fn has_session(&self, session_id: &str) -> bool {
        self.lesson_path(session_id).is_file()
    }

    /// Saves one distilled session.
    ///
    /// # Errors
    ///
    /// Returns [`DistillError::Io`] when the file cannot be written.
    pub fn save_session(&self, record: &SessionRecord) -> Result<(), DistillError> {
        let path = self.lesson_path(&record.session_id);
        fs::write(&path, serde_json::to_vec_pretty(record).unwrap_or_default())
            .map_err(|error| DistillError::io(format!("write {}", path.display()), error))
    }

    /// Loads every distilled session, oldest first.
    ///
    /// # Errors
    ///
    /// Returns [`DistillError::Io`] when the lessons directory cannot be read.
    pub fn sessions(&self) -> Result<Vec<SessionRecord>, DistillError> {
        let dir = self.root.join("lessons");
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(DistillError::io(format!("read {}", dir.display()), error)),
        };
        let mut records = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| DistillError::io(format!("read {}", dir.display()), error))?;
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            if let Ok(record) = serde_json::from_slice::<SessionRecord>(&bytes) {
                records.push(record);
            }
        }
        records.sort_by(|a, b| a.session_date.cmp(&b.session_date));
        Ok(records)
    }

    /// Every stored lesson, flattened, in session order.
    ///
    /// # Errors
    ///
    /// See [`Store::sessions`].
    pub fn lessons(&self) -> Result<Vec<StoredLesson>, DistillError> {
        Ok(self
            .sessions()?
            .into_iter()
            .flat_map(|record| {
                record.lessons.into_iter().map(move |lesson| StoredLesson {
                    session_id: record.session_id.clone(),
                    session_date: record.session_date.clone(),
                    lesson,
                })
            })
            .collect())
    }

    /// The grouping from the last `suggest` run, if any.
    #[must_use]
    pub fn load_grouping(&self) -> Option<Grouping> {
        let bytes = fs::read(self.root.join("groups.json")).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Saves the grouping so the next run can keep its names and
    /// destinations stable.
    ///
    /// # Errors
    ///
    /// Returns [`DistillError::Io`] when the file cannot be written.
    pub fn save_grouping(&self, grouping: &Grouping) -> Result<(), DistillError> {
        fs::write(
            self.root.join("groups.json"),
            serde_json::to_vec_pretty(grouping).unwrap_or_default(),
        )
        .map_err(|error| DistillError::io("write groups.json", error))
    }

    fn lesson_path(&self, session_id: &str) -> PathBuf {
        let safe: String = session_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.root.join("lessons").join(format!("{safe}.json"))
    }
}

/// Eight hex characters of a stable hash, to keep project directories apart
/// without exposing the path.
fn short_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:08x}", hash & 0xffff_ffff)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lesson::{Cost, LessonKind, LessonScope};

    #[test]
    fn store_round_trips_sessions_and_flattens_lessons() {
        let home = tempfile::tempdir().unwrap_or_else(|_| unreachable!());
        let store =
            Store::open(home.path(), Path::new("/tmp/demo")).unwrap_or_else(|_| unreachable!());
        assert!(!store.has_session("s1"));
        store
            .save_session(&SessionRecord {
                session_id: "s1".into(),
                tool: "claude-code".into(),
                session_date: "2026-10-08".into(),
                distilled_at: "2026-10-13T00:00:00Z".into(),
                session_goal: "goal".into(),
                total_steps: 10,
                sent_steps: 5,
                cost_usd: 0.1,
                lessons: vec![Lesson {
                    title: "t".into(),
                    kind: LessonKind::Procedure,
                    scope: LessonScope::ThisRepo,
                    lesson: "l".into(),
                    evidence_steps: vec![1],
                    cost: Cost::Low,
                    would_a_competent_agent_already_know: false,
                }],
            })
            .unwrap_or_else(|_| unreachable!());
        assert!(store.has_session("s1"));
        let lessons = store.lessons().unwrap_or_else(|_| unreachable!());
        assert_eq!(lessons.len(), 1);
        assert_eq!(lessons[0].session_date, "2026-10-08");
        assert!(store.root().join("project.json").is_file());
    }
}

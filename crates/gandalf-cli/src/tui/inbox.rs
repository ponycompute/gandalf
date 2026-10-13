//! The Inbox: skill drafts waiting for a decision, and the skills already
//! installed. Runs entirely from local files; no daemon is needed.

use std::{
    fs,
    path::{Path, PathBuf},
};

use gandalf_skills::{
    Action, AddOptions, Agent, ENTRYPOINT, Location, Scope, Status, add, detect_agents, discover,
};

const MAX_NOTICE_BYTES: usize = 240;

/// Which panel has the keyboard.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Panel {
    Inbox,
    Skills,
}

/// A draft waiting in the inbox.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DraftItem {
    pub name: String,
    pub path: PathBuf,
    pub description: String,
    pub skill_md: String,
    pub drafted_on: String,
    pub sessions: usize,
    pub lessons: usize,
    pub seen_once: bool,
}

/// One installed skill, as the Skills panel shows it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillRow {
    pub name: String,
    pub scope: Scope,
    pub status: Status,
    pub description: String,
    pub installed: Vec<Agent>,
    pub missing: Vec<Agent>,
    pub from_sessions: bool,
    pub recheck_due: bool,
}

#[derive(Clone, Debug)]
pub enum Message {
    FocusPanel(Panel),
    TogglePanel,
    MoveSelection(i8),
    ScrollPreview(i8),
    Approve,
    Dismiss,
    Reload,
    ToggleHelp,
    Notice(String),
    Quit,
}

/// What the loop must do after an update.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Effect {
    Approve,
    Dismiss,
    Reload,
    Quit,
}

#[derive(Debug)]
pub struct InboxApp {
    pub drafts: Vec<DraftItem>,
    pub skills: Vec<SkillRow>,
    pub agents: Vec<Agent>,
    panel: Panel,
    inbox_selected: usize,
    skills_selected: usize,
    preview_scroll: u16,
    preview_limit: std::cell::Cell<u16>,
    notice: Option<String>,
    help: bool,
}

impl InboxApp {
    #[must_use]
    pub fn new(drafts: Vec<DraftItem>, skills: Vec<SkillRow>, agents: Vec<Agent>) -> Self {
        Self {
            panel: if drafts.is_empty() && !skills.is_empty() {
                Panel::Skills
            } else {
                Panel::Inbox
            },
            drafts,
            skills,
            agents,
            inbox_selected: 0,
            skills_selected: 0,
            preview_scroll: 0,
            preview_limit: std::cell::Cell::new(u16::MAX),
            notice: None,
            help: false,
        }
    }

    #[must_use]
    pub const fn panel(&self) -> Panel {
        self.panel
    }

    #[must_use]
    pub const fn help_open(&self) -> bool {
        self.help
    }

    #[must_use]
    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    #[must_use]
    pub const fn preview_scroll(&self) -> u16 {
        self.preview_scroll
    }

    /// The renderer records how far the preview can scroll once it knows
    /// the terminal size.
    pub fn set_preview_limit(&self, limit: u16) {
        self.preview_limit.set(limit);
    }

    #[must_use]
    pub const fn selected_index(&self) -> usize {
        match self.panel {
            Panel::Inbox => self.inbox_selected,
            Panel::Skills => self.skills_selected,
        }
    }

    #[must_use]
    pub fn selected_draft(&self) -> Option<&DraftItem> {
        self.drafts.get(self.inbox_selected)
    }

    #[must_use]
    pub fn selected_skill(&self) -> Option<&SkillRow> {
        self.skills.get(self.skills_selected)
    }

    /// Replaces the lists after a reload, keeping the selection in range.
    pub fn replace(&mut self, drafts: Vec<DraftItem>, skills: Vec<SkillRow>) {
        self.drafts = drafts;
        self.skills = skills;
        self.inbox_selected = self.inbox_selected.min(self.drafts.len().saturating_sub(1));
        self.skills_selected = self
            .skills_selected
            .min(self.skills.len().saturating_sub(1));
        self.preview_scroll = 0;
    }

    pub fn update(&mut self, message: Message) -> Option<Effect> {
        if self.help {
            self.help = false;
            if !matches!(message, Message::Quit) {
                return None;
            }
        }
        match message {
            Message::Quit => return Some(Effect::Quit),
            Message::ToggleHelp => self.help = true,
            Message::FocusPanel(panel) => self.focus(panel),
            Message::TogglePanel => self.focus(match self.panel {
                Panel::Inbox => Panel::Skills,
                Panel::Skills => Panel::Inbox,
            }),
            Message::MoveSelection(delta) => {
                let (selected, len) = match self.panel {
                    Panel::Inbox => (&mut self.inbox_selected, self.drafts.len()),
                    Panel::Skills => (&mut self.skills_selected, self.skills.len()),
                };
                if len > 0 {
                    *selected = selected
                        .saturating_add_signed(isize::from(delta))
                        .min(len - 1);
                }
                self.preview_scroll = 0;
            }
            Message::ScrollPreview(delta) => {
                self.preview_scroll = self
                    .preview_scroll
                    .saturating_add_signed(i16::from(delta))
                    .min(self.preview_limit.get());
            }
            Message::Approve => {
                if self.panel == Panel::Inbox && self.selected_draft().is_some() {
                    return Some(Effect::Approve);
                }
                self.set_notice("Select a draft in the Inbox to approve it.".into());
            }
            Message::Dismiss => {
                if self.panel == Panel::Inbox && self.selected_draft().is_some() {
                    return Some(Effect::Dismiss);
                }
                self.set_notice("Select a draft in the Inbox to dismiss it.".into());
            }
            Message::Reload => return Some(Effect::Reload),
            Message::Notice(text) => self.set_notice(text),
        }
        None
    }

    fn focus(&mut self, panel: Panel) {
        self.panel = panel;
        self.preview_scroll = 0;
    }

    fn set_notice(&mut self, text: String) {
        let mut text = text;
        if text.len() > MAX_NOTICE_BYTES {
            let mut end = MAX_NOTICE_BYTES;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push('…');
        }
        self.notice = Some(text);
    }
}

/// Where drafts go after a decision, beside `drafts/` in the project's
/// distill store.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    Approved,
    Dismissed,
}

impl Decision {
    const fn dir_name(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Dismissed => "dismissed",
        }
    }
}

/// Reads every draft under `drafts_dir`, newest first.
#[must_use]
pub fn load_drafts(drafts_dir: &Path) -> Vec<DraftItem> {
    let Ok(entries) = fs::read_dir(drafts_dir) else {
        return Vec::new();
    };
    let mut drafts: Vec<DraftItem> = entries
        .flatten()
        .filter_map(|entry| read_draft(&entry.path()))
        .collect();
    drafts.sort_by(|a, b| b.drafted_on.cmp(&a.drafted_on).then(a.name.cmp(&b.name)));
    drafts
}

fn read_draft(path: &Path) -> Option<DraftItem> {
    let skill_md = fs::read_to_string(path.join(ENTRYPOINT)).ok()?;
    let name = path.file_name()?.to_string_lossy().into_owned();
    let provenance: serde_json::Value = fs::read(path.join("provenance.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let string = |key: &str| {
        provenance[key]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_default()
    };
    let len = |key: &str| provenance[key].as_array().map_or(0, Vec::len);
    Some(DraftItem {
        name,
        path: path.to_path_buf(),
        description: frontmatter_description(&skill_md),
        drafted_on: string("draftedOn"),
        sessions: len("sessionIds"),
        lessons: len("lessonTitles"),
        seen_once: provenance["seenOnce"].as_bool().unwrap_or(false),
        skill_md,
    })
}

/// The `description:` line of a SKILL.md frontmatter, unquoted.
#[must_use]
pub fn frontmatter_description(skill_md: &str) -> String {
    let mut lines = skill_md.lines();
    if lines.next().is_none_or(|line| line.trim() != "---") {
        return String::new();
    }
    lines
        .take_while(|line| line.trim() != "---")
        .find_map(|line| line.strip_prefix("description:"))
        .map(|value| value.trim().trim_matches(['"', '\'']).to_owned())
        .unwrap_or_default()
}

/// Reads the installed skills in both scopes.
#[must_use]
pub fn load_skills(location: &Location, agents: &[Agent]) -> Vec<SkillRow> {
    let today = today();
    discover(location, agents, &[Scope::Project, Scope::User]).map_or_else(
        |_| Vec::new(),
        |inventory| {
            inventory
                .skills
                .into_iter()
                .map(|skill| SkillRow {
                    installed: skill.installs.iter().map(|install| install.agent).collect(),
                    missing: skill.missing.clone(),
                    from_sessions: skill.provenance.is_some(),
                    recheck_due: skill
                        .provenance
                        .as_ref()
                        .is_some_and(|provenance| provenance.recheck_due(&today)),
                    description: skill.description.unwrap_or_default(),
                    name: skill.name,
                    scope: skill.scope,
                    status: skill.status,
                })
                .collect()
        },
    )
}

fn today() -> String {
    time::OffsetDateTime::now_utc()
        .date()
        .format(&time::macros::format_description!("[year]-[month]-[day]"))
        .unwrap_or_default()
}

/// Installs `draft` into the project for every detected agent and moves
/// the draft out of the inbox. Returns a one-line summary.
///
/// # Errors
///
/// Returns a sentence for the footer when the install was refused or the
/// draft could not be moved.
pub fn approve(location: &Location, draft: &DraftItem) -> Result<String, String> {
    let agents = detect_agents(location);
    let report = add(
        &draft.path,
        &AddOptions {
            location,
            scope: Scope::Project,
            agents: &agents,
            name: Some(&draft.name),
            force: false,
            dry_run: false,
        },
    )
    .map_err(|error| error.to_string())?;
    if let Some(error) = report.error {
        return Err(error.to_string());
    }
    let installed: Vec<&str> = report
        .changes
        .iter()
        .filter(|change| matches!(change.action, Action::Install | Action::Replace))
        .filter_map(|change| change.agent.map(Agent::display_name))
        .collect();
    let conflicts = report
        .changes
        .iter()
        .filter(|change| change.action == Action::Conflict)
        .count();
    if conflicts > 0 {
        return Err(format!(
            "{} already has a different `{}`; resolve it with `gandalf skill add --force`.",
            count(conflicts, "agent"),
            draft.name
        ));
    }
    file_decision(draft, Decision::Approved)?;
    Ok(if installed.is_empty() {
        format!(
            "`{}` was already installed; moved out of the inbox.",
            draft.name
        )
    } else {
        format!(
            "Installed `{}` for {} in this project.",
            draft.name,
            installed.join(", ")
        )
    })
}

/// Moves `draft` to `dismissed/` beside the inbox.
///
/// # Errors
///
/// Returns a sentence for the footer when the draft could not be moved.
pub fn dismiss(draft: &DraftItem) -> Result<String, String> {
    file_decision(draft, Decision::Dismissed)?;
    Ok(format!(
        "Dismissed `{}`; it is kept under dismissed/ in the distill store.",
        draft.name
    ))
}

fn file_decision(draft: &DraftItem, decision: Decision) -> Result<(), String> {
    let Some(store_root) = draft.path.parent().and_then(Path::parent) else {
        return Err("The draft has no distill store around it.".to_owned());
    };
    let target_dir = store_root.join(decision.dir_name());
    fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
    let target = target_dir.join(&draft.name);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    fs::rename(&draft.path, &target).map_err(|error| error.to_string())
}

fn count(number: usize, noun: &str) -> String {
    if number == 1 {
        format!("1 {noun}")
    } else {
        format!("{number} {noun}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(name: &str) -> DraftItem {
        DraftItem {
            name: name.into(),
            path: PathBuf::from(name),
            description: String::new(),
            skill_md: String::new(),
            drafted_on: "2026-10-14".into(),
            sessions: 1,
            lessons: 2,
            seen_once: true,
        }
    }

    #[test]
    fn selection_stays_in_range_and_panels_switch() {
        let mut app = InboxApp::new(vec![draft("a"), draft("b")], Vec::new(), Vec::new());
        assert_eq!(app.panel(), Panel::Inbox);
        app.update(Message::MoveSelection(5));
        assert_eq!(app.selected_index(), 1);
        app.update(Message::MoveSelection(-3));
        assert_eq!(app.selected_index(), 0);
        app.update(Message::TogglePanel);
        assert_eq!(app.panel(), Panel::Skills);
        app.update(Message::MoveSelection(1));
        assert_eq!(app.selected_index(), 0);
    }

    #[test]
    fn approve_and_dismiss_need_a_draft_in_the_inbox() {
        let mut app = InboxApp::new(Vec::new(), Vec::new(), Vec::new());
        assert_eq!(app.update(Message::Approve), None);
        assert!(app.notice().is_some_and(|n| n.contains("Select a draft")));
        let mut app = InboxApp::new(vec![draft("a")], Vec::new(), Vec::new());
        assert_eq!(app.update(Message::Approve), Some(Effect::Approve));
        assert_eq!(app.update(Message::Dismiss), Some(Effect::Dismiss));
    }

    #[test]
    fn help_swallows_the_next_key() {
        let mut app = InboxApp::new(vec![draft("a")], Vec::new(), Vec::new());
        app.update(Message::ToggleHelp);
        assert!(app.help_open());
        assert_eq!(app.update(Message::Approve), None);
        assert!(!app.help_open());
    }

    #[test]
    fn description_is_read_from_frontmatter() {
        let md = "---\nname: x\ndescription: \"Use when the build fails.\"\n---\n# x\n";
        assert_eq!(frontmatter_description(md), "Use when the build fails.");
        assert_eq!(frontmatter_description("# no frontmatter"), "");
    }

    #[test]
    fn drafts_load_from_a_store_and_move_on_dismiss() {
        let dir = tempfile::tempdir().unwrap_or_else(|_| unreachable!());
        let drafts = dir.path().join("drafts");
        let one = drafts.join("local-stack");
        fs::create_dir_all(&one).unwrap_or_else(|_| unreachable!());
        fs::write(
            one.join("SKILL.md"),
            "---\nname: local-stack\ndescription: Stack\n---\n",
        )
        .unwrap_or_else(|_| unreachable!());
        fs::write(
            one.join("provenance.json"),
            r#"{"sessionIds":["s1"],"lessonTitles":["a","b"],"draftedOn":"2026-10-14","seenOnce":true}"#,
        )
        .unwrap_or_else(|_| unreachable!());
        let loaded = load_drafts(&drafts);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].description, "Stack");
        assert_eq!((loaded[0].sessions, loaded[0].lessons), (1, 2));
        assert!(loaded[0].seen_once);

        dismiss(&loaded[0]).unwrap_or_else(|_| unreachable!());
        assert!(load_drafts(&drafts).is_empty());
        assert!(dir.path().join("dismissed/local-stack/SKILL.md").is_file());
    }
}

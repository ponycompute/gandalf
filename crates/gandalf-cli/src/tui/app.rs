use std::time::{Duration, Instant};

use gandalf_core::{
    ContractId, WorkId, WorkStatus,
    api::{CorrectableField, WorkDetail, WorkSummary},
};

const MAX_WORK: usize = 100;
const MAX_EDITOR_BYTES: usize = 4_096;
const MAX_NOTICE_BYTES: usize = 240;
const INITIAL_RETRY: Duration = Duration::from_millis(500);
const MAX_RETRY: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Focus {
    List,
    Contract,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Effect {
    Refresh,
    LoadWork {
        work_id: WorkId,
    },
    CorrectWork {
        work_id: WorkId,
        field: CorrectableField,
        value: String,
    },
    Quit,
}

#[derive(Clone, Debug)]
pub enum Message {
    SelectStatus(WorkStatus),
    ClearStatus,
    /// Steps through the status filters in tab order.
    CycleStatus(i8),
    MoveSelection(i8),
    OpenSelected,
    Back,
    BeginCorrection,
    EditorCharacter(char),
    EditorBackspace,
    SubmitEditor,
    SubmitCorrection {
        field: CorrectableField,
        value: String,
    },
    ReplaceWork(Vec<WorkSummary>),
    ReplaceDetail(Option<Box<WorkDetail>>),
    ConnectionLost,
    ConnectionRestored,
    Notice(&'static str),
    Quit,
}

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("no selected work item")]
    NoSelection,
    #[error("correction exceeds its bound")]
    CorrectionTooLarge,
}

#[derive(Debug)]
pub struct App {
    status: Option<WorkStatus>,
    work: Vec<WorkSummary>,
    detail: Option<Box<WorkDetail>>,
    selected: usize,
    focus: Focus,
    editor: Option<String>,
    stale: bool,
    retries: u8,
    retry_after: Option<Instant>,
    notice: Option<String>,
    detail_scroll: u16,
    /// Furthest the contract can scroll, recorded by the renderer once it has
    /// wrapped the text for the current terminal size.
    detail_scroll_limit: std::cell::Cell<u16>,
}

/// Status filters in the order the tabs show them; `None` is "All".
pub const STATUS_TABS: [Option<WorkStatus>; 4] = [
    None,
    Some(WorkStatus::Active),
    Some(WorkStatus::Blocked),
    Some(WorkStatus::Completed),
];

impl App {
    /// Creates a bounded screen model from already-scoped immutable summaries.
    #[must_use]
    pub fn from_work(mut work: Vec<WorkSummary>) -> Self {
        work.truncate(MAX_WORK);
        Self {
            status: None,
            work,
            detail: None,
            selected: 0,
            focus: Focus::List,
            editor: None,
            stale: false,
            retries: 0,
            retry_after: None,
            notice: None,
            detail_scroll: 0,
            detail_scroll_limit: std::cell::Cell::new(u16::MAX),
        }
    }

    #[must_use]
    pub fn fixture() -> Self {
        let work_id = WorkId::parse_wire("work_fixture").unwrap_or_else(|| unreachable!());
        let contract_id =
            ContractId::parse_wire("contract_fixture").unwrap_or_else(|| unreachable!());
        Self::from_work(vec![WorkSummary {
            work_id,
            contract_id,
            revision: 1,
            status: WorkStatus::Active,
            objective: Some("Bound memory".into()),
            summary: "Fixture work".into(),
        }])
    }

    #[must_use]
    pub fn focus(&self) -> Focus {
        self.focus
    }

    #[must_use]
    pub fn visible_work(&self) -> Vec<&WorkSummary> {
        self.work
            .iter()
            .filter(|work| self.status.is_none_or(|status| status == work.status))
            .take(MAX_WORK)
            .collect()
    }

    #[must_use]
    pub fn selected_contract(&self) -> Option<&WorkSummary> {
        self.visible_work().get(self.selected).copied()
    }

    /// Index of the selected row within [`Self::visible_work`].
    #[must_use]
    pub const fn selected_index(&self) -> usize {
        self.selected
    }

    /// The active status filter; `None` shows all work.
    #[must_use]
    pub const fn status_filter(&self) -> Option<WorkStatus> {
        self.status
    }

    /// Number of loaded work items a status filter would show.
    #[must_use]
    pub fn count(&self, status: Option<WorkStatus>) -> usize {
        self.work
            .iter()
            .filter(|work| status.is_none_or(|status| status == work.status))
            .count()
    }

    /// Lines the contract view is scrolled down by.
    #[must_use]
    pub const fn detail_scroll(&self) -> u16 {
        self.detail_scroll
    }

    /// Records how far the contract view can scroll at the current size.
    pub fn set_detail_scroll_limit(&self, limit: u16) {
        self.detail_scroll_limit.set(limit);
    }

    /// Changing the filter changes which item is selected, so it always
    /// returns to the list: the contract on screen must be the one a
    /// correction would apply to.
    fn set_status(&mut self, status: Option<WorkStatus>) {
        self.status = status;
        self.selected = 0;
        self.focus = Focus::List;
        self.editor = None;
        self.detail = None;
        self.detail_scroll = 0;
    }

    #[must_use]
    pub fn detail(&self) -> Option<&WorkDetail> {
        self.detail.as_deref()
    }

    #[must_use]
    pub const fn is_editing(&self) -> bool {
        self.editor.is_some()
    }

    #[must_use]
    pub const fn is_stale(&self) -> bool {
        self.stale
    }

    #[must_use]
    pub fn notice(&self) -> Option<&str> {
        self.notice.as_deref()
    }

    #[must_use]
    pub fn editor_value(&self) -> Option<&str> {
        self.editor.as_deref()
    }

    /// Emits one coalesced retry only after the current bounded backoff delay.
    pub fn retry_effect(&mut self, now: Instant) -> Option<Effect> {
        if !self.stale || self.retry_after.is_some_and(|deadline| deadline > now) {
            return None;
        }
        self.retry_after = Some(now + retry_delay(self.retries));
        Some(Effect::Refresh)
    }

    /// Applies one bounded UI message without performing IPC itself.
    ///
    /// # Errors
    ///
    /// Returns an error for a missing selection or an invalid correction.
    #[allow(clippy::too_many_lines)]
    pub fn update(&mut self, message: Message) -> Result<Option<Effect>, AppError> {
        match message {
            Message::SelectStatus(status) => {
                self.set_status(Some(status));
                Ok(None)
            }
            Message::ClearStatus => {
                self.set_status(None);
                Ok(None)
            }
            Message::CycleStatus(delta) => {
                // Filters belong to the list; in the contract view the keys
                // that cycle them do nothing rather than drop the user out.
                if self.focus == Focus::Contract {
                    return Ok(None);
                }
                let tabs = isize::try_from(STATUS_TABS.len()).unwrap_or(1);
                let current = STATUS_TABS
                    .iter()
                    .position(|tab| *tab == self.status)
                    .and_then(|index| isize::try_from(index).ok())
                    .unwrap_or(0);
                let next = (current + isize::from(delta)).rem_euclid(tabs);
                let status = usize::try_from(next)
                    .ok()
                    .and_then(|index| STATUS_TABS.get(index).copied())
                    .flatten();
                self.set_status(status);
                Ok(None)
            }
            Message::MoveSelection(delta) => {
                // In the contract view the keys scroll the contract. Moving the
                // hidden list selection there would aim a correction at an
                // item the user cannot see.
                if self.focus == Focus::Contract {
                    self.detail_scroll = self
                        .detail_scroll
                        .min(self.detail_scroll_limit.get())
                        .saturating_add_signed(i16::from(delta))
                        .min(self.detail_scroll_limit.get());
                    return Ok(None);
                }
                let len = self.visible_work().len();
                if len != 0 {
                    let current = isize::try_from(self.selected).unwrap_or(0);
                    let last = isize::try_from(len.saturating_sub(1)).unwrap_or(0);
                    self.selected =
                        usize::try_from((current + isize::from(delta)).clamp(0, last)).unwrap_or(0);
                }
                Ok(None)
            }
            Message::OpenSelected => {
                let work_id = self
                    .selected_contract()
                    .ok_or(AppError::NoSelection)?
                    .work_id
                    .clone();
                // Never show the previously opened contract under a new id.
                if self
                    .detail
                    .as_ref()
                    .is_some_and(|detail| detail.work_id != work_id)
                {
                    self.detail = None;
                }
                self.detail_scroll = 0;
                self.focus = Focus::Contract;
                Ok(Some(Effect::LoadWork { work_id }))
            }
            Message::Back => {
                // Esc closes the innermost layer: the editor first, then the
                // contract view.
                if self.editor.take().is_none() {
                    self.focus = Focus::List;
                    self.detail_scroll = 0;
                }
                Ok(None)
            }
            Message::BeginCorrection => {
                if self.focus != Focus::Contract || self.selected_contract().is_none() {
                    return Err(AppError::NoSelection);
                }
                self.editor = Some(String::new());
                Ok(None)
            }
            Message::EditorCharacter(character) => {
                if let Some(editor) = &mut self.editor
                    && editor.len().saturating_add(character.len_utf8()) <= MAX_EDITOR_BYTES
                {
                    editor.push(character);
                }
                Ok(None)
            }
            Message::EditorBackspace => {
                if let Some(editor) = &mut self.editor {
                    let _ = editor.pop();
                }
                Ok(None)
            }
            Message::SubmitEditor => {
                let value = self.editor.take().ok_or(AppError::NoSelection)?;
                self.update(Message::SubmitCorrection {
                    field: CorrectableField::Objective,
                    value,
                })
            }
            Message::SubmitCorrection { field, value } => {
                if value.is_empty() || value.len() > MAX_EDITOR_BYTES {
                    return Err(AppError::CorrectionTooLarge);
                }
                let work_id = self
                    .selected_contract()
                    .ok_or(AppError::NoSelection)?
                    .work_id
                    .clone();
                Ok(Some(Effect::CorrectWork {
                    work_id,
                    field,
                    value,
                }))
            }
            Message::ReplaceWork(mut work) => {
                work.truncate(MAX_WORK);
                // Keep the same item selected when the list reorders or grows.
                let previous = self.selected_contract().map(|work| work.work_id.clone());
                self.work = work;
                let kept = previous.as_ref().and_then(|work_id| {
                    self.visible_work()
                        .iter()
                        .position(|work| &work.work_id == work_id)
                });
                if let Some(index) = kept {
                    self.selected = index;
                } else {
                    self.selected = self
                        .selected
                        .min(self.visible_work().len().saturating_sub(1));
                    self.detail = None;
                    self.detail_scroll = 0;
                }
                Ok(None)
            }
            Message::ReplaceDetail(detail) => {
                self.detail = detail;
                Ok(None)
            }
            Message::ConnectionLost => {
                self.stale = true;
                self.retries = self.retries.saturating_add(1);
                self.retry_after = Some(Instant::now() + retry_delay(self.retries));
                self.notice = Some("Service unreachable; showing the last verified view.".into());
                Ok(None)
            }
            Message::ConnectionRestored => {
                self.stale = false;
                self.retries = 0;
                self.retry_after = None;
                self.notice = None;
                Ok(None)
            }
            Message::Notice(message) => {
                self.notice = Some(bound(message, MAX_NOTICE_BYTES));
                Ok(None)
            }
            Message::Quit => Ok(Some(Effect::Quit)),
        }
    }
}

fn retry_delay(retries: u8) -> Duration {
    let multiplier = 1_u32 << u32::from(retries.min(4));
    INITIAL_RETRY.saturating_mul(multiplier).min(MAX_RETRY)
}

fn bound(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}…", &value[..end])
}

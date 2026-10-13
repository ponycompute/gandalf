//! Input mapping without transport or side effects.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::{Message, inbox};

/// Rows a page key moves the selection or scrolls the contract.
const PAGE: i8 = 10;

/// Maps the approved work-browser key set to bounded state messages.
#[must_use]
pub fn message_for_key(key: KeyEvent, editing: bool) -> Option<Message> {
    if key.kind == KeyEventKind::Release {
        return None;
    }
    // Raw mode delivers ctrl+c as a key, so it has to quit explicitly; while
    // typing a correction it is the only way out besides esc.
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Some(Message::Quit);
    }
    if editing {
        return match key.code {
            KeyCode::Esc => Some(Message::Back),
            KeyCode::Enter => Some(Message::SubmitEditor),
            KeyCode::Backspace => Some(Message::EditorBackspace),
            KeyCode::Char(character) => Some(Message::EditorCharacter(character)),
            _ => None,
        };
    }
    match key.code {
        KeyCode::Char('q') => Some(Message::Quit),
        KeyCode::Char('r') => Some(Message::Notice("Refreshing…")),
        KeyCode::Char('c') => Some(Message::BeginCorrection),
        KeyCode::Char('1') => Some(Message::SelectStatus(gandalf_core::WorkStatus::Active)),
        KeyCode::Char('2') => Some(Message::SelectStatus(gandalf_core::WorkStatus::Blocked)),
        KeyCode::Char('3') => Some(Message::SelectStatus(gandalf_core::WorkStatus::Completed)),
        KeyCode::Char('0') => Some(Message::ClearStatus),
        KeyCode::Tab | KeyCode::Right | KeyCode::Char('l') => Some(Message::CycleStatus(1)),
        KeyCode::BackTab | KeyCode::Left | KeyCode::Char('h') => Some(Message::CycleStatus(-1)),
        KeyCode::Up | KeyCode::Char('k') => Some(Message::MoveSelection(-1)),
        KeyCode::Down | KeyCode::Char('j') => Some(Message::MoveSelection(1)),
        KeyCode::PageUp => Some(Message::MoveSelection(-PAGE)),
        KeyCode::PageDown => Some(Message::MoveSelection(PAGE)),
        KeyCode::Enter => Some(Message::OpenSelected),
        KeyCode::Esc => Some(Message::Back),
        _ => None,
    }
}

/// Maps keys for the Inbox screen.
#[must_use]
pub fn inbox_message_for_key(key: KeyEvent) -> Option<inbox::Message> {
    use inbox::{Message as M, Panel};
    if key.kind == KeyEventKind::Release {
        return None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return Some(M::Quit);
    }
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => Some(M::Quit),
        KeyCode::Char('?') => Some(M::ToggleHelp),
        KeyCode::Char('a') | KeyCode::Enter => Some(M::Approve),
        KeyCode::Char('x') | KeyCode::Delete => Some(M::Dismiss),
        KeyCode::Char('r') => Some(M::Reload),
        KeyCode::Char('1') => Some(M::FocusPanel(Panel::Inbox)),
        KeyCode::Char('2') => Some(M::FocusPanel(Panel::Skills)),
        KeyCode::Tab | KeyCode::BackTab => Some(M::TogglePanel),
        KeyCode::Up | KeyCode::Char('k') => Some(M::MoveSelection(-1)),
        KeyCode::Down | KeyCode::Char('j') => Some(M::MoveSelection(1)),
        KeyCode::Char('K') | KeyCode::PageUp => Some(M::ScrollPreview(-PAGE)),
        KeyCode::Char('J') | KeyCode::PageDown => Some(M::ScrollPreview(PAGE)),
        _ => None,
    }
}

#![allow(clippy::unwrap_used)]
use gandalf_cli::tui::{App, Effect, Focus, Message};
use gandalf_core::{WorkStatus, api::CorrectableField};
use std::time::{Duration, Instant};
#[test]
fn work_filters_and_detail_navigation_are_deterministic() {
    let mut app = App::fixture();
    app.update(Message::SelectStatus(WorkStatus::Blocked))
        .unwrap();
    assert!(
        app.visible_work()
            .iter()
            .all(|work| work.status == WorkStatus::Blocked)
    );
    app.update(Message::SelectStatus(WorkStatus::Active))
        .unwrap();
    let effect = app.update(Message::OpenSelected).unwrap();
    assert_eq!(app.focus(), Focus::Contract);
    assert!(app.selected_contract().is_some());
    assert!(matches!(effect, Some(Effect::LoadWork { .. })));
}
#[test]
fn correction_creates_effect_without_mutating_cached_contract() {
    let mut app = App::fixture();
    let original = app.selected_contract().unwrap().work_id.clone();
    let effect = app
        .update(Message::SubmitCorrection {
            field: CorrectableField::Objective,
            value: "Keep source memory bounded".into(),
        })
        .unwrap();
    assert!(matches!(effect, Some(Effect::CorrectWork { .. })));
    assert_eq!(app.selected_contract().unwrap().work_id, original);
}

#[test]
fn editor_and_reconnect_paths_remain_effect_driven() {
    let mut app = App::fixture();
    app.update(Message::OpenSelected).unwrap();
    app.update(Message::BeginCorrection).unwrap();
    for character in "Keep memory bounded".chars() {
        app.update(Message::EditorCharacter(character)).unwrap();
    }
    let effect = app.update(Message::SubmitEditor).unwrap();
    assert!(matches!(effect, Some(Effect::CorrectWork { .. })));
    app.update(Message::ConnectionLost).unwrap();
    assert!(app.is_stale());
    assert!(
        app.retry_effect(Instant::now() + Duration::from_secs(9))
            .is_some()
    );
    app.update(Message::ConnectionRestored).unwrap();
    assert!(!app.is_stale());
}

fn work(id: &str, status: WorkStatus) -> gandalf_core::api::WorkSummary {
    gandalf_core::api::WorkSummary {
        work_id: gandalf_core::WorkId::parse_wire(id).unwrap(),
        contract_id: gandalf_core::ContractId::parse_wire("contract_fixture").unwrap(),
        revision: 1,
        status,
        objective: None,
        summary: "Fixture work".into(),
    }
}

// A correction applies to the selected item, so nothing may move the
// selection while the contract view hides the list.
#[test]
fn contract_view_keys_scroll_instead_of_moving_the_hidden_selection() {
    let mut app = App::from_work(vec![
        work("work_one", WorkStatus::Active),
        work("work_two", WorkStatus::Active),
    ]);
    app.update(Message::OpenSelected).unwrap();
    app.set_detail_scroll_limit(3);
    for _ in 0..10 {
        app.update(Message::MoveSelection(1)).unwrap();
    }
    assert_eq!(
        app.selected_contract().unwrap().work_id.as_str(),
        "work_one"
    );
    assert_eq!(app.detail_scroll(), 3, "scrolling stops at the last line");
    app.update(Message::CycleStatus(1)).unwrap();
    assert_eq!(app.focus(), Focus::Contract);
    assert_eq!(app.status_filter(), None);

    // An explicit filter key changes the selection, so it returns to the list.
    app.update(Message::SelectStatus(WorkStatus::Active))
        .unwrap();
    assert_eq!(app.focus(), Focus::List);
}

#[test]
fn escape_closes_the_editor_before_the_contract() {
    let mut app = App::fixture();
    app.update(Message::OpenSelected).unwrap();
    app.update(Message::BeginCorrection).unwrap();
    app.update(Message::Back).unwrap();
    assert!(!app.is_editing());
    assert_eq!(app.focus(), Focus::Contract);
    app.update(Message::Back).unwrap();
    assert_eq!(app.focus(), Focus::List);
}

#[test]
fn filters_cycle_in_tab_order_with_real_counts() {
    let mut app = App::from_work(vec![
        work("work_one", WorkStatus::Active),
        work("work_two", WorkStatus::Blocked),
        work("work_three", WorkStatus::Blocked),
    ]);
    assert_eq!(app.count(None), 3);
    assert_eq!(app.count(Some(WorkStatus::Blocked)), 2);
    assert_eq!(app.count(Some(WorkStatus::Completed)), 0);
    app.update(Message::CycleStatus(1)).unwrap();
    assert_eq!(app.status_filter(), Some(WorkStatus::Active));
    app.update(Message::CycleStatus(-1)).unwrap();
    app.update(Message::CycleStatus(-1)).unwrap();
    assert_eq!(app.status_filter(), Some(WorkStatus::Completed));
}

#[test]
fn refresh_keeps_the_same_item_selected_when_the_list_reorders() {
    let mut app = App::from_work(vec![
        work("work_one", WorkStatus::Active),
        work("work_two", WorkStatus::Active),
    ]);
    app.update(Message::MoveSelection(1)).unwrap();
    app.update(Message::ReplaceWork(vec![
        work("work_new", WorkStatus::Active),
        work("work_two", WorkStatus::Active),
        work("work_one", WorkStatus::Active),
    ]))
    .unwrap();
    assert_eq!(
        app.selected_contract().unwrap().work_id.as_str(),
        "work_two"
    );
}

#[test]
fn control_c_quits_even_while_typing_a_correction() {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    let key = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
    assert!(matches!(
        gandalf_cli::tui::event::message_for_key(key, true),
        Some(Message::Quit)
    ));
    let plain = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::NONE);
    assert!(matches!(
        gandalf_cli::tui::event::message_for_key(plain, true),
        Some(Message::EditorCharacter('c'))
    ));
}

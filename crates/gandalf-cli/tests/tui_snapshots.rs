use gandalf_cli::tui::{App, render::render};
use gandalf_core::{ContractId, WorkId, WorkStatus, api::WorkSummary};
use ratatui::{Terminal, backend::TestBackend};

#[test]
fn bounded_work_view_contains_no_evidence_or_paths() {
    let backend = TestBackend::new(80, 24);
    let mut terminal = Terminal::new(backend).unwrap_or_else(|_| panic!("test terminal"));
    terminal
        .draw(|frame| render(frame, &App::fixture()))
        .unwrap_or_else(|_| panic!("draw"));
    let screen = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect::<String>();
    assert!(screen.contains("gandalf"));
    assert!(screen.contains("work_fixture"));
    assert!(!screen.contains("/Users/"));
    assert!(!screen.contains("UNTRUSTED EVIDENCE DATA"));
}

#[test]
fn renderer_redacts_path_like_summary_text() {
    let backend = TestBackend::new(120, 35);
    let mut terminal = Terminal::new(backend).unwrap_or_else(|_| panic!("test terminal"));
    let mut app = App::from_work(vec![WorkSummary {
        work_id: WorkId::parse_wire("work_fixture").unwrap_or_else(|| panic!("work id")),
        contract_id: ContractId::parse_wire("contract_fixture")
            .unwrap_or_else(|| panic!("contract id")),
        revision: 1,
        status: WorkStatus::Active,
        objective: Some("Inspect /Users/alice/private/project".into()),
        summary: "Changed /Users/alice/private/project/src/main.rs".into(),
    }]);
    app.update(gandalf_cli::tui::Message::OpenSelected)
        .unwrap_or_else(|_| panic!("open detail"));
    terminal
        .draw(|frame| render(frame, &app))
        .unwrap_or_else(|_| panic!("draw"));
    let screen = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect::<String>();
    assert!(!screen.contains("/Users/"));
    assert!(screen.contains("<redacted-path>"));
}

fn draw(app: &App, width: u16, height: u16) -> Vec<String> {
    let mut terminal =
        Terminal::new(TestBackend::new(width, height)).unwrap_or_else(|_| panic!("test terminal"));
    terminal
        .draw(|frame| render(frame, app))
        .unwrap_or_else(|_| panic!("draw"));
    let buffer = terminal.backend().buffer().clone();
    (0..height)
        .map(|y| (0..width).map(|x| buffer[(x, y)].symbol()).collect())
        .collect()
}

fn summary(id: &str, status: WorkStatus) -> WorkSummary {
    WorkSummary {
        work_id: WorkId::parse_wire(id).unwrap_or_else(|| panic!("work id")),
        contract_id: ContractId::parse_wire("contract_fixture")
            .unwrap_or_else(|| panic!("contract id")),
        revision: 1,
        status,
        objective: None,
        summary: "Fixture work".into(),
    }
}

#[test]
fn list_marks_the_selection_and_shows_real_filter_counts() {
    let mut app = App::from_work(vec![
        summary("work_one", WorkStatus::Active),
        summary("work_two", WorkStatus::Blocked),
    ]);
    app.update(gandalf_cli::tui::Message::MoveSelection(1))
        .unwrap_or_else(|_| panic!("move"));
    let screen = draw(&app, 100, 12);
    assert!(screen[1].contains("0 all (2)"), "{screen:#?}");
    assert!(screen[1].contains("1 active (1)") && screen[1].contains("3 completed (0)"));
    let selected: Vec<_> = screen.iter().filter(|line| line.contains('▌')).collect();
    assert_eq!(selected.len(), 1, "{screen:#?}");
    assert!(selected[0].contains("work_two") && selected[0].contains("blocked"));
    assert!(screen.iter().any(|line| line.contains("2 of 2")));
    assert!(screen[11].contains("enter open") && screen[11].contains("q quit"));
}

#[test]
fn long_lists_scroll_to_keep_the_selection_visible() {
    let work = (0..40)
        .map(|index| summary(&format!("work_{index}"), WorkStatus::Active))
        .collect();
    let mut app = App::from_work(work);
    for _ in 0..30 {
        app.update(gandalf_cli::tui::Message::MoveSelection(1))
            .unwrap_or_else(|_| panic!("move"));
    }
    let screen = draw(&app, 80, 12);
    assert!(
        screen
            .iter()
            .any(|line| line.contains('▌') && line.contains("work_30")),
        "{screen:#?}"
    );
}

#[test]
fn empty_states_say_what_to_do_next() {
    let mut app = App::from_work(Vec::new());
    let screen = draw(&app, 80, 10).join("\n");
    assert!(screen.contains("No tracked work in this project yet."));
    app.update(gandalf_cli::tui::Message::SelectStatus(WorkStatus::Blocked))
        .unwrap_or_else(|_| panic!("filter"));
    let screen = draw(&app, 80, 10).join("\n");
    assert!(screen.contains("No blocked work.") && screen.contains("Press 0 to show all work."));
}

#[test]
fn narrow_terminals_drop_hints_whole_and_never_overflow() {
    let app = App::fixture();
    for width in [30_u16, 44, 60] {
        let screen = draw(&app, width, 10);
        assert!(screen[9].contains("↑↓ select"), "{screen:#?}");
        assert!(!screen[9].trim_end().ends_with('·'), "{screen:#?}");
    }
}

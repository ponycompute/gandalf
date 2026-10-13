#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use gandalf_cli::tui::{
    inbox::{DraftItem, InboxApp, Message, Panel, SkillRow},
    inbox_render::render,
};
use gandalf_skills::{Agent, Scope, Status};
use ratatui::{Terminal, backend::TestBackend};

fn draw(app: &InboxApp, width: u16, height: u16) -> Vec<String> {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    terminal.draw(|frame| render(frame, app)).unwrap();
    let buffer = terminal.backend().buffer().clone();
    (0..height)
        .map(|y| {
            (0..width)
                .map(|x| buffer[(x, y)].symbol().to_owned())
                .collect::<String>()
        })
        .collect()
}

fn draft() -> DraftItem {
    DraftItem {
        name: "ui-copy-conventions".into(),
        path: PathBuf::from("/tmp/drafts/ui-copy-conventions"),
        description: "Wording rules for the web app.".into(),
        skill_md: "---\nname: ui-copy-conventions\ndescription: Wording rules\n---\n# UI copy\n\nSay Automations, not Routines.\n".into(),
        drafted_on: "2026-10-14".into(),
        sessions: 1,
        lessons: 3,
        seen_once: true,
    }
}

fn skill() -> SkillRow {
    SkillRow {
        name: "reviewer".into(),
        scope: Scope::User,
        status: Status::Partial,
        description: "Reviews pull requests.".into(),
        installed: vec![Agent::ClaudeCode],
        missing: vec![Agent::Codex],
        from_sessions: false,
        recheck_due: false,
    }
}

#[test]
fn inbox_shows_drafts_preview_and_skills() {
    let app = InboxApp::new(
        vec![draft()],
        vec![skill()],
        vec![Agent::ClaudeCode, Agent::Codex],
    );
    let screen = draw(&app, 110, 30).join("\n");
    assert!(screen.contains("Inbox"), "{screen}");
    assert!(screen.contains("ui-copy-conventions"), "{screen}");
    assert!(screen.contains("1 session"), "{screen}");
    assert!(
        screen.contains("Say Automations, not Routines."),
        "{screen}"
    );
    assert!(screen.contains("seen once"), "{screen}");
    assert!(screen.contains("reviewer"), "{screen}");
    assert!(screen.contains("a approve"), "{screen}");
    // Paths never reach the screen.
    assert!(!screen.contains("/tmp/"), "{screen}");
}

#[test]
fn skills_panel_explains_what_is_missing() {
    let mut app = InboxApp::new(vec![draft()], vec![skill()], vec![Agent::ClaudeCode]);
    app.update(Message::TogglePanel);
    assert_eq!(app.panel(), Panel::Skills);
    let screen = draw(&app, 110, 30).join("\n");
    assert!(screen.contains("Installed for Claude Code"), "{screen}");
    assert!(screen.contains("Missing from Codex"), "{screen}");
}

#[test]
fn empty_inbox_points_at_distill_and_narrow_screens_drop_the_preview() {
    let app = InboxApp::new(Vec::new(), Vec::new(), Vec::new());
    let screen = draw(&app, 70, 20).join("\n");
    assert!(screen.contains("gandalf distill"), "{screen}");
    assert!(screen.contains("No skills installed yet."), "{screen}");
    assert!(!screen.contains("Preview"), "{screen}");
}

#[test]
fn help_overlay_opens_and_closes() {
    let mut app = InboxApp::new(vec![draft()], Vec::new(), Vec::new());
    app.update(Message::ToggleHelp);
    let screen = draw(&app, 100, 30).join("\n");
    assert!(screen.contains("How this works"), "{screen}");
    app.update(Message::MoveSelection(1));
    assert!(!app.help_open());
}

pub mod app;
pub mod event;
pub mod inbox;
pub mod inbox_render;
pub mod render;
pub mod terminal;

pub use app::{App, AppError, Effect, Focus, Message};

use std::{io, time::Instant};

use crossterm::event::{self as terminal_event, Event};
use ratatui::{Terminal, backend::CrosstermBackend};

use gandalf_core::api::{AppRequest, AppResponse, WorkSummary};
use gandalf_service::{AppClient, ClientError, IpcAppClient};

/// Runs the local, IPC-backed work browser. The client has already completed a
/// verified project handshake; this function never opens a database or starts
/// ingestion itself.
///
/// # Errors
///
/// Returns terminal setup, draw, or input errors after best-effort cleanup.
pub async fn run(work: Vec<WorkSummary>, client: IpcAppClient) -> io::Result<()> {
    let _panic_guard = terminal::PanicHookGuard::install();
    let mut stdout = io::stdout();
    let _guard = terminal::TerminalGuard::enter(&mut stdout)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let mut app = App::from_work(work);
    loop {
        if let Some(effect) = app.retry_effect(Instant::now()) {
            execute_effect(&mut app, &client, effect).await;
        }
        terminal.draw(|frame| render::render(frame, &app))?;
        if !terminal_event::poll(std::time::Duration::from_millis(250))? {
            continue;
        }
        let Event::Key(key) = terminal_event::read()? else {
            continue;
        };
        let Some(message) = event::message_for_key(key, app.is_editing()) else {
            continue;
        };
        let manual_refresh =
            matches!(key.code, crossterm::event::KeyCode::Char('r')) && !app.is_editing();
        let effect = app.update(message).ok().flatten();
        if manual_refresh && execute_effect(&mut app, &client, Effect::Refresh).await {
            let _ = app.update(Message::Notice("Refreshed."));
        }
        if matches!(effect, Some(Effect::Quit)) {
            return Ok(());
        }
        if let Some(effect) = effect {
            execute_effect(&mut app, &client, effect).await;
        }
    }
}

/// Runs the Inbox screen from local files: drafts in the project's distill
/// store and the skills installed for the detected agents.
///
/// # Errors
///
/// Returns terminal setup, draw, or input errors after best-effort cleanup.
pub fn run_inbox(home: &std::path::Path, project_root: &std::path::Path) -> io::Result<()> {
    use gandalf_skills::Location;
    let location = Location {
        home_dir: home.to_path_buf(),
        project_path: project_root.to_path_buf(),
    };
    let drafts_dir = gandalf_distill::Store::open(home, project_root)
        .map(|store| store.drafts_dir())
        .map_err(|error| io::Error::other(error.to_string()))?;
    let agents = gandalf_skills::detect_agents(&location);
    let mut app = inbox::InboxApp::new(
        inbox::load_drafts(&drafts_dir),
        inbox::load_skills(&location, &agents),
        agents.clone(),
    );

    let _panic_guard = terminal::PanicHookGuard::install();
    let mut stdout = io::stdout();
    let _guard = terminal::TerminalGuard::enter(&mut stdout)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    loop {
        terminal.draw(|frame| inbox_render::render(frame, &app))?;
        if !terminal_event::poll(std::time::Duration::from_millis(250))? {
            continue;
        }
        let Event::Key(key) = terminal_event::read()? else {
            continue;
        };
        let Some(message) = event::inbox_message_for_key(key) else {
            continue;
        };
        let Some(effect) = app.update(message) else {
            continue;
        };
        let outcome = match effect {
            inbox::Effect::Quit => return Ok(()),
            inbox::Effect::Reload => Ok("Reloaded.".to_owned()),
            inbox::Effect::Approve => app
                .selected_draft()
                .map_or(Ok(String::new()), |draft| inbox::approve(&location, draft)),
            inbox::Effect::Dismiss => app
                .selected_draft()
                .map_or(Ok(String::new()), inbox::dismiss),
        };
        app.replace(
            inbox::load_drafts(&drafts_dir),
            inbox::load_skills(&location, &agents),
        );
        let _ = app.update(inbox::Message::Notice(match outcome {
            Ok(text) => text,
            Err(text) => format!("Could not do that: {text}"),
        }));
    }
}

/// A request the service answered but refused. The connection is fine, so
/// this must not be presented as a lost connection that will retry forever.
const REJECTED: &str = "The service refused that request; run `gandalf doctor`.";

/// Runs one effect chain and reports whether every step succeeded.
async fn execute_effect(app: &mut App, client: &IpcAppClient, mut effect: Effect) -> bool {
    // Shown once the whole chain has succeeded; a restored connection clears
    // notices, so this is set last.
    let mut done: Option<&'static str> = None;
    loop {
        match effect {
            Effect::Quit => return true,
            Effect::Refresh => {
                let page = match client
                    .call(AppRequest::ListWork {
                        status: None,
                        limit: 100,
                    })
                    .await
                {
                    Ok(AppResponse::WorkList(page)) => page,
                    Err(ClientError::Rejected) => {
                        let _ = app.update(Message::Notice(if done.is_some() {
                            "Correction recorded, but the service refused to reload the list."
                        } else {
                            REJECTED
                        }));
                        return false;
                    }
                    _ => {
                        let _ = app.update(Message::ConnectionLost);
                        return false;
                    }
                };
                let _ = app.update(Message::ReplaceWork(page.items));
                let _ = app.update(Message::ConnectionRestored);
                // An open contract is reloaded so it shows the refreshed
                // revision instead of falling back to the cached summary.
                let open = (app.focus() == Focus::Contract)
                    .then(|| app.selected_contract().map(|work| work.work_id.clone()))
                    .flatten();
                let Some(work_id) = open else {
                    if let Some(message) = done {
                        let _ = app.update(Message::Notice(message));
                    }
                    return true;
                };
                effect = Effect::LoadWork { work_id };
            }
            Effect::LoadWork { work_id } => {
                match client.call(AppRequest::GetWork { work_id }).await {
                    Ok(AppResponse::Work(detail)) => {
                        let _ = app.update(Message::ReplaceDetail(Some(detail)));
                        let _ = app.update(Message::ConnectionRestored);
                        if let Some(message) = done {
                            let _ = app.update(Message::Notice(message));
                        }
                        return true;
                    }
                    Ok(AppResponse::NotFound) => {
                        let _ = app.update(Message::ReplaceDetail(None));
                        let _ =
                            app.update(Message::Notice("That work item is no longer available."));
                    }
                    Err(ClientError::Rejected) => {
                        let _ = app.update(Message::Notice(REJECTED));
                    }
                    _ => {
                        let _ = app.update(Message::ConnectionLost);
                    }
                }
                return false;
            }
            Effect::CorrectWork {
                work_id,
                field,
                value,
            } => match client
                .call(AppRequest::CorrectWork {
                    work_id,
                    field,
                    value,
                })
                .await
            {
                Ok(AppResponse::Accepted) => {
                    done = Some("Correction recorded as a new revision.");
                    effect = Effect::Refresh;
                }
                Ok(AppResponse::NotFound) => {
                    let _ = app.update(Message::Notice("That work item is no longer available."));
                    return false;
                }
                Err(ClientError::Rejected) => {
                    let _ = app.update(Message::Notice(
                        "The service refused that correction; nothing was changed.",
                    ));
                    return false;
                }
                _ => {
                    let _ = app.update(Message::ConnectionLost);
                    return false;
                }
            },
        }
    }
}

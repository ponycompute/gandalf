//! Rendering for the Inbox screen: two list panels on the left, the
//! selected item's preview on the right.

use gandalf_skills::{Scope, Status};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Clear, List, ListItem, ListState, Paragraph, Wrap},
};

use super::{
    inbox::{DraftItem, InboxApp, Panel, SkillRow},
    render::{ACCENT, SELECTED_BG, bold, dim, hints, inset, panel, wrap},
};

/// Below this width the preview is hidden and the lists take the screen.
const NARROW_WIDTH: u16 = 80;

pub fn render(frame: &mut Frame, app: &InboxApp) {
    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(3),
        Constraint::Length(2),
    ])
    .split(frame.area());
    render_header(frame, app, areas[0]);

    if areas[1].width < NARROW_WIDTH {
        render_lists(frame, app, areas[1]);
    } else {
        let columns = Layout::horizontal([Constraint::Percentage(42), Constraint::Percentage(58)])
            .split(areas[1]);
        render_lists(frame, app, columns[0]);
        render_preview(frame, app, columns[1]);
    }
    render_footer(frame, app, areas[2]);
    if app.help_open() {
        render_help(frame, frame.area());
    }
}

fn render_header(frame: &mut Frame, app: &InboxApp, area: Rect) {
    let agents = if app.agents.is_empty() {
        "no agents detected".to_owned()
    } else {
        app.agents
            .iter()
            .map(|agent| agent.display_name())
            .collect::<Vec<_>>()
            .join(" · ")
    };
    let title = Line::from(vec![
        Span::styled(" gandalf", bold().fg(ACCENT)),
        Span::styled("  skills from your sessions", dim()),
    ]);
    let right = Line::from(Span::styled(format!("{agents} "), dim()));
    let columns = Layout::horizontal([
        Constraint::Min(0),
        Constraint::Length(u16::try_from(right.width()).unwrap_or(0)),
    ])
    .split(area);
    frame.render_widget(Paragraph::new(title), columns[0]);
    frame.render_widget(Paragraph::new(right), columns[1]);
}

fn render_lists(frame: &mut Frame, app: &InboxApp, area: Rect) {
    let inbox_rows = u16::try_from(app.drafts.len()).unwrap_or(u16::MAX);
    // The focused panel gets the room; the other shows a few rows.
    let (inbox, skills) = match app.panel() {
        Panel::Inbox => (
            Constraint::Min(5),
            Constraint::Length(6.min(u16::try_from(app.skills.len()).unwrap_or(4) + 3)),
        ),
        Panel::Skills => (
            Constraint::Length(6.min(inbox_rows + 3)),
            Constraint::Min(5),
        ),
    };
    let rows = Layout::vertical([inbox, skills]).split(area);
    render_inbox(frame, app, rows[0]);
    render_skills(frame, app, rows[1]);
}

fn title(label: &str, count: usize, focused: bool) -> Line<'static> {
    let style = if focused { bold().fg(ACCENT) } else { bold() };
    Line::from(vec![
        Span::styled(format!(" {label} "), style),
        Span::styled(format!("{count} "), dim()),
    ])
}

fn render_inbox(frame: &mut Frame, app: &InboxApp, area: Rect) {
    let focused = app.panel() == Panel::Inbox;
    let block = panel(title("Inbox", app.drafts.len(), focused));
    let inner = inset(block.inner(area));
    frame.render_widget(block, area);
    if app.drafts.is_empty() {
        let text = vec![
            Line::from(Span::styled("Nothing waiting.", dim())),
            Line::from(""),
            Line::from(Span::styled("Run `gandalf distill` then", dim())),
            Line::from(Span::styled("`gandalf suggest` to draft skills", dim())),
            Line::from(Span::styled("from your recent sessions.", dim())),
        ];
        frame.render_widget(Paragraph::new(text).wrap(Wrap { trim: false }), inner);
        return;
    }
    let width = usize::from(inner.width);
    let items: Vec<ListItem<'static>> = app.drafts.iter().map(|d| draft_row(d, width)).collect();
    let mut state = ListState::default();
    if focused {
        state.select(Some(app.selected_index()));
    }
    let list = List::new(items).highlight_style(Style::new().bg(SELECTED_BG));
    frame.render_stateful_widget(list, inner, &mut state);
}

fn draft_row(draft: &DraftItem, width: usize) -> ListItem<'static> {
    let marker = if draft.seen_once { "◌" } else { "●" };
    let meta = format!(
        " {} · {}",
        plural(draft.sessions, "session"),
        plural(draft.lessons, "lesson")
    );
    // The name is what the user decides on; the counts go first when the
    // panel is too narrow for both.
    let name_width = draft.name.chars().count();
    let meta = if name_width + meta.len() + 2 <= width {
        meta
    } else {
        String::new()
    };
    let name: String = draft.name.chars().take(width.saturating_sub(2)).collect();
    ListItem::new(Line::from(vec![
        Span::styled(format!("{marker} "), Style::new().fg(ACCENT)),
        Span::styled(name, bold()),
        Span::styled(meta, dim()),
    ]))
}

fn render_skills(frame: &mut Frame, app: &InboxApp, area: Rect) {
    let focused = app.panel() == Panel::Skills;
    let block = panel(title("Skills", app.skills.len(), focused));
    let inner = inset(block.inner(area));
    frame.render_widget(block, area);
    if app.skills.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled("No skills installed yet.", dim()))),
            inner,
        );
        return;
    }
    let items: Vec<ListItem<'static>> = app.skills.iter().map(skill_row).collect();
    let mut state = ListState::default();
    if focused {
        state.select(Some(app.selected_index()));
    }
    let list = List::new(items).highlight_style(Style::new().bg(SELECTED_BG));
    frame.render_stateful_widget(list, inner, &mut state);
}

fn skill_row(skill: &SkillRow) -> ListItem<'static> {
    let (mark, style) = match skill.status {
        Status::Synced => ("✓", Style::new().fg(Color::Green)),
        Status::Partial => ("◐", Style::new().fg(Color::Yellow)),
        Status::Diverged => ("✗", Style::new().fg(Color::Red)),
    };
    let mut spans = vec![
        Span::styled(format!("{mark} "), style),
        Span::styled(skill.name.clone(), bold()),
        Span::styled(
            format!(
                " {}",
                match skill.scope {
                    Scope::Project => "project",
                    Scope::User => "user",
                }
            ),
            dim(),
        ),
    ];
    if skill.recheck_due {
        spans.push(Span::styled(" re-check", Style::new().fg(Color::Yellow)));
    } else if skill.from_sessions {
        spans.push(Span::styled(" from sessions", dim()));
    }
    ListItem::new(Line::from(spans))
}

fn render_preview(frame: &mut Frame, app: &InboxApp, area: Rect) {
    let (heading, lines) = match app.panel() {
        Panel::Inbox => match app.selected_draft() {
            Some(draft) => (
                format!(" {} ", draft.name),
                draft_lines(draft, usize::from(area.width.saturating_sub(4))),
            ),
            None => (" Preview ".to_owned(), Vec::new()),
        },
        Panel::Skills => match app.selected_skill() {
            Some(skill) => (
                format!(" {} ", skill.name),
                skill_lines(skill, usize::from(area.width.saturating_sub(4))),
            ),
            None => (" Preview ".to_owned(), Vec::new()),
        },
    };
    let block = panel(Line::from(Span::styled(heading, bold())));
    let inner = inset(block.inner(area));
    frame.render_widget(block, area);
    let limit = u16::try_from(lines.len())
        .unwrap_or(u16::MAX)
        .saturating_sub(inner.height);
    app.set_preview_limit(limit);
    let scroll = app.preview_scroll().min(limit);
    frame.render_widget(Paragraph::new(lines).scroll((scroll, 0)), inner);
}

fn draft_lines(draft: &DraftItem, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let mut facts = format!(
        "Drafted {} from {} · {}",
        draft.drafted_on,
        plural(draft.sessions, "session"),
        plural(draft.lessons, "lesson")
    );
    if draft.seen_once {
        facts.push_str(" · seen once, re-check its facts before relying on them");
    }
    for text in wrap(&facts, width) {
        lines.push(Line::from(Span::styled(text, dim())));
    }
    lines.push(Line::from(""));
    for raw in draft.skill_md.lines() {
        let style = if raw.starts_with('#') {
            bold().fg(ACCENT)
        } else if raw.starts_with("---")
            || raw.starts_with("name:")
            || raw.starts_with("description:")
        {
            dim()
        } else {
            Style::new()
        };
        if raw.trim().is_empty() {
            lines.push(Line::from(""));
            continue;
        }
        for text in wrap(raw, width) {
            lines.push(Line::from(Span::styled(text, style)));
        }
    }
    lines
}

fn skill_lines(skill: &SkillRow, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for text in wrap(&skill.description, width) {
        lines.push(Line::from(text));
    }
    lines.push(Line::from(""));
    let installed: Vec<&str> = skill.installed.iter().map(|a| a.display_name()).collect();
    let missing: Vec<&str> = skill.missing.iter().map(|a| a.display_name()).collect();
    lines.push(Line::from(vec![
        Span::styled("Installed for ", dim()),
        Span::raw(if installed.is_empty() {
            "nobody".to_owned()
        } else {
            installed.join(", ")
        }),
    ]));
    if !missing.is_empty() {
        lines.push(Line::from(vec![
            Span::styled("Missing from ", dim()),
            Span::raw(missing.join(", ")),
            Span::styled("  (gandalf skill sync)", dim()),
        ]));
    }
    if skill.status == Status::Diverged {
        lines.push(Line::from(Span::styled(
            "Copies differ between agents; `gandalf skill sync --from <agent>` picks one.",
            Style::new().fg(Color::Red),
        )));
    }
    if skill.recheck_due {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Seen in one session and due for a re-check: confirm its facts still hold.",
            Style::new().fg(Color::Yellow),
        )));
    }
    lines
}

fn render_footer(frame: &mut Frame, app: &InboxApp, area: Rect) {
    let rows = Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).split(area);
    let width = usize::from(area.width);
    let notice = app.notice().map_or_else(
        || Span::styled(" Drafts stay local until you approve them.", dim()),
        |notice| Span::raw(format!(" {notice}")),
    );
    frame.render_widget(Paragraph::new(Line::from(notice)), rows[0]);
    let keys: &[(&str, &str)] = match app.panel() {
        Panel::Inbox => &[
            ("a", "approve"),
            ("x", "dismiss"),
            ("↑↓", "select"),
            ("J/K", "scroll preview"),
            ("tab", "skills"),
            ("r", "reload"),
            ("?", "help"),
            ("q", "quit"),
        ],
        Panel::Skills => &[
            ("↑↓", "select"),
            ("J/K", "scroll preview"),
            ("tab", "inbox"),
            ("r", "reload"),
            ("?", "help"),
            ("q", "quit"),
        ],
    };
    frame.render_widget(Paragraph::new(hints(width, keys)), rows[1]);
}

fn render_help(frame: &mut Frame, area: Rect) {
    let lines = vec![
        Line::from(Span::styled("How this works", bold().fg(ACCENT))),
        Line::from(""),
        Line::from("gandalf distill   reads your recent sessions and keeps lessons."),
        Line::from("gandalf suggest   groups lessons and drafts a skill per area."),
        Line::from("Inbox             drafts waiting for you. a installs into this"),
        Line::from("                  project for every agent; x sets it aside."),
        Line::from("Skills            what is installed, and whether every agent"),
        Line::from("                  has the same copy."),
        Line::from(""),
        Line::from(Span::styled("press any key to close", dim())),
    ];
    let height = u16::try_from(lines.len()).unwrap_or(12) + 2;
    let width = 68.min(area.width.saturating_sub(2));
    let popup = Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height: height.min(area.height),
    };
    frame.render_widget(Clear, popup);
    let block = panel(Line::from(Span::styled(" Help ", bold())));
    let inner = inset(block.inner(popup));
    frame.render_widget(block, popup);
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn plural(number: usize, noun: &str) -> String {
    if number == 1 {
        format!("1 {noun}")
    } else {
        format!("{number} {noun}s")
    }
}

//! Deterministic bounded rendering for the work view.

use gandalf_core::{
    WorkStatus,
    api::{WorkDetail, WorkSummary},
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, List, ListItem, ListState, Paragraph},
};

use super::{App, Focus, app::STATUS_TABS};
use crate::commands::output::status_label;

pub(super) const ACCENT: Color = Color::Magenta;
pub(super) const SELECTED_BG: Color = Color::Indexed(236);
/// Below this width list rows show only the id and summary.
const COMPACT_WIDTH: u16 = 72;
/// Widest id column; longer ids are cut so the summary keeps its room.
const MAX_ID_WIDTH: usize = 40;
/// Longest list of one contract section the view spells out.
const MAX_SECTION_ITEMS: usize = 12;

pub(super) fn dim() -> Style {
    Style::new().fg(Color::DarkGray)
}

pub(super) fn bold() -> Style {
    Style::new().add_modifier(Modifier::BOLD)
}

fn status_style(status: WorkStatus) -> Style {
    match status {
        WorkStatus::Active => Style::new().fg(Color::Green),
        WorkStatus::Blocked => Style::new().fg(Color::Red),
        WorkStatus::Observed => Style::new().fg(Color::Yellow),
        WorkStatus::Completed | WorkStatus::Abandoned => dim(),
    }
}

/// Renders only bounded work metadata; evidence and source paths are excluded.
pub fn render(frame: &mut Frame, app: &App) {
    let areas = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(3),
        Constraint::Length(2),
    ])
    .split(frame.area());
    render_header(frame, app, areas[0]);
    match app.focus() {
        Focus::List => render_list(frame, app, areas[1]),
        Focus::Contract => render_contract(frame, app, areas[1]),
    }
    render_footer(frame, app, areas[2]);
}

/// Title, connection state, and the status filters with real counts.
fn render_header(frame: &mut Frame, app: &App, area: Rect) {
    let rows = Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).split(area);
    let connection = if app.is_stale() {
        Line::from(Span::styled(
            "▲ reconnecting… ",
            Style::new().fg(Color::Yellow),
        ))
    } else {
        Line::from(Span::styled("● connected ", Style::new().fg(Color::Green)))
    };
    let title = Line::from(vec![
        Span::styled(" gandalf", bold().fg(ACCENT)),
        Span::styled("  work handoff", dim()),
    ]);
    let columns = Layout::horizontal([
        Constraint::Min(0),
        Constraint::Length(u16::try_from(connection.width()).unwrap_or(0)),
    ])
    .split(rows[0]);
    frame.render_widget(Paragraph::new(title), columns[0]);
    frame.render_widget(Paragraph::new(connection), columns[1]);

    let mut tabs = vec![Span::raw(" ")];
    for (key, filter) in STATUS_TABS.iter().enumerate() {
        let label = filter.map_or("all", status_label);
        let text = format!("{key} {label} ({})", app.count(*filter));
        let style = if *filter == app.status_filter() {
            bold().fg(ACCENT).add_modifier(Modifier::UNDERLINED)
        } else {
            dim()
        };
        tabs.push(Span::styled(text, style));
        tabs.push(Span::raw("   "));
    }
    frame.render_widget(Paragraph::new(Line::from(tabs)), rows[1]);
}

pub(super) fn panel(title: Line<'static>) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(dim())
        .title(title)
}

fn render_list(frame: &mut Frame, app: &App, area: Rect) {
    let work = app.visible_work();
    let position = if work.is_empty() {
        String::new()
    } else {
        format!(" {} of {} ", app.selected_index() + 1, work.len())
    };
    let block = panel(Line::from(Span::styled(" Work ", bold())))
        .title_bottom(Line::from(Span::styled(position, dim())).right_aligned());

    if work.is_empty() {
        let lines = match app.status_filter() {
            None => vec![
                Line::from("No tracked work in this project yet."),
                Line::from(Span::styled(
                    "Work appears here once a connected agent starts a session.",
                    dim(),
                )),
            ],
            Some(status) => vec![
                Line::from(format!("No {} work.", status_label(status))),
                Line::from(Span::styled("Press 0 to show all work.", dim())),
            ],
        };
        let inner = block.inner(area);
        frame.render_widget(block, area);
        frame.render_widget(Paragraph::new(lines), inset(inner));
        return;
    }

    // Narrow terminals keep the summary readable by dropping the status word
    // (the dot still carries it) and the revision.
    let compact = area.width < COMPACT_WIDTH;
    let id_width = work
        .iter()
        .map(|item| item.work_id.as_str().chars().count())
        .max()
        .unwrap_or(0)
        .min(MAX_ID_WIDTH);
    let items: Vec<ListItem> = work
        .iter()
        .map(|item| work_row(item, id_width, compact))
        .collect();
    let list = List::new(items)
        .block(block)
        .highlight_symbol(Line::from(Span::styled("▌ ", Style::new().fg(ACCENT))))
        .highlight_style(Style::new().bg(SELECTED_BG).add_modifier(Modifier::BOLD));
    // The state is rebuilt each frame, so the list scrolls just far enough to
    // keep the selection in view.
    let mut state = ListState::default().with_selected(Some(app.selected_index()));
    frame.render_stateful_widget(list, area, &mut state);
}

fn work_row(work: &WorkSummary, id_width: usize, compact: bool) -> ListItem<'static> {
    // An id cut short must say so: it is what the user copies into commands.
    let full = work.work_id.as_str();
    let id = if full.chars().count() > id_width {
        let kept: String = full.chars().take(id_width.saturating_sub(1)).collect();
        format!("{kept}…")
    } else {
        full.to_owned()
    };
    let mut spans = vec![
        Span::styled("● ", status_style(work.status)),
        Span::raw(format!("{id:<id_width$}  ")),
    ];
    if !compact {
        spans.push(Span::styled(
            format!("{:<9}  ", status_label(work.status)),
            status_style(work.status),
        ));
        spans.push(Span::styled(format!("r{:<3} ", work.revision), dim()));
    }
    spans.push(Span::raw(safe_text(&work.summary)));
    ListItem::new(Line::from(spans))
}

fn render_contract(frame: &mut Frame, app: &App, area: Rect) {
    let Some(selected) = app.selected_contract() else {
        let block = panel(Line::from(Span::styled(" Contract ", bold())));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        frame.render_widget(Paragraph::new("No selected work item"), inset(inner));
        return;
    };
    let title = Line::from(vec![
        Span::styled(format!(" {} ", selected.work_id.as_str()), bold()),
        Span::styled(
            format!("{} ", status_label(selected.status)),
            status_style(selected.status),
        ),
        Span::styled(format!("r{} ", selected.revision), dim()),
    ]);
    let block = panel(title);
    let inner = inset(block.inner(area));
    frame.render_widget(block, area);

    let width = usize::from(inner.width.max(1));
    let lines = app.detail().map_or_else(
        || summary_lines(selected, width),
        |detail| detail_lines(detail, width),
    );
    // Text is wrapped here rather than by the widget so the scroll limit is
    // exact: scrolling stops at the last line instead of running into blank.
    let overflow = lines.len().saturating_sub(usize::from(inner.height));
    let limit = u16::try_from(overflow).unwrap_or(u16::MAX);
    app.set_detail_scroll_limit(limit);
    let scroll = app.detail_scroll().min(limit);
    frame.render_widget(Paragraph::new(lines).scroll((scroll, 0)), inner);
    if overflow > 0 {
        let more = format!(" {scroll}/{limit} ↑↓ ");
        let hint = Rect {
            x: area.x,
            y: area.bottom().saturating_sub(1),
            width: area.width.saturating_sub(1),
            height: 1,
        };
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(more, dim())).right_aligned()),
            hint,
        );
    }
}

fn detail_lines(work: &WorkDetail, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    heading(&mut lines, "Objective", None);
    body(
        &mut lines,
        &work
            .objective
            .as_deref()
            .map_or_else(|| "unknown".into(), safe_text),
        width,
    );
    heading(&mut lines, "Summary", None);
    body(&mut lines, &safe_text(&work.summary), width);
    for (label, values) in [
        ("Completed", &work.completed_steps),
        ("Next", &work.next_actions),
        ("Blockers", &work.blockers),
        ("Verification", &work.verification),
    ] {
        heading(&mut lines, label, Some(values.len()));
        if values.is_empty() {
            lines.push(Line::from(Span::styled("  - none", dim())));
        }
        for value in values.iter().take(MAX_SECTION_ITEMS) {
            bullet(&mut lines, &safe_text(value), width);
        }
        if values.len() > MAX_SECTION_ITEMS {
            lines.push(Line::from(Span::styled(
                format!("  … {} more", values.len() - MAX_SECTION_ITEMS),
                dim(),
            )));
        }
    }
    lines.push(Line::default());
    note(
        &mut lines,
        "Corrections create a new human assertion; this revision is immutable.",
        width,
    );
    lines
}

/// Shown while the full contract is loading or could not be loaded.
fn summary_lines(work: &WorkSummary, width: usize) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    heading(&mut lines, "Objective", None);
    body(
        &mut lines,
        &work
            .objective
            .as_deref()
            .map_or_else(|| "unknown".into(), safe_text),
        width,
    );
    heading(&mut lines, "Summary", None);
    body(&mut lines, &safe_text(&work.summary), width);
    lines.push(Line::default());
    note(
        &mut lines,
        "Showing the cached summary; the full contract is not loaded. Press enter to retry.",
        width,
    );
    note(
        &mut lines,
        "Corrections create a new human assertion; this cached revision is immutable.",
        width,
    );
    lines
}

fn heading(lines: &mut Vec<Line<'static>>, label: &str, count: Option<usize>) {
    let mut spans = vec![Span::styled(label.to_owned(), bold())];
    if let Some(count) = count {
        spans.push(Span::styled(format!(" {count}"), dim()));
    }
    lines.push(Line::from(spans));
}

fn body(lines: &mut Vec<Line<'static>>, text: &str, width: usize) {
    for wrapped in wrap(text, width.saturating_sub(2)) {
        lines.push(Line::from(format!("  {wrapped}")));
    }
}

fn bullet(lines: &mut Vec<Line<'static>>, text: &str, width: usize) {
    for (index, wrapped) in wrap(text, width.saturating_sub(4)).into_iter().enumerate() {
        let marker = if index == 0 { "  - " } else { "    " };
        lines.push(Line::from(format!("{marker}{wrapped}")));
    }
}

fn note(lines: &mut Vec<Line<'static>>, text: &str, width: usize) {
    for wrapped in wrap(text, width) {
        lines.push(Line::from(Span::styled(wrapped, dim())));
    }
}

/// Greedy word wrap by display width. A word wider than the line is kept
/// whole and clipped by the terminal rather than split mid-token.
pub(super) fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_width = 0_usize;
    for word in text.split_whitespace() {
        let word_width = Span::raw(word).width();
        if !current.is_empty() && current_width + 1 + word_width > width {
            lines.push(std::mem::take(&mut current));
            current_width = 0;
        }
        if !current.is_empty() {
            current.push(' ');
            current_width += 1;
        }
        current.push_str(word);
        current_width += word_width;
    }
    if !current.is_empty() || lines.is_empty() {
        lines.push(current);
    }
    lines
}

/// Notice or correction prompt on the first row, key hints on the second.
fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let rows = Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).split(area);
    let width = usize::from(area.width);

    if let Some(editor) = app.editor_value() {
        let prompt = Line::from(vec![
            Span::styled(" New objective › ", bold().fg(ACCENT)),
            Span::raw(tail(editor, width.saturating_sub(19))),
            Span::styled("▏", Style::new().fg(ACCENT)),
        ]);
        frame.render_widget(Paragraph::new(prompt), rows[0]);
        frame.render_widget(
            Paragraph::new(hints(width, &[("enter", "submit"), ("esc", "cancel")])),
            rows[1],
        );
        return;
    }

    let notice = app.notice().map_or_else(
        || {
            Span::styled(
                " No untrusted evidence is rendered in the work browser.",
                dim(),
            )
        },
        |notice| {
            let style = if app.is_stale() {
                Style::new().fg(Color::Yellow)
            } else {
                Style::new()
            };
            Span::styled(format!(" {notice}"), style)
        },
    );
    frame.render_widget(Paragraph::new(Line::from(notice)), rows[0]);

    let keys: &[(&str, &str)] = match app.focus() {
        Focus::List => &[
            ("↑↓", "select"),
            ("enter", "open"),
            ("tab", "filter"),
            ("q", "quit"),
            ("r", "refresh"),
            ("0-3", "jump to filter"),
        ],
        Focus::Contract => &[
            ("esc", "back"),
            ("c", "correct objective"),
            ("↑↓", "scroll"),
            ("q", "quit"),
            ("r", "refresh"),
        ],
    };
    frame.render_widget(Paragraph::new(hints(width, keys)), rows[1]);
}

/// `key action · key action`, most important first. Hints that do not fit are
/// dropped from the end rather than cut off mid-word.
pub(super) fn hints(width: usize, keys: &[(&str, &str)]) -> Line<'static> {
    let mut spans = vec![Span::raw(" ")];
    let mut used = 1_usize;
    for (index, (key, action)) in keys.iter().enumerate() {
        let separator = if index == 0 { 0 } else { 3 };
        let needed = separator + Span::raw(*key).width() + 1 + Span::raw(*action).width();
        if index > 0 && used + needed > width {
            break;
        }
        if index > 0 {
            spans.push(Span::styled(" · ", dim()));
        }
        spans.push(Span::styled((*key).to_owned(), bold()));
        spans.push(Span::styled(format!(" {action}"), dim()));
        used += needed;
    }
    Line::from(spans)
}

/// Keeps the end of the text being typed visible in a narrow prompt.
fn tail(text: &str, width: usize) -> String {
    let count = text.chars().count();
    if count <= width {
        return text.to_owned();
    }
    let skipped = count - width.saturating_sub(1);
    format!("…{}", text.chars().skip(skipped).collect::<String>())
}

/// One column of padding inside a panel border.
pub(super) fn inset(area: Rect) -> Rect {
    Rect {
        x: area.x.saturating_add(1),
        y: area.y,
        width: area.width.saturating_sub(2),
        height: area.height,
    }
}

fn safe_text(value: &str) -> String {
    const MAX_BYTES: usize = 512;
    let mut result = String::with_capacity(value.len().min(MAX_BYTES));
    for token in value.split_whitespace() {
        let rendered = if token.starts_with('/') || token.starts_with("~/") {
            "<redacted-path>"
        } else {
            token
        };
        if !result.is_empty() {
            result.push(' ');
        }
        if result.len().saturating_add(rendered.len()) > MAX_BYTES {
            result.push('…');
            break;
        }
        result.push_str(rendered);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_breaks_on_words_within_the_width() {
        assert_eq!(
            wrap("keep source memory bounded", 12),
            ["keep source", "memory", "bounded"]
        );
        assert_eq!(wrap("", 10), [""]);
        assert_eq!(
            wrap("unbreakablelongtoken x", 5),
            ["unbreakablelongtoken", "x"]
        );
    }

    #[test]
    fn hints_drop_from_the_end_when_narrow() {
        let keys = [("↑↓", "select"), ("enter", "open"), ("q", "quit")];
        let text = |width| {
            hints(width, &keys)
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        };
        assert_eq!(text(80), " ↑↓ select · enter open · q quit");
        assert_eq!(text(24), " ↑↓ select · enter open");
        assert_eq!(text(4), " ↑↓ select");
    }

    #[test]
    fn tail_keeps_the_end_of_long_input() {
        assert_eq!(tail("short", 10), "short");
        assert_eq!(tail("abcdefghij", 5), "…ghij");
    }
}

//! `gandalf distill` and `gandalf suggest`: sessions in, skill drafts out.
//!
//! Both run in-process and never talk to the daemon. The only external call
//! is to the user's own coding agent, run non-interactively with no tools.

use std::{
    fmt::Write as _,
    io::{self, Write as _},
    path::Path,
};

use gandalf_distill::{
    ClaudeCode, Cost, Destination, DistillError, Draft, Group, Session, SessionRecord, Store,
    StoredLesson, Trace, build_trace, distill_trace, draft_skill, find_sessions, group_lessons,
    write_draft,
};
use serde::Serialize;
use time::{OffsetDateTime, macros::format_description};

use crate::{CliError, args::Output, commands::style::Palette};

/// Characters of trace sent per session: about 6k tokens, enough for the
/// user turns, every failure, and most commands of a long session.
const TRACE_BUDGET: usize = 24_000;
/// Sessions with fewer typed messages than this are not worth a model call.
const MIN_HUMAN_MESSAGES: usize = 2;

/// Options for `gandalf distill`.
#[derive(Clone, Debug)]
pub struct DistillOptions {
    pub since_days: u64,
    pub limit: usize,
    pub dry_run: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DistillOutput<'a> {
    dry_run: bool,
    sessions: Vec<SessionOutput<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionOutput<'a> {
    session_id: &'a str,
    session_date: String,
    human_messages: usize,
    trace_steps: usize,
    total_steps: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<&'a SessionRecord>,
}

/// Distills recent sessions of this project into lessons.
///
/// # Errors
///
/// Returns a CLI error when sessions cannot be read, the agent fails, or
/// output cannot be written.
pub fn distill(
    output: Output,
    home: &Path,
    project_root: &Path,
    options: &DistillOptions,
) -> Result<(), CliError> {
    let palette = Palette::stdout();
    let store = Store::open(home, project_root)?;
    let project_name = project_name(project_root);
    let sessions = find_sessions(home, project_root, options.since_days)?;
    let candidates: Vec<&Session> = sessions
        .iter()
        .filter(|session| session.human_messages >= MIN_HUMAN_MESSAGES)
        .filter(|session| !store.has_session(&session.id))
        .take(options.limit)
        .collect();

    if candidates.is_empty() {
        if output == Output::Json {
            return json(&DistillOutput {
                dry_run: options.dry_run,
                sessions: Vec::new(),
            });
        }
        let mut text = format!(
            "Nothing to distill: {} in the last {} days.\n",
            if sessions.is_empty() {
                "no Claude Code sessions for this project".to_owned()
            } else {
                "every session of this project is already distilled, or too short".to_owned()
            },
            options.since_days
        );
        let _ = writeln!(
            text,
            "{}",
            palette
                .dim("Lessons are kept per project; run this from the repository you worked in.")
        );
        return write_out(&text);
    }

    let agent = ClaudeCode::default();
    let mut results = Vec::new();
    let mut records = Vec::new();
    let mut total_cost = 0.0;
    for &session in &candidates {
        let trace = build_trace(&session.path, TRACE_BUDGET)?;
        let session_date = date_of(session);
        if options.dry_run {
            results.push((session, trace, session_date, None));
            continue;
        }
        if output == Output::Text {
            write_out(&format!(
                "{} {} · {} steps sent of {}\n",
                palette.dim("distilling"),
                session_date,
                trace.steps.len(),
                trace.total_steps
            ))?;
        }
        let (distilled, usage) = distill_trace(&agent, &project_name, &trace)?;
        total_cost += usage.cost_usd;
        let record = SessionRecord {
            session_id: session.id.clone(),
            tool: "claude-code".to_owned(),
            session_date: session_date.clone(),
            distilled_at: now(),
            session_goal: distilled.session_goal,
            total_steps: trace.total_steps,
            sent_steps: trace.steps.len(),
            cost_usd: usage.cost_usd,
            lessons: distilled.lessons,
        };
        store.save_session(&record)?;
        records.push(record);
        results.push((session, trace, session_date, Some(records.len() - 1)));
    }

    if output == Output::Json {
        return json(&DistillOutput {
            dry_run: options.dry_run,
            sessions: results
                .iter()
                .map(|(session, trace, date, index)| SessionOutput {
                    session_id: &session.id,
                    session_date: date.clone(),
                    human_messages: session.human_messages,
                    trace_steps: trace.steps.len(),
                    total_steps: trace.total_steps,
                    record: index.map(|i| &records[i]),
                })
                .collect(),
        });
    }
    write_out(&render_distill(
        palette, &results, &records, options, total_cost, &store,
    ))
}

fn render_distill(
    palette: Palette,
    results: &[(&Session, Trace, String, Option<usize>)],
    records: &[SessionRecord],
    options: &DistillOptions,
    total_cost: f64,
    store: &Store,
) -> String {
    let mut text = String::new();
    if options.dry_run {
        let _ = writeln!(
            text,
            "{} would be sent to Claude Code, about ${:.2} in total:\n",
            count(results.len(), "session"),
            0.16 * f64::from(u32::try_from(results.len()).unwrap_or(u32::MAX))
        );
        for (session, trace, date, _) in results {
            let _ = writeln!(
                text,
                "  {}  {}  {} of {} steps, {} typed messages",
                palette.dim(date),
                palette.bold(&session.id[..session.id.len().min(8)]),
                trace.steps.len(),
                trace.total_steps,
                session.human_messages
            );
        }
        let _ = writeln!(
            text,
            "\n{}",
            palette.dim("Dry run: nothing was sent. Only redacted excerpts leave this machine, and only to Claude Code.")
        );
        return text;
    }
    for record in records {
        let _ = writeln!(
            text,
            "\n{} {}  {}",
            palette.bold(&record.session_date),
            record.session_goal,
            palette.dim(&format!(
                "{} lessons · ${:.2}",
                record.lessons.len(),
                record.cost_usd
            ))
        );
        for lesson in &record.lessons {
            let cost = match lesson.cost {
                Cost::High => palette.bad("high  "),
                Cost::Medium => palette.warn("medium"),
                Cost::Low => palette.dim("low   "),
            };
            let _ = writeln!(text, "  {cost} {}", lesson.title);
        }
    }
    let _ = writeln!(
        text,
        "\n{} distilled for ${total_cost:.2}. Saved under {}.",
        count(records.len(), "session"),
        palette.dim(&store.root().display().to_string())
    );
    let _ = writeln!(
        text,
        "Next: {} to group the lessons into skill drafts.",
        palette.command("`gandalf suggest`")
    );
    text
}

/// Options for `gandalf suggest`.
#[derive(Clone, Debug)]
pub struct SuggestOptions {
    pub dry_run: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SuggestOutput {
    dry_run: bool,
    groups: Vec<Group>,
    drafts: Vec<Draft>,
}

/// Groups stored lessons and drafts a skill for each skill-worthy group.
///
/// # Errors
///
/// Returns a CLI error when the store cannot be read, the agent fails, or
/// output cannot be written.
pub fn suggest(
    output: Output,
    home: &Path,
    project_root: &Path,
    options: &SuggestOptions,
) -> Result<(), CliError> {
    let palette = Palette::stdout();
    let store = Store::open(home, project_root)?;
    let lessons = store.lessons()?;
    if lessons.is_empty() {
        if output == Output::Json {
            return json(&SuggestOutput {
                dry_run: options.dry_run,
                groups: Vec::new(),
                drafts: Vec::new(),
            });
        }
        return write_out(&format!(
            "No lessons yet. Run {} first.\n",
            palette.command("`gandalf distill`")
        ));
    }
    let agent = ClaudeCode::default();
    let project_name = project_name(project_root);
    let (grouping, mut usage) = group_lessons(&agent, &project_name, &lessons)?;

    let mut drafts = Vec::new();
    if !options.dry_run {
        for group in grouping
            .groups
            .iter()
            .filter(|group| group.destination == Destination::Skill)
        {
            let (draft, cost) = draft_skill(&agent, &project_name, group, &lessons)?;
            usage.cost_usd += cost.cost_usd;
            write_draft(&store.drafts_dir(), &draft)?;
            drafts.push(draft);
        }
    }

    if output == Output::Json {
        return json(&SuggestOutput {
            dry_run: options.dry_run,
            groups: grouping.groups,
            drafts,
        });
    }
    write_out(&render_suggest(
        palette,
        &grouping.groups,
        &lessons,
        &drafts,
        &store,
        usage.cost_usd,
        options,
    ))
}

fn render_suggest(
    palette: Palette,
    groups: &[Group],
    lessons: &[StoredLesson],
    drafts: &[Draft],
    store: &Store,
    cost: f64,
    options: &SuggestOptions,
) -> String {
    let mut text = String::new();
    let _ = writeln!(
        text,
        "{} from {} grouped into {}:\n",
        count(lessons.len(), "lesson"),
        count(
            lessons
                .iter()
                .map(|lesson| lesson.session_id.as_str())
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            "session"
        ),
        count(groups.len(), "group")
    );
    for group in groups {
        let label = match group.destination {
            Destination::Skill => palette.good("skill  "),
            Destination::AlwaysOnInstruction => palette.warn("rule   "),
            Destination::Discard => palette.dim("dropped"),
        };
        let unique = group.lesson_ids.len() - group.duplicate_ids_merged.len();
        let _ = writeln!(
            text,
            "  {label} {}  {}",
            palette.bold(&group.name),
            palette.dim(&format!(
                "{} · {} · {}",
                count(unique, "lesson"),
                count(group.independent_sessions, "session"),
                scope_label(group)
            ))
        );
        let _ = writeln!(text, "          {}", palette.dim(&group.when_it_applies));
        if group.destination == Destination::AlwaysOnInstruction {
            for id in &group.lesson_ids {
                if group.duplicate_ids_merged.contains(id) {
                    continue;
                }
                if let Some(stored) = id.checked_sub(1).and_then(|i| lessons.get(i)) {
                    let _ = writeln!(text, "          - {}", stored.lesson.lesson);
                }
            }
        }
    }
    if options.dry_run {
        let _ = writeln!(
            text,
            "\n{}",
            palette.dim("Dry run: no drafts were written.")
        );
        return text;
    }
    if drafts.is_empty() {
        let _ = writeln!(text, "\nNo group was worth a skill.");
        return text;
    }
    let _ = writeln!(
        text,
        "\n{} written to {}:",
        count(drafts.len(), "skill draft"),
        palette.dim(&store.drafts_dir().display().to_string())
    );
    for draft in drafts {
        let _ = writeln!(text, "  {}", palette.bold(&draft.name));
    }
    let _ = writeln!(
        text,
        "\nRead a draft, edit it if you like, then install it with\n  {}\nRules belong in CLAUDE.md or AGENTS.md; copy them by hand.\n{}",
        palette.command(&format!(
            "gandalf skill add {}/<name> --scope project",
            store.drafts_dir().display()
        )),
        palette.dim(&format!(
            "This run cost about ${cost:.2} on your Claude Code subscription."
        ))
    );
    text
}

fn scope_label(group: &Group) -> &'static str {
    match group.scope {
        gandalf_distill::GroupScope::ThisRepo => "this repo",
        gandalf_distill::GroupScope::UserAllRepos => "you, everywhere",
        gandalf_distill::GroupScope::ThisMachine => "this machine",
    }
}

fn project_name(project_root: &Path) -> String {
    project_root.file_name().map_or_else(
        || "project".to_owned(),
        |n| n.to_string_lossy().into_owned(),
    )
}

fn date_of(session: &Session) -> String {
    OffsetDateTime::from(session.modified)
        .format(format_description!("[year]-[month]-[day]"))
        .unwrap_or_else(|_| "unknown".to_owned())
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn count(number: usize, noun: &str) -> String {
    crate::commands::style::count(number, noun)
}

fn json<T: Serialize>(value: &T) -> Result<(), CliError> {
    let mut encoded = serde_json::to_string_pretty(value).map_err(|_| CliError::Output)?;
    encoded.push('\n');
    write_out(&encoded)
}

fn write_out(text: &str) -> Result<(), CliError> {
    io::stdout()
        .lock()
        .write_all(text.as_bytes())
        .map_err(|_| CliError::Output)
}

impl From<DistillError> for CliError {
    fn from(error: DistillError) -> Self {
        Self::Distill(error)
    }
}

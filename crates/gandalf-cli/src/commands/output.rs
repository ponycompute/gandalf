//! Bounded, non-authoritative CLI rendering for application DTOs.

use std::io::{self, Write};

use gandalf_core::{
    WorkStatus,
    api::{AppResponse, EvidenceView, SessionHit, TurnRole, WorkDetail, WorkSummary},
};

use crate::{CliError, args::Output, commands::style::Palette};

const MAX_RENDERED_FIELD_BYTES: usize = 4 * 1024;

/// Writes one already-scoped application response without exposing transport
/// details, database paths, or raw evidence by default.
///
/// # Errors
///
/// Returns a stable CLI error when stdout cannot accept a bounded response.
pub fn response(output: Output, value: AppResponse) -> Result<(), CliError> {
    match output {
        Output::Json => {
            let encoded = serde_json::to_vec(&value).map_err(|_| CliError::Output)?;
            write_all(&encoded)?;
            write_all(b"\n")
        }
        Output::Text => text_response(value),
    }
}

fn text_response(value: AppResponse) -> Result<(), CliError> {
    let palette = Palette::stdout();
    match value {
        AppResponse::WorkList(page) => {
            if page.items.is_empty() {
                line("No tracked work in this project yet.")?;
                return line(&palette.dim(
                    "Work appears here once a connected agent starts a session. Check agents with `gandalf agent list`.",
                ));
            }
            for work in &page.items {
                summary(palette, work)?;
            }
            if page.truncated {
                line(&palette.dim("More work exists than is shown here."))?;
            }
            Ok(())
        }
        AppResponse::Search(page) => {
            if page.items.is_empty() {
                return line("No tracked work matches that search.");
            }
            for hit in &page.items {
                summary(palette, &hit.work)?;
            }
            if page.truncated {
                line(
                    &palette
                        .dim("More results exist than are shown here; raise --limit to see them."),
                )?;
            }
            Ok(())
        }
        AppResponse::SessionSearch(page) => {
            if page.items.is_empty() {
                line("No session in this project matches that search.")?;
                return line(&palette.dim(
                    "Sessions are indexed by the background service. Check it with `gandalf status`.",
                ));
            }
            for hit in &page.items {
                session_hit(palette, hit)?;
            }
            if page.truncated {
                line(
                    &palette
                        .dim("More results exist than are shown here; raise --limit to see them."),
                )?;
            }
            Ok(())
        }
        AppResponse::Work(work) => detail(palette, &work),
        AppResponse::Evidence(view) => evidence(&view),
        AppResponse::Health(health) => line(&if health.ready {
            format!("{} daemon: ready", palette.good("✓"))
        } else {
            format!("{} daemon: unavailable", palette.bad("✗"))
        }),
        AppResponse::Accepted => line(&format!("{} Done.", palette.good("✓"))),
        AppResponse::NotFound => line("Nothing with that id exists in this project."),
    }
}

/// Lowercase status word shared by every text view.
#[must_use]
pub const fn status_label(status: WorkStatus) -> &'static str {
    match status {
        WorkStatus::Observed => "observed",
        WorkStatus::Active => "active",
        WorkStatus::Blocked => "blocked",
        WorkStatus::Completed => "completed",
        WorkStatus::Abandoned => "abandoned",
    }
}

fn styled_status(palette: Palette, status: WorkStatus) -> String {
    let label = status_label(status);
    match status {
        WorkStatus::Active => palette.good(label),
        WorkStatus::Blocked => palette.bad(label),
        WorkStatus::Observed => palette.warn(label),
        WorkStatus::Completed | WorkStatus::Abandoned => palette.dim(label),
    }
}

fn summary(palette: Palette, work: &WorkSummary) -> Result<(), CliError> {
    line(&format!(
        "{}  {}  {}\n  {}",
        palette.bold(work.work_id.as_str()),
        styled_status(palette, work.status),
        palette.dim(&format!("r{}", work.revision)),
        safe(&work.summary)
    ))
}

fn session_hit(palette: Palette, hit: &SessionHit) -> Result<(), CliError> {
    // RFC 3339 timestamps render as "YYYY-MM-DD HH:MM".
    let when = hit
        .occurred_at
        .get(..16)
        .unwrap_or(&hit.occurred_at)
        .replace('T', " ");
    let role = match hit.role {
        TurnRole::Error => palette.bad(hit.role.as_str()),
        TurnRole::User => palette.good(hit.role.as_str()),
        TurnRole::Agent | TurnRole::Command | TurnRole::Edit => palette.dim(hit.role.as_str()),
    };
    let snippet = safe(&hit.snippet.replace('\n', " "));
    line(&format!(
        "{}  {}  {}  {}\n  {}",
        palette.dim(&when),
        palette.bold(hit.provider.as_str()),
        palette.dim(hit.session_id.as_str()),
        role,
        highlight(palette, &snippet),
    ))
}

/// Bolds the terms the index marked with `[` `]` in a snippet.
fn highlight(palette: Palette, snippet: &str) -> String {
    let mut rendered = String::with_capacity(snippet.len());
    let mut rest = snippet;
    while let Some(start) = rest.find('[') {
        let Some(length) = rest[start..].find(']') else {
            break;
        };
        rendered.push_str(&rest[..start]);
        rendered.push_str(&palette.bold(&rest[start + 1..start + length]));
        rest = &rest[start + length + 1..];
    }
    rendered.push_str(rest);
    rendered
}

fn detail(palette: Palette, work: &WorkDetail) -> Result<(), CliError> {
    line(&format!(
        "{}  {}  {}",
        palette.bold(work.work_id.as_str()),
        styled_status(palette, work.status),
        palette.dim(&format!("revision {}", work.revision)),
    ))?;
    line("")?;
    line(&palette.bold("Objective:"))?;
    line(&format!(
        "  {}",
        work.objective
            .as_deref()
            .map_or_else(|| palette.dim("unknown"), safe)
    ))?;
    section(palette, "Completed", &work.completed_steps)?;
    section(palette, "Next actions", &work.next_actions)?;
    section(palette, "Blockers", &work.blockers)?;
    section(palette, "Artifacts", &work.artifacts)?;
    section(palette, "Verification", &work.verification)
}

fn section(palette: Palette, label: &str, values: &[String]) -> Result<(), CliError> {
    line(&palette.bold(&format!("{label}:")))?;
    if values.is_empty() {
        return line(&palette.dim("  - none"));
    }
    for value in values {
        line(&format!("  - {}", safe(value)))?;
    }
    Ok(())
}

fn evidence(value: &EvidenceView) -> Result<(), CliError> {
    line("----- BEGIN UNTRUSTED EVIDENCE DATA -----")?;
    if let Some(raw) = &value.raw {
        let bounded = &raw[..raw.len().min(MAX_RENDERED_FIELD_BYTES)];
        line(&safe(&String::from_utf8_lossy(bounded)))?;
        if raw.len() > bounded.len() {
            line("[truncated]")?;
        }
    } else {
        line(&safe(&value.redacted_preview))?;
    }
    line("----- END UNTRUSTED EVIDENCE DATA -----")
}

fn safe(value: &str) -> String {
    let end = value
        .char_indices()
        .nth(MAX_RENDERED_FIELD_BYTES)
        .map_or(value.len(), |(index, _)| index);
    let mut bounded = value[..end].to_owned();
    if end < value.len() {
        bounded.push('…');
    }
    // DTOs do not contain source-path fields. This guards the remaining
    // free-text rendering boundary against an accidental absolute path.
    for marker in ["/Users/", "/home/", "/private/", "/tmp/"] {
        while let Some(start) = bounded.find(marker) {
            let tail = &bounded[start..];
            let length = tail.find(char::is_whitespace).unwrap_or(tail.len());
            bounded.replace_range(start..start + length, "[redacted path]");
        }
    }
    bounded
}

fn line(value: &str) -> Result<(), CliError> {
    write_all(value.as_bytes())?;
    write_all(b"\n")
}

fn write_all(bytes: &[u8]) -> Result<(), CliError> {
    io::stdout()
        .lock()
        .write_all(bytes)
        .map_err(|_| CliError::Output)
}

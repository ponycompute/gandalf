//! Compresses one session into a short trajectory a model can learn from.
//!
//! The trace keeps what a later step needs: what the user asked and
//! corrected, what the agent ran, what failed and with what error, and which
//! files changed. Reads, searches, and other routine successes are collapsed
//! so the trace fits in a few thousand tokens, and the step right after a
//! failure is always kept because it shows how the failure was resolved.
//! Paths, URLs, email addresses, long tokens, and `key=value` secrets are
//! redacted before anything leaves the machine.

use std::{collections::BTreeMap, fmt::Write as _, fs, path::Path};

use serde::Serialize;
use serde_json::Value;

use crate::{DistillError, sessions::Tool};

/// What one step of the trajectory was.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Human,
    Agent,
    RunOk,
    RunFailed,
    Change,
    ChangeFailed,
    ToolOk,
    ToolFailed,
}

impl Kind {
    const fn label(self) -> &'static str {
        match self {
            Self::Human => "HUMAN",
            Self::Agent => "AGENT",
            Self::RunOk => "RUN ok",
            Self::RunFailed => "RUN FAILED",
            Self::Change => "CHANGE",
            Self::ChangeFailed => "CHANGE FAILED",
            Self::ToolOk => "TOOL ok",
            Self::ToolFailed => "TOOL FAILED",
        }
    }

    /// Lower keeps first when the trace must be cut to fit a budget.
    const fn priority(self) -> u8 {
        match self {
            Self::Human | Self::RunFailed | Self::ChangeFailed | Self::ToolFailed => 0,
            Self::RunOk | Self::Change => 2,
            Self::Agent => 3,
            Self::ToolOk => 4,
        }
    }
}

/// One numbered step of a trace.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Step {
    pub number: usize,
    pub kind: Kind,
    pub text: String,
}

/// The compressed trajectory of one session.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Trace {
    pub steps: Vec<Step>,
    /// Steps before collapsing and cutting, so provenance can say "step 112
    /// of 459".
    pub total_steps: usize,
}

impl Trace {
    /// Renders the trace as numbered lines for a prompt.
    #[must_use]
    pub fn render(&self) -> String {
        let mut text = String::new();
        for step in &self.steps {
            let _ = writeln!(
                text,
                "[{}] {}: {}",
                step.number,
                step.kind.label(),
                step.text
            );
        }
        text
    }

    #[must_use]
    pub fn count(&self, kind: Kind) -> usize {
        self.steps.iter().filter(|step| step.kind == kind).count()
    }
}

const HUMAN_LIMIT: usize = 420;
const AGENT_LIMIT: usize = 200;
const COMMAND_LIMIT: usize = 150;
const ERROR_LIMIT: usize = 200;

/// Builds the trace of the Claude Code session at `path`, cut to about
/// `max_chars` of rendered text.
///
/// # Errors
///
/// Returns [`DistillError::UnreadableSession`] when the file cannot be read.
pub fn build_trace(path: &Path, max_chars: usize) -> Result<Trace, DistillError> {
    let text = fs::read_to_string(path)
        .map_err(|_| DistillError::UnreadableSession(path.to_path_buf()))?;
    Ok(build_trace_from_text(&text, max_chars))
}

/// Builds the trace of the session at `path` in `tool`'s format.
///
/// # Errors
///
/// Returns [`DistillError::UnreadableSession`] when the file cannot be read.
pub fn build_trace_for(tool: Tool, path: &Path, max_chars: usize) -> Result<Trace, DistillError> {
    let text = fs::read_to_string(path)
        .map_err(|_| DistillError::UnreadableSession(path.to_path_buf()))?;
    Ok(match tool {
        Tool::ClaudeCode => build_trace_from_text(&text, max_chars),
        Tool::Codex => build_trace_from_codex_text(&text, max_chars),
    })
}

/// Builds a trace from the JSONL text of a Claude Code session.
#[must_use]
pub fn build_trace_from_text(text: &str, max_chars: usize) -> Trace {
    let mut raw = Vec::new();
    let mut calls: BTreeMap<String, (String, Value)> = BTreeMap::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record["isSidechain"] == true || record["isMeta"] == true {
            continue;
        }
        let role = record["message"]["role"].as_str().unwrap_or_default();
        let blocks: Vec<Value> = match &record["message"]["content"] {
            Value::String(text) => vec![serde_json::json!({"type": "text", "text": text})],
            Value::Array(blocks) => blocks.clone(),
            _ => continue,
        };
        for block in blocks {
            collect_step(&block, role, &mut calls, &mut raw);
        }
    }
    let total_steps = raw.len();
    let collapsed = collapse(raw);
    let steps = fit(collapsed, max_chars);
    Trace { steps, total_steps }
}

struct RawStep {
    kind: Kind,
    text: String,
    priority: u8,
}

fn collect_step(
    block: &Value,
    role: &str,
    calls: &mut BTreeMap<String, (String, Value)>,
    out: &mut Vec<RawStep>,
) {
    match block["type"].as_str().unwrap_or_default() {
        "text" => {
            let text = block["text"].as_str().unwrap_or_default().trim();
            if text.is_empty() {
                return;
            }
            if role == "user" {
                if text.contains("[Request interrupted by user") {
                    out.push(step(Kind::Human, "(interrupted the agent)".to_owned()));
                } else if is_typed_by_user(text) {
                    out.push(step(Kind::Human, redact(text, HUMAN_LIMIT)));
                }
            } else if role == "assistant" {
                out.push(step(Kind::Agent, redact(text, AGENT_LIMIT)));
            }
        }
        "tool_use" => {
            let id = block["id"].as_str().unwrap_or_default().to_owned();
            let name = block["name"].as_str().unwrap_or("?").to_owned();
            calls.insert(id, (name, block["input"].clone()));
        }
        "tool_result" => {
            let id = block["tool_use_id"].as_str().unwrap_or_default();
            let Some((tool, input)) = calls.get(id) else {
                return;
            };
            let failed = block["is_error"] == true;
            let output = match &block["content"] {
                Value::String(text) => text.clone(),
                Value::Array(parts) => parts
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            };
            out.push(tool_step(tool, input, failed, &output));
        }
        _ => {}
    }
}

fn tool_step(tool: &str, input: &Value, failed: bool, output: &str) -> RawStep {
    match tool {
        "Bash" => {
            let command = redact(input["command"].as_str().unwrap_or_default(), COMMAND_LIMIT);
            if failed {
                step(
                    Kind::RunFailed,
                    format!("{command}  => {}", redact(output, ERROR_LIMIT)),
                )
            } else {
                step(Kind::RunOk, command)
            }
        }
        "Edit" | "Write" | "NotebookEdit" | "MultiEdit" => {
            let file = Path::new(input["file_path"].as_str().unwrap_or("?"))
                .file_name()
                .map_or_else(
                    || "?".to_owned(),
                    |name| name.to_string_lossy().into_owned(),
                );
            if failed {
                step(Kind::ChangeFailed, file)
            } else {
                step(Kind::Change, file)
            }
        }
        _ => {
            let short = tool.rsplit("__").next().unwrap_or(tool);
            if failed {
                step(
                    Kind::ToolFailed,
                    format!("{short}  => {}", redact(output, 160)),
                )
            } else {
                step(Kind::ToolOk, short.to_owned())
            }
        }
    }
}

fn step(kind: Kind, text: String) -> RawStep {
    RawStep {
        kind,
        text,
        priority: kind.priority(),
    }
}

/// Drops context the harness injects into the user turn: XML-tagged system
/// context, command caveats, continuation summaries, instruction files, and
/// attachment paths.
#[must_use]
pub fn is_typed_by_user(text: &str) -> bool {
    let head: String = text.trim_start().chars().take(40).collect();
    !(head.is_empty()
        || head.starts_with('<')
        || head.starts_with('/')
        || head.starts_with("Caveat:")
        || head.starts_with("[SYSTEM")
        || head.starts_with("# AGENTS.md")
        || head.starts_with("This session is being continued"))
}

/// Joins the text parts of a Codex message content array.
#[must_use]
pub fn codex_text(content: &Value) -> String {
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|part| matches!(part["type"].as_str(), Some("input_text" | "output_text")))
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// Builds a trace from the JSONL text of a Codex rollout.
#[must_use]
pub fn build_trace_from_codex_text(text: &str, max_chars: usize) -> Trace {
    let mut raw = Vec::new();
    let mut calls: BTreeMap<String, (String, String)> = BTreeMap::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &record["payload"];
        match record["type"].as_str().unwrap_or_default() {
            "event_msg" if payload["type"] == "turn_aborted" => {
                raw.push(step(Kind::Human, "(interrupted the agent)".to_owned()));
            }
            "response_item" => collect_codex_step(payload, &mut calls, &mut raw),
            _ => {}
        }
    }
    let total_steps = raw.len();
    let collapsed = collapse(raw);
    let steps = fit(collapsed, max_chars);
    Trace { steps, total_steps }
}

fn collect_codex_step(
    payload: &Value,
    calls: &mut BTreeMap<String, (String, String)>,
    out: &mut Vec<RawStep>,
) {
    match payload["type"].as_str().unwrap_or_default() {
        "message" => {
            let text = codex_text(&payload["content"]);
            match payload["role"].as_str() {
                Some("user") if is_typed_by_user(&text) => {
                    out.push(step(Kind::Human, redact(&text, HUMAN_LIMIT)));
                }
                Some("assistant") if !text.is_empty() => {
                    out.push(step(Kind::Agent, redact(&text, AGENT_LIMIT)));
                }
                _ => {}
            }
        }
        "custom_tool_call" | "function_call" => {
            let call_id = payload["call_id"].as_str().unwrap_or_default().to_owned();
            let name = payload["name"].as_str().unwrap_or("?");
            let detail = match name {
                "exec" => codex_cmd(payload["input"].as_str().unwrap_or_default()),
                "exec_command" => codex_cmd(payload["arguments"].as_str().unwrap_or_default()),
                "apply_patch" => patched_file(payload["input"].as_str().unwrap_or_default()),
                _ => String::new(),
            };
            calls.insert(call_id, (name.to_owned(), detail));
        }
        "custom_tool_call_output" | "function_call_output" => {
            let call_id = payload["call_id"].as_str().unwrap_or_default();
            let Some((name, detail)) = calls.get(call_id) else {
                return;
            };
            let output = match &payload["output"] {
                Value::String(text) => text.clone(),
                other => codex_text(other),
            };
            let failed = codex_failed(&output);
            match name.as_str() {
                "exec" | "exec_command" => {
                    let command = redact(detail, COMMAND_LIMIT);
                    if failed {
                        out.push(step(
                            Kind::RunFailed,
                            format!(
                                "{command}  => {}",
                                redact(&codex_result(&output), ERROR_LIMIT)
                            ),
                        ));
                    } else {
                        out.push(step(Kind::RunOk, command));
                    }
                }
                "apply_patch" => out.push(step(
                    if failed {
                        Kind::ChangeFailed
                    } else {
                        Kind::Change
                    },
                    detail.clone(),
                )),
                other => {
                    if failed {
                        out.push(step(
                            Kind::ToolFailed,
                            format!("{other}  => {}", redact(&codex_result(&output), 160)),
                        ));
                    } else {
                        out.push(step(Kind::ToolOk, other.to_owned()));
                    }
                }
            }
        }
        _ => {}
    }
}

/// Pulls the shell command out of Codex's `tools.exec_command({"cmd": ...})`
/// script or an `exec_command` arguments object.
fn codex_cmd(source: &str) -> String {
    if let Ok(arguments) = serde_json::from_str::<Value>(source)
        && let Some(cmd) = arguments["cmd"].as_str()
    {
        return cmd.to_owned();
    }
    let Some(start) = source.find("\"cmd\":") else {
        return source.trim().to_owned();
    };
    let rest = &source[start + 6..];
    let rest = rest.trim_start();
    let Some(rest) = rest.strip_prefix('"') else {
        return source.trim().to_owned();
    };
    let mut cmd = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next() {
                    cmd.push(match next {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                }
            }
            '"' => break,
            other => cmd.push(other),
        }
    }
    cmd
}

fn patched_file(patch: &str) -> String {
    patch
        .lines()
        .find_map(|line| {
            line.strip_prefix("*** Update File: ")
                .or_else(|| line.strip_prefix("*** Add File: "))
                .or_else(|| line.strip_prefix("*** Delete File: "))
        })
        .map_or_else(
            || "patch".to_owned(),
            |path| {
                Path::new(path.trim()).file_name().map_or_else(
                    || "?".to_owned(),
                    |name| name.to_string_lossy().into_owned(),
                )
            },
        )
}

/// Codex reports a command's outcome inside the output text.
fn codex_failed(output: &str) -> bool {
    let head: String = output.chars().take(600).collect();
    for marker in [
        "\"exit_code\":",
        "Process exited with code ",
        "process exited with code ",
        "Exit code: ",
    ] {
        if let Some(index) = head.find(marker) {
            let digits: String = head[index + marker.len()..]
                .chars()
                .skip_while(|c| *c == ' ')
                .take_while(char::is_ascii_digit)
                .collect();
            return digits != "0" && !digits.is_empty();
        }
    }
    false
}

/// The useful part of a Codex command result: after the wall-time banner.
fn codex_result(output: &str) -> String {
    output
        .split_once("Output:")
        .map_or(output, |(_, rest)| rest)
        .trim()
        .to_owned()
}

/// Keeps the two steps after each failure, then merges runs of routine
/// successes into one line with counts. Returns each step with its priority.
fn collapse(mut raw: Vec<RawStep>) -> Vec<(Step, u8)> {
    let failures: Vec<usize> = raw
        .iter()
        .enumerate()
        .filter(|(_, step)| {
            matches!(
                step.kind,
                Kind::RunFailed | Kind::ChangeFailed | Kind::ToolFailed
            )
        })
        .map(|(index, _)| index)
        .collect();
    for index in failures {
        for follow in raw.iter_mut().skip(index + 1).take(2) {
            follow.priority = follow.priority.min(1);
        }
    }

    let mut out: Vec<(Step, u8)> = Vec::new();
    let mut run: Option<(Kind, Vec<String>, u8)> = None;
    for raw_step in raw {
        if matches!(raw_step.kind, Kind::ToolOk | Kind::Change) {
            if let Some((kind, items, priority)) = &mut run
                && *kind == raw_step.kind
            {
                items.push(raw_step.text);
                *priority = (*priority).min(raw_step.priority);
                continue;
            }
            flush_run(&mut run, &mut out);
            run = Some((raw_step.kind, vec![raw_step.text], raw_step.priority));
            continue;
        }
        flush_run(&mut run, &mut out);
        push_step(&mut out, raw_step.kind, raw_step.text, raw_step.priority);
    }
    flush_run(&mut run, &mut out);
    out
}

fn flush_run(run: &mut Option<(Kind, Vec<String>, u8)>, out: &mut Vec<(Step, u8)>) {
    let Some((kind, items, priority)) = run.take() else {
        return;
    };
    let mut counts: Vec<(String, usize)> = Vec::new();
    for item in items {
        match counts.iter_mut().find(|(name, _)| *name == item) {
            Some((_, count)) => *count += 1,
            None => counts.push((item, 1)),
        }
    }
    let text = counts
        .iter()
        .take(8)
        .map(|(name, count)| {
            if *count > 1 {
                format!("{name} x{count}")
            } else {
                name.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    push_step(out, kind, text, priority);
}

fn push_step(out: &mut Vec<(Step, u8)>, kind: Kind, text: String, priority: u8) {
    let number = out.len() + 1;
    out.push((Step { number, kind, text }, priority));
}

/// Fills the character budget in priority order, then restores session
/// order.
fn fit(steps: Vec<(Step, u8)>, max_chars: usize) -> Vec<Step> {
    let mut indexed: Vec<(usize, Step, u8)> = steps
        .into_iter()
        .enumerate()
        .map(|(index, (step, priority))| (index, step, priority))
        .collect();
    indexed.sort_by_key(|(index, _, priority)| (*priority, *index));
    let mut budget = max_chars;
    let mut chosen = Vec::new();
    for (index, step, _) in indexed {
        let cost = step.kind.label().len() + step.text.len() + 12;
        if cost <= budget {
            budget -= cost;
            chosen.push((index, step));
        }
    }
    chosen.sort_by_key(|(index, _)| *index);
    chosen.into_iter().map(|(_, step)| step).collect()
}

/// Redacts paths, URLs, email addresses, long opaque tokens, and secret-like
/// assignments, collapses whitespace, and truncates to `limit` characters.
#[must_use]
pub fn redact(text: &str, limit: usize) -> String {
    let mut out = String::with_capacity(text.len());
    for raw_word in text.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&redact_word(raw_word));
    }
    let count = out.chars().count();
    if count <= limit {
        return out;
    }
    let cut: String = out.chars().take(limit.saturating_sub(1)).collect();
    format!("{cut}…")
}

fn redact_word(word: &str) -> String {
    let lower = word.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return "[url]".to_owned();
    }
    if let Some(index) = word.find('@')
        && index > 0
        && word[index + 1..].contains('.')
    {
        return "[email]".to_owned();
    }
    for prefix in [
        "~/",
        "/Users/",
        "/home/",
        "/private/",
        "/tmp/",
        "/var/",
        "/opt/",
        "/etc/",
    ] {
        if let Some(index) = word.find(prefix) {
            let mut kept: String = word[..index].to_owned();
            kept.push_str("[path]");
            if let Some(tail) = word[index..].find(['\'', '"', '`', ')', ']', ',', ';']) {
                kept.push_str(&word[index + tail..]);
            }
            return kept;
        }
    }
    for key in ["key", "token", "secret", "password", "passwd", "bearer"] {
        if let Some(rest) = lower.strip_prefix(key)
            && let Some(sep) = rest.chars().next()
            && matches!(sep, '=' | ':')
        {
            return format!("{}{sep}[redacted]", &word[..key.len()]);
        }
    }
    let opaque = word.len() >= 28
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    if opaque {
        return "[token]".to_owned();
    }
    word.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::needless_pass_by_value)]
    fn record(role: &str, content: Value) -> String {
        serde_json::json!({"type": role, "message": {"role": role, "content": content}}).to_string()
    }

    #[test]
    fn trace_keeps_user_turns_and_failures_and_collapses_routine_work() {
        let lines = [
            record(
                "user",
                Value::String("<system-reminder>injected</system-reminder>".into()),
            ),
            record("user", Value::String("fix the build".into())),
            record(
                "assistant",
                serde_json::json!([
                    {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/Users/a/x.rs"}},
                    {"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "/Users/a/y.rs"}},
                    {"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "cargo build"}},
                    {"type": "tool_use", "id": "t4", "name": "Bash", "input": {"command": "cargo build --release"}}
                ]),
            ),
            record(
                "user",
                serde_json::json!([
                    {"type": "tool_result", "tool_use_id": "t1", "content": "..."},
                    {"type": "tool_result", "tool_use_id": "t2", "content": "..."},
                    {"type": "tool_result", "tool_use_id": "t3", "is_error": true, "content": "error: linker failed at /Users/a/proj"},
                    {"type": "tool_result", "tool_use_id": "t4", "content": "ok"}
                ]),
            ),
            record(
                "assistant",
                serde_json::json!([{"type": "text", "text": "Done, see https://example.com/x"}]),
            ),
        ];
        let trace = build_trace_from_text(&lines.join("\n"), 10_000);
        let rendered = trace.render();
        assert!(rendered.contains("[1] HUMAN: fix the build"), "{rendered}");
        assert!(!rendered.contains("injected"));
        assert!(rendered.contains("TOOL ok: Read x2"), "{rendered}");
        assert!(rendered.contains("RUN FAILED: cargo build  => error: linker failed at [path]"));
        assert!(rendered.contains("RUN ok: cargo build --release"));
        assert!(rendered.contains("AGENT: Done, see [url]"));
        assert_eq!(trace.total_steps, 6, "injected context is not a step");
    }

    #[test]
    fn fit_drops_low_priority_steps_first_and_keeps_order() {
        let mut lines = vec![record("user", Value::String("start".into()))];
        for i in 0..200 {
            lines.push(record(
                "assistant",
                serde_json::json!([{"type": "text", "text": format!("thinking aloud number {i}")}]),
            ));
        }
        lines.push(record(
            "user",
            Value::String("the important correction".into()),
        ));
        let trace = build_trace_from_text(&lines.join("\n"), 600);
        let rendered = trace.render();
        assert!(rendered.len() <= 700, "{}", rendered.len());
        assert!(rendered.contains("start"));
        assert!(rendered.contains("the important correction"));
        let numbers: Vec<usize> = trace.steps.iter().map(|step| step.number).collect();
        assert!(numbers.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn codex_trace_reads_messages_commands_and_exit_codes() {
        let lines = [
            serde_json::json!({"type":"session_meta","payload":{"id":"s","cwd":"/p"}}).to_string(),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n..."}]}}).to_string(),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"run the tests"}]}}).to_string(),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1","input":"const r = await tools.exec_command({\"cmd\":\"cargo test\",\"yield_time_ms\":1});"}}).to_string(),
            serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":[{"type":"input_text","text":"Script completed\nWall time 1.0 seconds\nOutput:\n--- RESULT 1 ---\n{\"exit_code\":101,\"stdout\":\"test failed at /Users/a/x\"}"}]}}).to_string(),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"c2","arguments":"{\"cmd\":\"cargo test --lib\"}"}}).to_string(),
            serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c2","output":"Process exited with code 0\nok"}}).to_string(),
            serde_json::json!({"type":"event_msg","payload":{"type":"turn_aborted"}}).to_string(),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixed."}]}}).to_string(),
        ];
        let rendered = build_trace_from_codex_text(&lines.join("\n"), 10_000).render();
        assert!(rendered.contains("[1] HUMAN: run the tests"), "{rendered}");
        assert!(!rendered.contains("AGENTS.md"));
        assert!(
            rendered.contains("RUN FAILED: cargo test  => --- RESULT 1 ---"),
            "{rendered}"
        );
        assert!(rendered.contains("[path]"));
        assert!(rendered.contains("RUN ok: cargo test --lib"), "{rendered}");
        assert!(rendered.contains("HUMAN: (interrupted the agent)"));
        assert!(rendered.contains("AGENT: Fixed."));
    }

    #[test]
    fn redaction_covers_paths_urls_emails_tokens_and_secrets() {
        assert_eq!(redact("see /Users/alice/x.rs now", 100), "see [path] now");
        assert_eq!(redact("open https://example.com/a?b=c", 100), "open [url]");
        assert_eq!(redact("mail alice@example.com", 100), "mail [email]");
        assert_eq!(redact("TOKEN=abc", 100), "TOKEN=[redacted]");
        assert_eq!(
            redact("id abcdefghijklmnopqrstuvwxyz0123", 100),
            "id [token]"
        );
        assert_eq!(redact("cat '/tmp/x/y.txt'", 100), "cat '[path]'");
        assert_eq!(redact("a b c d e", 4), "a b…");
    }
}

//! Runs the user's own coding agent non-interactively to do the thinking.
//!
//! Gandalf provides no model of its own. Each step hands a prompt and a JSON
//! schema to the agent the session came from, so session excerpts never
//! reach a provider that did not already have them, and the user's existing
//! subscription pays for the call. Every run is told not to persist a
//! session and is given no tools, so it cannot read, write, or be recorded
//! as a new session that would be distilled in turn.

use std::{
    io::Write,
    process::{Command, Stdio},
    sync::Mutex,
};

use serde_json::Value;

use crate::DistillError;

/// One structured completion request.
#[derive(Clone, Debug)]
pub struct CompletionRequest<'a> {
    pub system: &'a str,
    pub prompt: &'a str,
    /// A JSON Schema the agent must satisfy.
    pub schema: &'a str,
}

/// What one run cost, as reported by the agent.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    pub cost_usd: f64,
    pub duration_ms: u64,
}

/// A coding agent that can answer a structured request.
pub trait Agent {
    fn name(&self) -> &'static str;

    /// Returns the structured output plus what the call cost.
    ///
    /// # Errors
    ///
    /// Returns an error when the agent is unavailable, fails, or does not
    /// return the requested structure.
    fn complete(&self, request: &CompletionRequest<'_>) -> Result<(Value, Usage), DistillError>;
}

/// Claude Code, run as `claude -p`.
#[derive(Clone, Debug, Default)]
pub struct ClaudeCode {
    /// Overrides the executable, for tests.
    pub executable: Option<String>,
}

impl Agent for ClaudeCode {
    fn name(&self) -> &'static str {
        "Claude Code"
    }

    fn complete(&self, request: &CompletionRequest<'_>) -> Result<(Value, Usage), DistillError> {
        let executable = self.executable.as_deref().unwrap_or("claude");
        let mut child = Command::new(executable)
            .args([
                "-p",
                "--no-session-persistence",
                "--tools",
                "",
                "--strict-mcp-config",
                "--disable-slash-commands",
                "--output-format",
                "json",
                "--json-schema",
                request.schema,
                "--system-prompt",
                request.system,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    DistillError::AgentUnavailable("claude")
                } else {
                    DistillError::io("start claude", error)
                }
            })?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(request.prompt.as_bytes())
                .map_err(|error| DistillError::io("write prompt to claude", error))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|error| DistillError::io("wait for claude", error))?;
        if !output.status.success() {
            return Err(DistillError::AgentFailed {
                agent: "claude",
                status: output.status.to_string(),
                stderr: String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(400)
                    .collect(),
            });
        }
        parse_claude_output(&output.stdout)
    }
}

fn parse_claude_output(stdout: &[u8]) -> Result<(Value, Usage), DistillError> {
    let envelope: Value =
        serde_json::from_slice(stdout).map_err(|error| DistillError::BadResponse {
            agent: "claude",
            detail: format!("output is not JSON: {error}"),
        })?;
    if envelope["is_error"] == true {
        return Err(DistillError::BadResponse {
            agent: "claude",
            detail: envelope["result"]
                .as_str()
                .unwrap_or("reported an error")
                .chars()
                .take(400)
                .collect(),
        });
    }
    let structured = envelope
        .get("structured_output")
        .filter(|value| !value.is_null())
        .cloned()
        .ok_or_else(|| DistillError::BadResponse {
            agent: "claude",
            detail: "no structured_output in the reply".to_owned(),
        })?;
    let usage = Usage {
        cost_usd: envelope["total_cost_usd"].as_f64().unwrap_or_default(),
        duration_ms: envelope["duration_ms"].as_u64().unwrap_or_default(),
    };
    Ok((structured, usage))
}

/// Codex, run as `codex exec`.
///
/// Codex has no system-prompt flag, so the system text is prepended to the
/// prompt. The run is ephemeral (no session file), read-only sandboxed, and
/// told in the prompt to answer without using tools. Codex does not report
/// a cost, so usage carries only the duration.
#[derive(Clone, Debug, Default)]
pub struct Codex {
    /// Overrides the executable, for tests.
    pub executable: Option<String>,
}

impl Agent for Codex {
    fn name(&self) -> &'static str {
        "Codex"
    }

    fn complete(&self, request: &CompletionRequest<'_>) -> Result<(Value, Usage), DistillError> {
        let executable = self.executable.as_deref().unwrap_or("codex");
        let workdir =
            tempfile::tempdir().map_err(|error| DistillError::io("create temp dir", error))?;
        let schema_path = workdir.path().join("schema.json");
        let answer_path = workdir.path().join("answer.json");
        std::fs::write(&schema_path, request.schema)
            .map_err(|error| DistillError::io("write schema", error))?;
        let prompt = format!(
            "{}\n\nAnswer directly from the text below without running any tool or reading any file.\n\n{}",
            request.system, request.prompt
        );
        let started = std::time::Instant::now();
        let mut command = Command::new(executable);
        command.args([
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
        ]);
        // `codex exec` may reject the account's default model; the user can
        // name one that works for non-interactive runs.
        if let Some(model) = std::env::var_os("GANDALF_CODEX_MODEL")
            && !model.is_empty()
        {
            command.arg("-m").arg(model);
        }
        let mut child = command
            .arg("-C")
            .arg(workdir.path())
            .arg("--output-schema")
            .arg(&schema_path)
            .arg("-o")
            .arg(&answer_path)
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    DistillError::AgentUnavailable("codex")
                } else {
                    DistillError::io("start codex", error)
                }
            })?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|error| DistillError::io("write prompt to codex", error))?;
        }
        let output = child
            .wait_with_output()
            .map_err(|error| DistillError::io("wait for codex", error))?;
        if !output.status.success() {
            return Err(DistillError::AgentFailed {
                agent: "codex",
                status: output.status.to_string(),
                stderr: codex_error_message(&String::from_utf8_lossy(&output.stderr)),
            });
        }
        let answer = std::fs::read(&answer_path).map_err(|_| DistillError::BadResponse {
            agent: "codex",
            detail: "no final message was written".to_owned(),
        })?;
        let value: Value =
            serde_json::from_slice(&answer).map_err(|error| DistillError::BadResponse {
                agent: "codex",
                detail: format!("final message is not the requested JSON: {error}"),
            })?;
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        Ok((
            value,
            Usage {
                cost_usd: 0.0,
                duration_ms,
            },
        ))
    }
}

/// Pulls the API error message out of Codex's noisy stderr, which also
/// logs every skill it failed to load.
fn codex_error_message(stderr: &str) -> String {
    for line in stderr.lines().rev() {
        let Some(json) = line.strip_prefix("ERROR: ") else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(json)
            && let Some(message) = value["error"]["message"].as_str()
        {
            return message.to_owned();
        }
    }
    stderr
        .lines()
        .rev()
        .find(|line| !line.contains("failed to load skill") && !line.contains("hook:"))
        .unwrap_or_default()
        .chars()
        .take(400)
        .collect()
}

/// An agent that returns canned answers, for tests.
#[derive(Debug, Default)]
pub struct FakeAgent {
    answers: Mutex<Vec<Value>>,
    pub requests: Mutex<Vec<(String, String)>>,
}

impl FakeAgent {
    #[must_use]
    pub fn new(answers: Vec<Value>) -> Self {
        Self {
            answers: Mutex::new(answers),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl Agent for FakeAgent {
    fn name(&self) -> &'static str {
        "fake agent"
    }

    fn complete(&self, request: &CompletionRequest<'_>) -> Result<(Value, Usage), DistillError> {
        if let Ok(mut requests) = self.requests.lock() {
            requests.push((request.system.to_owned(), request.prompt.to_owned()));
        }
        let answer = self
            .answers
            .lock()
            .ok()
            .and_then(|mut answers| {
                if answers.is_empty() {
                    None
                } else {
                    Some(answers.remove(0))
                }
            })
            .ok_or_else(|| DistillError::BadResponse {
                agent: "fake agent",
                detail: "no canned answer left".to_owned(),
            })?;
        Ok((answer, Usage::default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_envelope_yields_structured_output_and_usage() {
        let stdout = br#"{"is_error":false,"total_cost_usd":0.15,"duration_ms":1900,"structured_output":{"a":1}}"#;
        let (value, usage) = parse_claude_output(stdout).unwrap_or_else(|_| unreachable!());
        assert_eq!(value["a"], 1);
        assert_eq!(usage.duration_ms, 1900);
        assert!((usage.cost_usd - 0.15).abs() < f64::EPSILON);
    }

    #[test]
    fn codex_stderr_yields_the_api_message() {
        let stderr = "hook: SessionStart\nERROR codex_core: failed to load skill x\nERROR: {\"type\":\"error\",\"error\":{\"message\":\"model not supported\"}}\n";
        assert_eq!(codex_error_message(stderr), "model not supported");
    }

    #[test]
    fn claude_error_envelope_is_reported() {
        let stdout = br#"{"is_error":true,"result":"rate limited"}"#;
        assert!(matches!(
            parse_claude_output(stdout),
            Err(DistillError::BadResponse { detail, .. }) if detail == "rate limited"
        ));
    }
}

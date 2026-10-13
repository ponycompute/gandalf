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
    fn claude_error_envelope_is_reported() {
        let stdout = br#"{"is_error":true,"result":"rate limited"}"#;
        assert!(matches!(
            parse_claude_output(stdout),
            Err(DistillError::BadResponse { detail, .. }) if detail == "rate limited"
        ));
    }
}

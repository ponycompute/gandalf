#![allow(clippy::unwrap_used)]

use std::{fs, path::Path, process::Command};

fn gandalf(home: &Path, project: &Path, arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_gandalf"))
        .args(arguments)
        .env("HOME", home)
        .env_remove("NO_COLOR")
        .current_dir(project)
        .output()
        .unwrap()
}

fn record(role: &str, content: &str, uuid: &str) -> String {
    serde_json::json!({
        "type": role, "uuid": uuid,
        "message": {"role": role, "content": content}
    })
    .to_string()
}

/// A dry run must find this project's sessions, skip resumed copies and
/// short sessions, and never call the agent.
#[test]
fn distill_dry_run_lists_sessions_without_calling_an_agent() {
    let base = tempfile::tempdir().unwrap();
    let home = base.path().join("home");
    let project = base.path().join("my_app");
    fs::create_dir_all(&project).unwrap();
    let project = project.canonicalize().unwrap();
    let encoded: String = project
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let sessions = home.join(".claude/projects").join(encoded);
    fs::create_dir_all(&sessions).unwrap();

    let full = [
        record("user", "fix the build", "u1"),
        record("assistant", "on it", "a1"),
        record("user", "no, use bun not npm", "u2"),
    ]
    .join("\n");
    fs::write(sessions.join("aaaa.jsonl"), &full).unwrap();
    // A resumed copy holds the same user messages plus one more: keep the
    // larger file, drop the original.
    let resumed = format!("{full}\n{}", record("user", "and run lint", "u3"));
    fs::write(sessions.join("bbbb.jsonl"), resumed).unwrap();
    // Too short to be worth a model call.
    fs::write(sessions.join("cccc.jsonl"), record("user", "hi", "u9")).unwrap();

    let output = gandalf(&home, &project, &["distill", "--dry-run"]);
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("1 session would be sent"), "{stdout}");
    assert!(stdout.contains("bbbb"), "{stdout}");
    assert!(
        !stdout.contains("aaaa") && !stdout.contains("cccc"),
        "{stdout}"
    );
    assert!(stdout.contains("3 typed messages"), "{stdout}");
    assert!(stdout.contains("nothing was sent"), "{stdout}");

    let json = gandalf(
        &home,
        &project,
        &["--output", "json", "distill", "--dry-run"],
    );
    let value: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(value["dryRun"], true);
    assert_eq!(value["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(value["sessions"][0]["humanMessages"], 3);

    let empty = gandalf(&home, &project, &["suggest"]);
    assert!(empty.status.success());
    assert!(
        String::from_utf8(empty.stdout)
            .unwrap()
            .contains("No lessons yet")
    );
}

#[test]
fn distill_reports_a_project_without_sessions() {
    let base = tempfile::tempdir().unwrap();
    let home = base.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let output = gandalf(&home, base.path(), &["distill", "--dry-run"]);
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Nothing to distill"), "{stdout}");
}

#![allow(clippy::unwrap_used)]

use std::process::Command;

use gandalf_cli::{CliError, PlatformError};

fn gandalf(home: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_gandalf"))
        .args(args)
        .env("HOME", home)
        .env_remove("NO_COLOR")
        .output()
        .unwrap()
}

// A failure must name its real cause. Pointing every setup problem at
// `gandalf daemon start` sends the user in a circle.
#[test]
fn errors_name_their_cause_and_the_next_step() {
    assert!(
        CliError::Unavailable
            .hint()
            .unwrap()
            .contains("gandalf daemon start")
    );
    let unsafe_path = CliError::from(PlatformError::UnsafePath);
    assert!(!unsafe_path.to_string().contains("daemon"));
    assert!(unsafe_path.hint().unwrap().contains("owned by you"));
    assert!(
        CliError::InvalidProject
            .hint()
            .unwrap()
            .contains("--project-root")
    );
    assert_eq!(unsafe_path.exit_code(), 69);
    // A service that answers with a refusal is running; say so instead of
    // telling the user to start it.
    assert!(!CliError::Rejected.hint().unwrap().contains("daemon start"));
}

#[test]
fn piped_output_is_plain_and_errors_are_prefixed() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join(".claude/skills/reviewer")).unwrap();
    std::fs::write(
        home.path().join(".claude/skills/reviewer/SKILL.md"),
        "---\nname: reviewer\ndescription: Reviews\n---\nbody\n",
    )
    .unwrap();
    std::fs::create_dir_all(home.path().join(".codex")).unwrap();

    let listed = gandalf(home.path(), &["skill", "list"]);
    let stdout = String::from_utf8(listed.stdout).unwrap();
    assert!(
        !stdout.contains('\u{1b}'),
        "color leaked into a pipe: {stdout:?}"
    );
    assert!(
        stdout.contains("1 skill: 0 synced, 1 partial, 0 diverged"),
        "{stdout}"
    );

    let shown = gandalf(home.path(), &["skill", "show", "reviewer"]);
    let stdout = String::from_utf8(shown.stdout).unwrap();
    assert!(stdout.contains("~/.claude/skills/reviewer"), "{stdout}");
    assert!(
        !stdout.contains(&home.path().display().to_string()),
        "{stdout}"
    );

    let missing = gandalf(home.path(), &["skill", "show", "nope"]);
    let stderr = String::from_utf8(missing.stderr).unwrap();
    assert_eq!(missing.status.code(), Some(1));
    assert!(
        stderr.starts_with("error: skill \"nope\" is not installed"),
        "{stderr}"
    );
}

#[test]
fn every_subcommand_is_described_in_help() {
    let home = tempfile::tempdir().unwrap();
    for group in ["daemon", "agent", "work", "config", "forget", "skill"] {
        let help = gandalf(home.path(), &[group, "--help"]);
        let stdout = String::from_utf8(help.stdout).unwrap();
        let commands = stdout
            .split("Commands:\n")
            .nth(1)
            .and_then(|rest| rest.split("\n\n").next())
            .unwrap();
        for line in commands.lines() {
            assert!(
                line.split_whitespace().count() > 1,
                "`gandalf {group}` lists an undescribed command: {line:?}"
            );
        }
    }
}

#![allow(clippy::unwrap_used)]

use clap::Parser;
use gandalf_cli::args::Cli;

#[test]
fn parses_the_approved_command_groups_and_rejects_execution_verbs() {
    let cases = [
        &["gandalf"][..],
        &["gandalf", "skill", "list", "--scope", "all"][..],
        &["gandalf", "skills", "ls", "--agent", "claude-code,codex"][..],
        &["gandalf", "skill", "show", "reviewer"][..],
        &[
            "gandalf",
            "skill",
            "add",
            "./reviewer",
            "--force",
            "--dry-run",
        ][..],
        &["gandalf", "skill", "sync", "reviewer", "--from", "cursor"][..],
        &["gandalf", "skill", "rm", "reviewer", "--scope", "project"][..],
        &[
            "gandalf",
            "distill",
            "--since",
            "14",
            "--limit",
            "2",
            "--dry-run",
        ][..],
        &["gandalf", "suggest", "--dry-run"][..],
        &["gandalf", "init"][..],
        &["gandalf", "init", "--quiet"][..],
        &["gandalf", "status"][..],
        &["gandalf", "doctor"][..],
        &["gandalf", "daemon", "start"][..],
        &["gandalf", "agent", "list"][..],
        &["gandalf", "work", "current"][..],
        &["gandalf", "handoff", "work_1"][..],
        &["gandalf", "evidence", "ev_1"][..],
        &["gandalf", "search", "sqlite writer"][..],
        &["gandalf", "tui"][..],
        &[
            "gandalf",
            "mcp",
            "--provider",
            "codex",
            "--project-root",
            ".",
        ][..],
        &["gandalf", "config", "show"][..],
        &["gandalf", "forget", "project"][..],
    ];
    for argv in cases {
        assert!(Cli::try_parse_from(argv).is_ok(), "{argv:?}");
    }
    for command in ["run", "assign", "execute"] {
        assert!(Cli::try_parse_from(["gandalf", command]).is_err());
    }
    for argv in [
        &["gandalf", "skill", "list", "--agent", "vim"][..],
        &["gandalf", "skill", "sync", "--scope", "all"][..],
        &["gandalf", "skill", "list", "--scope", "managed"][..],
    ] {
        assert!(Cli::try_parse_from(argv).is_err(), "{argv:?}");
    }
}

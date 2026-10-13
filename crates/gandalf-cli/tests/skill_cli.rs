#![allow(clippy::unwrap_used)]

use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

fn gandalf(home: &Path, arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_gandalf"))
        .args(arguments)
        .env("HOME", home)
        .current_dir(home)
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

#[test]
fn skill_workflow_runs_end_to_end_without_a_daemon() {
    let base = tempfile::tempdir().unwrap();
    let home = base.path().join("home");
    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::create_dir_all(home.join(".codex")).unwrap();
    let source = base.path().join("reviewer");
    fs::create_dir_all(&source).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\ndescription: Reviews pull requests\n---\nv1\n",
    )
    .unwrap();
    let source = source.to_str().unwrap();

    let empty = gandalf(&home, &[]);
    assert!(empty.status.success());
    assert!(stdout(&empty).contains("No skills found for Claude Code, Codex."));

    let added = gandalf(&home, &["skill", "add", source, "--agent", "claude-code"]);
    assert!(added.status.success());
    assert!(stdout(&added).contains("installed"));

    let overview = stdout(&gandalf(&home, &[]));
    assert!(overview.contains("partial"), "{overview}");

    let dry = gandalf(&home, &["skill", "sync", "--dry-run"]);
    assert!(stdout(&dry).contains("would install"));
    // Codex reads the shared ~/.agents/skills directory.
    let codex_copy = home.join(".agents/skills/reviewer");
    assert!(!codex_copy.exists(), "dry run wrote the skill");

    assert!(gandalf(&home, &["skill", "sync"]).status.success());
    let listed = gandalf(&home, &["--output", "json", "skill", "list"]);
    let inventory: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(inventory["skills"][0]["status"], "synced");

    let shown = stdout(&gandalf(&home, &["skill", "show", "reviewer"]));
    assert!(shown.contains("Reviews pull requests") && shown.contains("v1"));

    // A diverged copy must be refused, with exit status 1, until --from.
    fs::write(codex_copy.join("SKILL.md"), "local edit\n").unwrap();
    let refused = gandalf(&home, &["skill", "sync"]);
    assert_eq!(refused.status.code(), Some(1));
    assert!(stdout(&refused).contains("--from"));
    assert_eq!(
        fs::read_to_string(codex_copy.join("SKILL.md")).unwrap(),
        "local edit\n"
    );

    let resolved = gandalf(
        &home,
        &["skill", "sync", "reviewer", "--from", "claude-code"],
    );
    assert!(resolved.status.success());
    assert!(stdout(&resolved).contains("replaced"));
    assert_eq!(
        fs::read_dir(home.join(".gandalf/trash")).unwrap().count(),
        1
    );

    assert!(
        gandalf(&home, &["skill", "remove", "reviewer"])
            .status
            .success()
    );
    assert!(stdout(&gandalf(&home, &[])).contains("No skills found"));

    let missing = gandalf(&home, &["skill", "show", "reviewer"]);
    assert_eq!(missing.status.code(), Some(1));
}

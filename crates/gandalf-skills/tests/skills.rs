#![allow(clippy::unwrap_used)]

use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
};

use gandalf_skills::{
    Action, AddOptions, Agent, ENTRYPOINT, Inventory, Location, RemoveOptions, Scope, Skill,
    SkillError, Status, SyncOptions, add, detect_agents, discover, has_conflicts, hash_dir,
    read_roots, remove, root, sync,
};
use tempfile::TempDir;

struct Fixture {
    _base: TempDir,
    location: Location,
}

fn fixture() -> Fixture {
    let base = tempfile::tempdir().unwrap();
    // Canonicalize so paths compare equal to the resolved sources Gandalf reports.
    let resolved = fs::canonicalize(base.path()).unwrap();
    let location = Location {
        home_dir: resolved.join("home"),
        project_path: resolved.join("project"),
    };
    fs::create_dir_all(&location.home_dir).unwrap();
    fs::create_dir_all(&location.project_path).unwrap();
    Fixture {
        _base: base,
        location,
    }
}

fn write_skill(dir: &Path, body: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(ENTRYPOINT), body).unwrap();
}

fn install(location: &Location, agent: Agent, name: &str, body: &str) -> PathBuf {
    let dir = root(agent, Scope::User, location).join(name);
    write_skill(&dir, body);
    dir
}

fn user_inventory(location: &Location) -> Inventory {
    discover(location, &Agent::ALL, &[Scope::User]).unwrap()
}

fn find(inventory: &Inventory, name: &str) -> Skill {
    inventory.find(name, Scope::User).unwrap().clone()
}

#[test]
fn discover_classifies_skills_across_agents() {
    let fx = fixture();
    for agent in Agent::ALL {
        install(
            &fx.location,
            agent,
            "everywhere",
            "---\ndescription: \"Shared skill\"\n---\nbody\n",
        );
    }
    install(&fx.location, Agent::ClaudeCode, "claude-only", "one\n");
    install(&fx.location, Agent::ClaudeCode, "drifted", "version a\n");
    install(&fx.location, Agent::Codex, "drifted", "version b\n");

    // Directories without SKILL.md and hidden directories are not skills.
    let codex_root = root(Agent::Codex, Scope::User, &fx.location);
    fs::create_dir_all(codex_root.join("not-a-skill")).unwrap();
    write_skill(&codex_root.join(".system"), "hidden\n");

    let inventory = user_inventory(&fx.location);
    assert_eq!(inventory.skills.len(), 3);

    let everywhere = find(&inventory, "everywhere");
    assert_eq!(everywhere.status, Status::Synced);
    assert_eq!(everywhere.description.as_deref(), Some("Shared skill"));

    // Cursor reads ~/.claude/skills too, so only Codex lacks this one.
    let claude_only = find(&inventory, "claude-only");
    assert_eq!(claude_only.status, Status::Partial);
    assert_eq!(claude_only.missing, vec![Agent::Codex]);

    // Codex and Cursor share ~/.agents/skills: one directory, two installs.
    let shared = &find(&inventory, "everywhere").installs;
    assert_eq!(
        shared
            .iter()
            .find(|i| i.agent == Agent::Codex)
            .unwrap()
            .path,
        shared
            .iter()
            .find(|i| i.agent == Agent::Cursor)
            .unwrap()
            .path
    );

    assert_eq!(find(&inventory, "drifted").status, Status::Diverged);
}

#[test]
fn discover_keeps_scopes_separate() {
    let fx = fixture();
    install(&fx.location, Agent::ClaudeCode, "shared-name", "user\n");
    write_skill(
        &fx.location.project_path.join(".claude/skills/shared-name"),
        "project\n",
    );

    let inventory = discover(&fx.location, &Agent::ALL, &[Scope::User, Scope::Project]).unwrap();
    let scopes: Vec<Scope> = inventory.skills.iter().map(|skill| skill.scope).collect();
    assert_eq!(scopes, vec![Scope::User, Scope::Project]);
}

#[test]
fn hash_ignores_noise_and_tracks_content() {
    let base = tempfile::tempdir().unwrap();
    let (a, b) = (base.path().join("a"), base.path().join("b"));
    write_skill(&a, "same\n");
    write_skill(&b, "same\n");
    fs::write(b.join(".DS_Store"), "noise").unwrap();
    assert_eq!(hash_dir(&a).unwrap(), hash_dir(&b).unwrap());

    fs::write(b.join("extra.md"), "more").unwrap();
    assert_ne!(hash_dir(&a).unwrap(), hash_dir(&b).unwrap());
}

#[test]
fn add_installs_and_refuses_to_overwrite_without_force() {
    let fx = fixture();
    let source_base = tempfile::tempdir().unwrap();
    let src = source_base.path().join("reviewer");
    write_skill(&src, "v1\n");
    fs::create_dir_all(src.join("scripts")).unwrap();
    let script = src.join("scripts/run.sh");
    fs::write(&script, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    // An in-tree relative link is kept; a link escaping the skill is not.
    symlink("scripts/run.sh", src.join("run")).unwrap();
    symlink("/etc/hosts", src.join("escape")).unwrap();
    symlink("../../outside", src.join("scripts/climb")).unwrap();
    let existing = install(&fx.location, Agent::Codex, "reviewer", "local edits\n");

    let mut options = AddOptions {
        location: &fx.location,
        scope: Scope::User,
        agents: &Agent::ALL,
        name: None,
        force: false,
        dry_run: false,
    };
    let report = add(&src, &options).unwrap();
    assert!(report.error.is_none());
    assert!(has_conflicts(&report.changes));
    assert_eq!(
        fs::read_to_string(existing.join(ENTRYPOINT)).unwrap(),
        "local edits\n",
        "Codex copy was overwritten without --force"
    );

    let installed = root(Agent::ClaudeCode, Scope::User, &fx.location).join("reviewer");
    let mode = fs::metadata(installed.join("scripts/run.sh"))
        .unwrap()
        .permissions()
        .mode();
    assert_ne!(mode & 0o100, 0, "executable bit was lost");
    assert_eq!(
        fs::read_link(installed.join("run")).unwrap(),
        PathBuf::from("scripts/run.sh")
    );
    assert!(fs::symlink_metadata(installed.join("escape")).is_err());
    assert!(fs::symlink_metadata(installed.join("scripts/climb")).is_err());

    options.force = true;
    let report = add(&src, &options).unwrap();
    let replaced = report
        .changes
        .iter()
        .find(|change| change.action == Action::Replace)
        .unwrap();
    assert_eq!(replaced.agent, Some(Agent::Codex));
    let backup = replaced.backup.as_ref().unwrap();
    assert_eq!(
        fs::read_to_string(backup.join(ENTRYPOINT)).unwrap(),
        "local edits\n"
    );
    assert_eq!(
        find(&user_inventory(&fx.location), "reviewer").status,
        Status::Synced
    );
}

#[test]
fn add_rejects_non_skill_and_bad_name() {
    let fx = fixture();
    let options = AddOptions {
        location: &fx.location,
        scope: Scope::User,
        agents: &Agent::ALL,
        name: None,
        force: false,
        dry_run: false,
    };
    let empty = tempfile::tempdir().unwrap();
    assert!(matches!(
        add(empty.path(), &options),
        Err(SkillError::NotASkill(_))
    ));

    let source_base = tempfile::tempdir().unwrap();
    let src = source_base.path().join("ok");
    write_skill(&src, "x\n");
    let traversal = AddOptions {
        name: Some("../escape"),
        ..options
    };
    assert!(matches!(
        add(&src, &traversal),
        Err(SkillError::InvalidName(_))
    ));
}

#[test]
fn sync_fills_gaps_but_leaves_diverged_copies_alone() {
    let fx = fixture();
    install(&fx.location, Agent::ClaudeCode, "claude-only", "one\n");
    install(&fx.location, Agent::ClaudeCode, "drifted", "version a\n");
    let codex_drifted = install(&fx.location, Agent::Codex, "drifted", "version b\n");

    let mut options = SyncOptions {
        location: &fx.location,
        scope: Scope::User,
        names: &[],
        from: None,
        to: &Agent::ALL,
        dry_run: true,
    };
    let planned = sync(&options).unwrap();
    assert_eq!(
        find(&user_inventory(&fx.location), "claude-only").status,
        Status::Partial,
        "dry run wrote to disk"
    );

    options.dry_run = false;
    let applied = sync(&options).unwrap();
    assert!(applied.error.is_none());
    assert_eq!(applied.changes.len(), planned.changes.len());
    assert!(has_conflicts(&applied.changes));

    let inventory = user_inventory(&fx.location);
    assert_eq!(find(&inventory, "claude-only").status, Status::Synced);
    assert_eq!(find(&inventory, "drifted").status, Status::Diverged);

    let names = ["drifted".to_owned()];
    options.from = Some(Agent::ClaudeCode);
    options.names = &names;
    let report = sync(&options).unwrap();
    assert!(report.error.is_none());
    assert!(!has_conflicts(&report.changes));
    assert_eq!(
        find(&user_inventory(&fx.location), "drifted").status,
        Status::Synced
    );
    assert_eq!(
        fs::read_to_string(codex_drifted.join(ENTRYPOINT)).unwrap(),
        "version a\n"
    );

    options.from = None;
    options.names = &[];
    assert!(
        sync(&options).unwrap().changes.is_empty(),
        "sync is not idempotent"
    );
}

#[test]
fn sync_unknown_name_fails() {
    let fx = fixture();
    let names = ["nope".to_owned()];
    let options = SyncOptions {
        location: &fx.location,
        scope: Scope::User,
        names: &names,
        from: None,
        to: &Agent::ALL,
        dry_run: false,
    };
    assert!(matches!(
        sync(&options),
        Err(SkillError::NotInstalled { .. })
    ));
}

#[test]
fn remove_trashes_directories_and_only_unlinks_symlinks() {
    let fx = fixture();
    let claude_copy = install(&fx.location, Agent::ClaudeCode, "doomed", "recoverable\n");

    let shared_base = tempfile::tempdir().unwrap();
    let shared = shared_base.path().join("doomed");
    write_skill(&shared, "recoverable\n");
    let codex_root = root(Agent::Codex, Scope::User, &fx.location);
    fs::create_dir_all(&codex_root).unwrap();
    symlink(&shared, codex_root.join("doomed")).unwrap();

    let report = remove(
        "doomed",
        &RemoveOptions {
            location: &fx.location,
            scope: Scope::User,
            agents: &Agent::ALL,
            dry_run: false,
        },
    )
    .unwrap();
    assert!(report.error.is_none());
    assert_eq!(report.changes.len(), 2);
    // The link in ~/.agents/skills serves Codex and Cursor; it is unlinked
    // once, attributed to the first agent that reads it.
    for change in &report.changes {
        match change.agent {
            Some(Agent::ClaudeCode) => {
                assert_eq!(change.action, Action::Remove);
                assert!(change.backup.as_ref().unwrap().join(ENTRYPOINT).is_file());
            }
            Some(Agent::Codex) => assert_eq!(change.action, Action::Unlink),
            other => panic!("unexpected agent {other:?}"),
        }
    }
    assert!(fs::symlink_metadata(&claude_copy).is_err());
    assert!(
        shared.join(ENTRYPOINT).is_file(),
        "symlink target was deleted"
    );
    assert!(user_inventory(&fx.location).skills.is_empty());
}

#[test]
fn detect_agents_uses_home_config_dirs() {
    let fx = fixture();
    assert_eq!(detect_agents(&fx.location), Agent::ALL.to_vec());
    fs::create_dir_all(fx.location.home_dir.join(".codex")).unwrap();
    assert_eq!(detect_agents(&fx.location), vec![Agent::Codex]);
}

#[test]
fn roots_follow_each_agents_documented_directories() {
    let fx = fixture();
    let home = &fx.location.home_dir;
    assert_eq!(
        root(Agent::Codex, Scope::User, &fx.location),
        home.join(".agents/skills")
    );
    assert_eq!(
        root(Agent::Cursor, Scope::User, &fx.location),
        home.join(".agents/skills")
    );
    assert_eq!(
        root(Agent::ClaudeCode, Scope::Project, &fx.location),
        fx.location.project_path.join(".claude/skills")
    );
    let cursor_reads = read_roots(Agent::Cursor, Scope::User, &fx.location);
    assert!(cursor_reads.contains(&home.join(".claude/skills")));
    assert!(cursor_reads.contains(&home.join(".cursor/skills")));

    // A legacy copy in ~/.codex/skills is still listed for Codex, but the
    // shared directory wins when both hold the same name.
    write_skill(&home.join(".codex/skills/legacy"), "old\n");
    write_skill(&home.join(".codex/skills/both"), "codex copy\n");
    write_skill(&home.join(".agents/skills/both"), "shared copy\n");
    let inventory = user_inventory(&fx.location);
    assert_eq!(find(&inventory, "legacy").missing, vec![Agent::ClaudeCode]);
    let both = find(&inventory, "both");
    assert_eq!(
        both.install_for(Agent::Codex).unwrap().path,
        home.join(".agents/skills/both")
    );
}

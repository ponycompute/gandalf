#![allow(clippy::unwrap_used)]

use std::{fs, os::unix::fs::PermissionsExt, path::Path};

use gandalf_store::Store;
use rusqlite::{Connection, params};

fn set_mode(path: &Path, mode: u32) {
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(mode);
    fs::set_permissions(path, permissions).unwrap();
}

fn fresh_database() -> (tempfile::TempDir, std::path::PathBuf) {
    let home = tempfile::tempdir().unwrap();
    set_mode(home.path(), 0o700);
    let database = home.path().join("state.db");
    drop(Store::open_new(&database).unwrap());
    let connection = Connection::open(&database).unwrap();
    connection
        .execute(
            "INSERT INTO projects(project_id, repository_identity, encrypted_root_path, created_at, updated_at)
             VALUES ('project', 'repo', X'00', 'now', 'now')",
            [],
        )
        .unwrap();
    (home, database)
}

fn excerpt(text: &str) -> serde_json::Value {
    serde_json::json!({
        "hash": "h",
        "byte_length": text.len(),
        "media_type": "text/plain",
        "local_locator": null,
        "redacted_excerpt": text,
        "truncated": false,
        "disclosure_class": "human_intent",
    })
}

fn insert_event(
    connection: &Connection,
    event_id: &str,
    session: &str,
    provider: &str,
    actor: &str,
    payload: &serde_json::Value,
) {
    connection
        .execute(
            "INSERT INTO activity_events(
                 event_id, semantic_key, schema_version, occurred_at, observed_at,
                 project_id, session_id, turn_id, actor, correlation_id,
                 causation_id, source_json, payload_json, privacy
             ) VALUES (?1, ?1, 1, '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z',
                       'project', ?2, NULL, ?3, NULL, NULL, ?4, ?5, '{}')",
            params![
                event_id,
                session,
                actor,
                serde_json::json!({ "provider": provider }).to_string(),
                payload.to_string(),
            ],
        )
        .unwrap();
}

fn message(text: &str) -> serde_json::Value {
    serde_json::json!({ "kind": "message.created", "content": excerpt(text) })
}

fn turns(connection: &Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare("SELECT role, body FROM session_turns ORDER BY event_seq")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn matches(connection: &Connection, query: &str) -> Vec<String> {
    let mut statement = connection
        .prepare(
            "SELECT t.session_id FROM session_search
             JOIN session_turns t ON t.event_seq = session_search.rowid
             WHERE session_search MATCH ?1 ORDER BY bm25(session_search)",
        )
        .unwrap();
    statement
        .query_map([query], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn indexes_text_bearing_events_as_they_are_stored() {
    let (_home, database) = fresh_database();
    let connection = Connection::open(&database).unwrap();

    insert_event(&connection, "e1", "s1", "claude", "human", &message("why does the launchd plist fail"));
    insert_event(&connection, "e2", "s1", "claude", "agent", &message("The plist path is wrong."));
    insert_event(
        &connection,
        "e3",
        "s2",
        "codex",
        "agent",
        &serde_json::json!({
            "kind": "action.requested",
            "native_action_id": "a",
            "tool_name": "exec_command",
            "input": excerpt("launchctl bootstrap gui/501"),
        }),
    );
    insert_event(
        &connection,
        "e4",
        "s2",
        "codex",
        "tool",
        &serde_json::json!({
            "kind": "action.finished",
            "native_action_id": "a",
            "outcome": "failed",
            "output": excerpt("Bootstrap failed: 5: Input/output error"),
        }),
    );
    insert_event(
        &connection,
        "e5",
        "s2",
        "codex",
        "tool",
        &serde_json::json!({
            "kind": "action.finished",
            "native_action_id": "b",
            "outcome": "succeeded",
            "output": excerpt("ok"),
        }),
    );
    insert_event(
        &connection,
        "e6",
        "s2",
        "codex",
        "agent",
        &serde_json::json!({
            "kind": "artifact.changed",
            "path": excerpt("crates/gandalf-cli/src/platform/macos.rs"),
            "operation": "update",
            "content_hash": null,
        }),
    );
    insert_event(
        &connection,
        "e7",
        "s1",
        "claude",
        "agent",
        &serde_json::json!({ "kind": "turn.started", "prompt_id": null }),
    );

    assert_eq!(
        turns(&connection),
        vec![
            ("user".to_owned(), "why does the launchd plist fail".to_owned()),
            ("agent".to_owned(), "The plist path is wrong.".to_owned()),
            ("command".to_owned(), "exec_command launchctl bootstrap gui/501".to_owned()),
            ("error".to_owned(), "Bootstrap failed: 5: Input/output error".to_owned()),
            ("edit".to_owned(), "update crates/gandalf-cli/src/platform/macos.rs".to_owned()),
        ]
    );
    assert_eq!(matches(&connection, "plist"), vec!["s1", "s1"]);
    assert_eq!(matches(&connection, "bootstrap AND failed"), vec!["s2"]);
}

#[test]
fn skips_context_the_harness_injects_into_user_turns() {
    let (_home, database) = fresh_database();
    let connection = Connection::open(&database).unwrap();

    insert_event(&connection, "e1", "s1", "claude", "human", &message("<system-reminder>be terse</system-reminder>"));
    insert_event(&connection, "e2", "s1", "codex", "human", &message("  <environment_context>cwd</environment_context>"));
    insert_event(&connection, "e3", "s1", "codex", "human", &message("# AGENTS.md instructions for /repo"));
    insert_event(&connection, "e4", "s1", "claude", "human", &message("<command-name>/clear</command-name>"));
    insert_event(&connection, "e5", "s1", "claude", "human", &message("fix the flaky test"));

    assert_eq!(turns(&connection), vec![("user".to_owned(), "fix the flaky test".to_owned())]);
}

#[test]
fn deleting_events_removes_them_from_the_index() {
    let (_home, database) = fresh_database();
    let connection = Connection::open(&database).unwrap();
    insert_event(&connection, "e1", "s1", "claude", "human", &message("rotate the signing key"));
    assert_eq!(matches(&connection, "signing"), vec!["s1"]);

    connection
        .execute("DELETE FROM activity_events WHERE project_id = 'project'", [])
        .unwrap();

    assert!(turns(&connection).is_empty());
    assert!(matches(&connection, "signing").is_empty());
}

#[test]
fn upgrading_from_v2_backfills_stored_events() {
    let (_home, database) = fresh_database();
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "DROP TRIGGER session_turns_after_event_insert;
             DROP TRIGGER session_turns_after_event_delete;
             DROP TRIGGER session_search_after_turn_insert;
             DROP TRIGGER session_search_after_turn_delete;
             DROP TABLE session_search;
             DROP TABLE session_turns;
             DROP VIEW session_turn_source;
             DELETE FROM schema_migrations WHERE version = 3;
             PRAGMA user_version = 2;",
        )
        .unwrap();
    insert_event(&connection, "e1", "s1", "codex", "human", &message("migrate the store to v3"));
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    drop(connection);

    let store = Store::open_new(&database).unwrap();
    assert_eq!(store.schema_version().unwrap(), 3);
    drop(store);

    let connection = Connection::open(&database).unwrap();
    assert_eq!(turns(&connection), vec![("user".to_owned(), "migrate the store to v3".to_owned())]);
    assert_eq!(matches(&connection, "migrate"), vec!["s1"]);
}

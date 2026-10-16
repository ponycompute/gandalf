#![allow(clippy::expect_used, clippy::unwrap_used)]

use gandalf_core::{ProjectId, Provider, api::TurnRole};
use gandalf_ingest::test_support::FixtureRuntime;

const CLAUDE: &str = include_str!("../../gandalf-adapters/tests/fixtures/claude/basic.jsonl");

#[tokio::test]
async fn ingested_claude_sessions_are_searchable_by_what_was_said() {
    let fixture = FixtureRuntime::provider_records(Provider::Claude, CLAUDE.lines())
        .await
        .unwrap();
    fixture.drain().await.unwrap();
    let project = ProjectId::for_test("project_fixture");

    let hits = fixture
        .read_store()
        .search_sessions(&project, "parser".to_owned(), 10)
        .await
        .unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].session_id.as_str(), "s1");
    assert_eq!(hits[0].provider, Provider::Claude);
    assert_eq!(hits[0].role, TurnRole::User);
    assert_eq!(hits[0].snippet, "Implement the [parser]");

    let agent = fixture
        .read_store()
        .search_sessions(&project, "inspect".to_owned(), 10)
        .await
        .unwrap();
    assert_eq!(agent.len(), 1);
    assert_eq!(agent[0].role, TurnRole::Agent);
}

#[tokio::test]
async fn search_is_scoped_to_the_project() {
    let fixture = FixtureRuntime::provider_records(Provider::Claude, CLAUDE.lines())
        .await
        .unwrap();
    fixture.drain().await.unwrap();

    let hits = fixture
        .read_store()
        .search_sessions(
            &ProjectId::for_test("project_other"),
            "parser".to_owned(),
            10,
        )
        .await
        .unwrap();

    assert!(hits.is_empty());
}

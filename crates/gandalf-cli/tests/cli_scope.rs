#![allow(clippy::unwrap_used)]

use gandalf_cli::{CliError, GandalfPaths, commands::client::scoped_client};
use gandalf_service::ipc::WireActor;

#[tokio::test]
async fn scoped_cli_refuses_non_projects_before_attempting_ipc() {
    let directory = tempfile::tempdir().unwrap();
    let error = scoped_client(
        &GandalfPaths::from_home(directory.path()),
        directory.path(),
        WireActor::HumanCli,
    )
    .await
    .unwrap_err();
    assert!(matches!(error, CliError::InvalidProject));
}

#[tokio::test]
async fn scoped_cli_never_opens_a_database_when_daemon_is_unavailable() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join(".git")).unwrap();
    let paths = GandalfPaths::from_home(directory.path());
    let error = scoped_client(&paths, directory.path(), WireActor::HumanCli)
        .await
        .unwrap_err();
    assert!(matches!(error, CliError::Unavailable));
    assert!(!paths.state_db.exists());
}

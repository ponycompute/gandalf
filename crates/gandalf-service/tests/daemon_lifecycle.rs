#![allow(clippy::unwrap_used)]

use std::sync::Arc;

use async_trait::async_trait;
use gandalf_core::api::{AppRequest, AppResponse};
use gandalf_service::{
    Components, Daemon, RequestScope, ServiceError,
    ipc::{LocalIpcServer, ScopedRequestHandler},
};

#[derive(Debug)]
struct Accepted;

#[async_trait]
impl ScopedRequestHandler for Accepted {
    async fn dispatch(&self, _: RequestScope, _: AppRequest) -> Result<AppResponse, ServiceError> {
        Ok(AppResponse::Accepted)
    }
}

#[tokio::test]
async fn daemon_shutdown_removes_its_socket() {
    let directory = tempfile::Builder::new()
        .prefix("a")
        .tempdir_in("/tmp")
        .unwrap();
    std::fs::create_dir(directory.path().join(".git")).unwrap();
    let socket = directory.path().join("gandalf.sock");
    let server = LocalIpcServer::bind(&socket, Arc::new(Accepted))
        .await
        .unwrap();
    let daemon = Daemon::run(Components::new(server)).unwrap();
    assert!(daemon.socket_path().exists());
    daemon.shutdown().await.unwrap();
    assert!(!socket.exists());
}

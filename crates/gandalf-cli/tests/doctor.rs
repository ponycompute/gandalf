#![allow(clippy::unwrap_used)]

use gandalf_cli::GandalfPaths;
use gandalf_cli::commands::doctor::{DoctorReport, DoctorSeverity};
use std::os::unix::fs::PermissionsExt;

#[test]
fn failures_are_preserved_in_doctor_aggregation() {
    let report = DoctorReport::baseline(false);
    assert!(!report.is_healthy());
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.severity == DoctorSeverity::Failing)
    );
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.code == "network.public_listener")
    );
}

#[test]
fn owner_only_runtime_layout_is_checked_component_by_component() {
    let home = tempfile::tempdir().unwrap();
    let paths = GandalfPaths::from_home(home.path());
    for directory in paths.private_directories() {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let connection = rusqlite::Connection::open(&paths.state_db).unwrap();
    connection
        .pragma_update(None, "user_version", 2_i64)
        .unwrap();
    drop(connection);
    std::fs::set_permissions(&paths.state_db, std::fs::Permissions::from_mode(0o600)).unwrap();

    let report = DoctorReport::inspect(&paths, true);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.code == "evidence.root_containment"
                && check.severity == DoctorSeverity::Healthy)
    );
    assert!(report.checks.iter().any(
        |check| check.code == "runtime.owner_only" && check.severity == DoctorSeverity::Healthy
    ));
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.code == "state_db.v2" && check.severity == DoctorSeverity::Healthy)
    );
}

#[test]
fn text_report_explains_each_check_and_says_what_to_run_first() {
    use gandalf_cli::commands::{doctor::render, style::Palette};

    let failing = render(Palette::plain(), &DoctorReport::baseline(false));
    let line = failing
        .lines()
        .find(|line| line.contains("daemon.ipc"))
        .unwrap();
    assert!(
        line.starts_with("✗ Background service is reachable"),
        "{failing}"
    );
    assert!(failing.contains("    fix: run gandalf daemon start"));
    assert!(failing.contains("✓ Nothing listens on the network"));
    assert!(failing.contains("1 failing, 0 warnings of 3 checks."));
    assert!(failing.contains("`gandalf init`"));
    assert!(!failing.contains("Failing:"), "no debug-formatted severity");

    let healthy = render(Palette::plain(), &DoctorReport::baseline(true));
    assert!(healthy.contains("✓ All 3 checks passed."), "{healthy}");
    assert!(!healthy.contains("fix:"));
}

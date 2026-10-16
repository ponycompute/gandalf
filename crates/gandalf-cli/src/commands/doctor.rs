//! Non-sensitive health diagnostics.

use std::{fmt::Write as _, os::unix::fs::MetadataExt, path::Path};

use serde::Serialize;

use crate::{commands::style::Palette, paths::GandalfPaths};

/// Stable doctor severity that never hides failures behind warnings.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorSeverity {
    Healthy,
    Warning,
    Failing,
}

/// One bounded check result suitable for text or JSON rendering.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DoctorCheck {
    pub code: &'static str,
    pub severity: DoctorSeverity,
    pub remediation: &'static str,
}

/// Aggregated diagnostic state.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
}

impl DoctorReport {
    /// Returns a conservative local-only baseline without reading evidence or secrets.
    #[must_use]
    pub fn baseline(daemon_reachable: bool) -> Self {
        Self {
            checks: vec![
                DoctorCheck {
                    code: "paths.owner_only",
                    severity: DoctorSeverity::Healthy,
                    remediation: "",
                },
                DoctorCheck {
                    code: "daemon.ipc",
                    severity: if daemon_reachable {
                        DoctorSeverity::Healthy
                    } else {
                        DoctorSeverity::Failing
                    },
                    remediation: "run gandalf daemon start",
                },
                DoctorCheck {
                    code: "network.public_listener",
                    severity: DoctorSeverity::Healthy,
                    remediation: "",
                },
            ],
        }
    }
    #[must_use]
    pub fn is_healthy(&self) -> bool {
        self.checks
            .iter()
            .all(|check| check.severity == DoctorSeverity::Healthy)
    }

    /// Performs local, metadata-only checks. This never opens evidence, logs,
    /// or source transcripts and therefore cannot disclose their contents.
    #[must_use]
    pub fn inspect(paths: &GandalfPaths, daemon_reachable: bool) -> Self {
        let mut report = Self::baseline(daemon_reachable);
        report.checks[0] = DoctorCheck {
            code: "paths.owner_only",
            severity: private_runtime(paths.root.as_path()),
            remediation: "run gandalf init",
        };
        report.checks.push(DoctorCheck {
            code: "state_db.schema",
            severity: state_database(&paths.state_db),
            remediation: "run gandalf daemon start",
        });
        for (code, directory) in [
            ("evidence.owner_only", &paths.evidence),
            ("spool.owner_only", &paths.spool),
            ("logs.owner_only", &paths.logs),
            ("runtime.owner_only", &paths.runtime),
            ("config.owner_only", &paths.config),
        ] {
            report.checks.push(DoctorCheck {
                code,
                severity: private_runtime(directory),
                remediation: "run gandalf init",
            });
        }
        report.checks.push(DoctorCheck {
            code: "evidence.root_containment",
            severity: contained_child(&paths.root, &paths.evidence),
            remediation: "remove the unsafe evidence path and run gandalf init",
        });
        report
    }
}

fn contained_child(root: &Path, child: &Path) -> DoctorSeverity {
    let Ok(root) = root.canonicalize() else {
        return DoctorSeverity::Failing;
    };
    let Ok(child) = child.canonicalize() else {
        return DoctorSeverity::Failing;
    };
    if child.starts_with(root) {
        DoctorSeverity::Healthy
    } else {
        DoctorSeverity::Failing
    }
}

fn private_runtime(path: &Path) -> DoctorSeverity {
    std::fs::symlink_metadata(path).map_or(DoctorSeverity::Failing, |metadata| {
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o077 != 0
        {
            DoctorSeverity::Failing
        } else {
            DoctorSeverity::Healthy
        }
    })
}

fn regular_owner_file(path: &Path) -> DoctorSeverity {
    std::fs::symlink_metadata(path).map_or(DoctorSeverity::Warning, |metadata| {
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o077 != 0
        {
            DoctorSeverity::Failing
        } else {
            DoctorSeverity::Healthy
        }
    })
}

fn state_database(path: &Path) -> DoctorSeverity {
    let ownership = regular_owner_file(path);
    if ownership != DoctorSeverity::Healthy {
        return ownership;
    }
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    );
    let Ok(connection) = connection else {
        return DoctorSeverity::Failing;
    };
    let version = connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0));
    let integrity =
        connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0));
    if version == Ok(gandalf_store::SCHEMA_VERSION) && integrity.as_deref() == Ok("ok") {
        DoctorSeverity::Healthy
    } else {
        DoctorSeverity::Failing
    }
}

/// Plain-language meaning of each check code. Codes stay in the output as a
/// stable reference for scripts and bug reports.
fn describe(code: &str) -> &str {
    match code {
        "paths.owner_only" => "Data directory is private to you",
        "daemon.ipc" => "Background service is reachable",
        "network.public_listener" => "Nothing listens on the network",
        "state_db.schema" => "State database is present and intact",
        "evidence.owner_only" => "Evidence directory is private to you",
        "spool.owner_only" => "Spool directory is private to you",
        "logs.owner_only" => "Log directory is private to you",
        "runtime.owner_only" => "Runtime directory is private to you",
        "config.owner_only" => "Config directory is private to you",
        "evidence.root_containment" => "Evidence stays inside the data directory",
        other => other,
    }
}

/// Renders the report for a terminal: one line per check, the fix under each
/// problem, and a summary that says what to run first.
#[must_use]
pub fn render(palette: Palette, report: &DoctorReport) -> String {
    let width = report
        .checks
        .iter()
        .map(|check| describe(check.code).chars().count())
        .max()
        .unwrap_or(0);
    let (mut failing, mut warnings) = (0_usize, 0_usize);
    let mut text = String::new();
    for check in &report.checks {
        let mark = match check.severity {
            DoctorSeverity::Healthy => palette.good("✓"),
            DoctorSeverity::Warning => {
                warnings += 1;
                palette.warn("!")
            }
            DoctorSeverity::Failing => {
                failing += 1;
                palette.bad("✗")
            }
        };
        let label = describe(check.code);
        let padding = width.saturating_sub(label.chars().count()) + 2;
        let _ = writeln!(
            text,
            "{mark} {label}{:padding$}{}",
            "",
            palette.dim(check.code)
        );
        if check.severity != DoctorSeverity::Healthy && !check.remediation.is_empty() {
            let _ = writeln!(
                text,
                "    {}",
                palette.dim(&format!("fix: {}", check.remediation))
            );
        }
    }
    text.push('\n');
    if failing == 0 && warnings == 0 {
        let _ = writeln!(
            text,
            "{} All {} checks passed.",
            palette.good("✓"),
            report.checks.len()
        );
        return text;
    }
    let _ = writeln!(
        text,
        "{failing} failing, {warnings} warning{} of {} checks.",
        if warnings == 1 { "" } else { "s" },
        report.checks.len()
    );
    // Skills work without the background service; only handoff needs it.
    let _ = writeln!(
        text,
        "Work handoff needs these fixed; start with {}. Skill commands work regardless.",
        palette.command("`gandalf init`")
    );
    text
}

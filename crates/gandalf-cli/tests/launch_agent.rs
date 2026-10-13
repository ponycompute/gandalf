#![allow(clippy::unwrap_used)]

use gandalf_cli::{Initializer, platform::test_support::FixturePlatform};

#[test]
fn runtime_service_has_exact_safe_foreground_arguments() {
    let platform = FixturePlatform::from_fixtures(
        "tests/fixtures/claude-user.json",
        "tests/fixtures/claude-settings.json",
        "tests/fixtures/codex-config.toml",
    )
    .unwrap();
    let _initializer = Initializer::new(platform);
    let spec = Initializer::<FixturePlatform>::runtime_spec(
        "/Users/gandalf-fixture/.local/bin/gandalf".into(),
    );

    assert_eq!(spec.label, "com.gandalf.runtime");
    assert_eq!(spec.program_arguments, ["daemon", "start", "--foreground"]);
}

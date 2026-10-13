//! Managed agent configuration commands.

use crate::{
    CliError,
    config::{remove_claude_user, remove_codex_config},
    platform::Platform,
};

/// Removes only gandalf-owned MCP blocks; unrelated user configuration remains
/// byte-for-byte under each native configuration format's serializer.
///
/// # Errors
///
/// Returns a stable error when owner-private configuration cannot be read or
/// atomically rewritten.
pub fn disconnect(platform: &impl Platform) -> Result<(), CliError> {
    let home = platform.home()?;
    let claude = home.join(".claude.json");
    if let Some(existing) = platform.read_file(&claude)? {
        let updated = remove_claude_user(&existing)?;
        let _ = platform.write_private_file(&claude, &updated)?;
    }
    let codex = home.join(".codex/config.toml");
    if let Some(existing) = platform.read_file(&codex)? {
        let updated = remove_codex_config(&existing)?;
        let _ = platform.write_private_file(&codex, &updated)?;
    }
    Ok(())
}

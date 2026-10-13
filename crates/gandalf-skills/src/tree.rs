use std::{
    fmt::Write as _,
    fs, io,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Component, Path, PathBuf},
};

use sha2::{Digest, Sha256};

/// One file or in-tree symlink of a skill directory. Hashing and copying
/// both walk the same entries, so a copy always hashes equal to its source.
pub(crate) struct TreeEntry {
    /// Path relative to the skill directory, with `/` separators.
    rel: String,
    kind: EntryKind,
}

enum EntryKind {
    File { mode: u32 },
    Link { target: PathBuf },
}

const IGNORED_NAMES: [&str; 2] = [".DS_Store", ".git"];

/// Lists the regular files and in-tree relative symlinks under `dir`, sorted
/// by path. Symlinks that are absolute or resolve outside `dir` are left
/// out: copying them would silently point a skill at files it does not own.
pub(crate) fn walk_tree(dir: &Path) -> io::Result<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    walk_into(dir, "", 0, &mut entries)?;
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(entries)
}

fn walk_into(
    dir: &Path,
    prefix: &str,
    depth: usize,
    entries: &mut Vec<TreeEntry>,
) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if IGNORED_NAMES.contains(&name.as_str()) {
            continue;
        }
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            let target = fs::read_link(entry.path())?;
            if link_stays_inside(depth, &target) {
                entries.push(TreeEntry {
                    rel,
                    kind: EntryKind::Link { target },
                });
            }
        } else if file_type.is_dir() {
            walk_into(&entry.path(), &rel, depth + 1, entries)?;
        } else if file_type.is_file() {
            let mode = entry.metadata()?.permissions().mode() & 0o777;
            entries.push(TreeEntry {
                rel,
                kind: EntryKind::File { mode },
            });
        }
    }
    Ok(())
}

/// Reports whether a relative link, found `depth` directories below the
/// skill root, resolves to a path that is still inside the skill.
fn link_stays_inside(depth: usize, target: &Path) -> bool {
    let mut level = depth;
    for component in target.components() {
        match component {
            Component::Normal(_) => level += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                if level == 0 {
                    return false;
                }
                level -= 1;
            }
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    true
}

/// Returns a SHA-256 digest of a skill directory's content. File permissions
/// and timestamps are not part of the digest.
///
/// # Errors
///
/// Returns the underlying error when the directory or a file cannot be read.
pub fn hash_dir(dir: &Path) -> io::Result<String> {
    let mut digest = Sha256::new();
    for entry in walk_tree(dir)? {
        match entry.kind {
            EntryKind::Link { target } => {
                digest.update(b"link\0");
                digest.update(entry.rel.as_bytes());
                digest.update(b"\0");
                digest.update(target.as_os_str().as_encoded_bytes());
                digest.update(b"\0");
            }
            EntryKind::File { .. } => {
                let mut file = fs::File::open(dir.join(&entry.rel))?;
                let mut file_digest = Sha256::new();
                io::copy(&mut file, &mut file_digest)?;
                digest.update(b"file\0");
                digest.update(entry.rel.as_bytes());
                digest.update(b"\0");
                digest.update(file_digest.finalize());
                digest.update(b"\0");
            }
        }
    }
    Ok(hex(&digest.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        // Writing to a String cannot fail.
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

/// Copies the skill at `src` into `dest`, which must not exist. The copy is
/// staged in a hidden sibling directory and renamed into place, so readers
/// never observe a half-written skill.
pub(crate) fn copy_tree(src: &Path, dest: &Path) -> io::Result<()> {
    let entries = walk_tree(src)?;
    let parent = dest
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".gandalf-staging-")
        .tempdir_in(parent)?;

    for entry in entries {
        let target = staging.path().join(&entry.rel);
        if let Some(target_parent) = target.parent() {
            fs::create_dir_all(target_parent)?;
        }
        match entry.kind {
            EntryKind::Link { target: link } => symlink(link, &target)?,
            EntryKind::File { mode } => {
                fs::copy(src.join(&entry.rel), &target)?;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode))?;
            }
        }
    }
    fs::set_permissions(staging.path(), fs::Permissions::from_mode(0o755))?;
    // The staging directory is removed on drop if the rename fails.
    fs::rename(staging.path(), dest)?;
    let _ = staging.keep();
    Ok(())
}

/// Copies everything under `src` to `dest` byte for byte, including symlinks
/// that leave the tree. Used only to preserve a displaced copy in trash.
pub(crate) fn copy_raw(src: &Path, dest: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(src)?;
    if metadata.file_type().is_symlink() {
        symlink(fs::read_link(src)?, dest)
    } else if metadata.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_raw(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dest).map(|_| ())
    }
}

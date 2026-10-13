//! Terminal styling for human-readable CLI output.
//!
//! Color is emitted only when the stream is a terminal and `NO_COLOR` is
//! unset, so pipes, files, and tests always get plain text.

use std::{
    fmt::Write as _,
    io::IsTerminal,
    path::{Path, PathBuf},
};

/// Styles text for one output stream.
#[derive(Clone, Copy, Debug)]
pub struct Palette {
    enabled: bool,
}

impl Palette {
    /// Styling for standard output.
    #[must_use]
    pub fn stdout() -> Self {
        Self {
            enabled: color_allowed() && std::io::stdout().is_terminal(),
        }
    }

    /// Styling for standard error.
    #[must_use]
    pub fn stderr() -> Self {
        Self {
            enabled: color_allowed() && std::io::stderr().is_terminal(),
        }
    }

    /// Never emits escape sequences.
    #[must_use]
    pub const fn plain() -> Self {
        Self { enabled: false }
    }

    fn paint(self, code: &str, text: &str) -> String {
        if self.enabled && !text.is_empty() {
            format!("\u{1b}[{code}m{text}\u{1b}[0m")
        } else {
            text.to_owned()
        }
    }

    #[must_use]
    pub fn bold(self, text: &str) -> String {
        self.paint("1", text)
    }

    /// Secondary text: hints, paths, absent values.
    #[must_use]
    pub fn dim(self, text: &str) -> String {
        self.paint("2", text)
    }

    #[must_use]
    pub fn good(self, text: &str) -> String {
        self.paint("32", text)
    }

    #[must_use]
    pub fn warn(self, text: &str) -> String {
        self.paint("33", text)
    }

    #[must_use]
    pub fn bad(self, text: &str) -> String {
        self.paint("31", text)
    }

    /// A command the reader can copy and run.
    #[must_use]
    pub fn command(self, text: &str) -> String {
        self.paint("36", text)
    }
}

fn color_allowed() -> bool {
    std::env::var_os("NO_COLOR").is_none_or(|value| value.is_empty())
        && std::env::var_os("TERM").is_none_or(|term| term != "dumb")
}

/// Lays rows out in left-aligned columns separated by two spaces. `style`
/// receives each cell after padding has been computed, so color never shifts
/// the alignment.
pub fn table(rows: &[Vec<String>], style: impl Fn(usize, usize, &str) -> String) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns)
        .map(|column| {
            rows.iter()
                .filter_map(|row| row.get(column))
                .map(|value| value.chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    let mut text = String::new();
    for (row_index, row) in rows.iter().enumerate() {
        let last = row.len().saturating_sub(1);
        for (column, (value, width)) in row.iter().zip(&widths).enumerate() {
            text.push_str(&style(row_index, column, value));
            if column < last {
                let padding = width.saturating_sub(value.chars().count()) + 2;
                // Writing to a String cannot fail.
                let _ = write!(text, "{:padding$}", "");
            }
        }
        text.push('\n');
    }
    text
}

/// Shortens a path under the home directory to `~/…` for display.
#[must_use]
pub fn tilde(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(relative) if relative.as_os_str().is_empty() => "~".to_owned(),
        Ok(relative) => PathBuf::from("~").join(relative).display().to_string(),
        Err(_) => path.display().to_string(),
    }
}

/// `1 skill`, `3 skills`.
#[must_use]
pub fn count(number: usize, noun: &str) -> String {
    if number == 1 {
        format!("1 {noun}")
    } else {
        format!("{number} {noun}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_aligns_columns_and_trims_the_last_cell() {
        let rows = vec![
            vec!["SKILL".to_owned(), "STATUS".to_owned()],
            vec!["code-review".to_owned(), "synced".to_owned()],
        ];
        let plain = table(&rows, |_, _, value| value.to_owned());
        assert_eq!(plain, "SKILL        STATUS\ncode-review  synced\n");
    }

    #[test]
    fn styling_cells_does_not_change_alignment() {
        let rows = vec![
            vec!["a".to_owned(), "x".to_owned()],
            vec!["bbb".to_owned(), "y".to_owned()],
        ];
        let styled = table(&rows, |_, column, value| {
            if column == 0 {
                format!("<{value}>")
            } else {
                value.to_owned()
            }
        });
        assert_eq!(styled, "<a>    x\n<bbb>  y\n");
    }

    #[test]
    fn plain_palette_never_emits_escapes() {
        let palette = Palette::plain();
        assert_eq!(palette.bad("failed"), "failed");
        assert_eq!(palette.bold("title"), "title");
    }

    #[test]
    fn tilde_shortens_only_paths_under_home() {
        let home = Path::new("/Users/alice");
        assert_eq!(
            tilde(Path::new("/Users/alice/.codex/skills"), home),
            "~/.codex/skills"
        );
        assert_eq!(tilde(home, home), "~");
        assert_eq!(tilde(Path::new("/etc/hosts"), home), "/etc/hosts");
    }

    #[test]
    fn count_pluralizes() {
        assert_eq!(count(1, "skill"), "1 skill");
        assert_eq!(count(12, "skill"), "12 skills");
        assert_eq!(count(0, "skill"), "0 skills");
    }
}

# Agent Guidance

- Check `CONCEPTS.md` for project-specific vocabulary before changing Gandalf product or architecture behavior.
- Check `docs/solutions/` for prior implementation learnings before making workflow or architecture changes (many entries describe the removed Go snapshot, restore, scan, and TUI subsystems and are historical; `docs/handoff/solutions/` covers the Rust handoff runtime); entries are organized by category and searchable through YAML fields such as `module`, `tags`, and `problem_type`.
- Add durable learnings with `ce-compound` when a change resolves a reusable project pattern or repeated failure mode.
- The CLI is a Rust workspace. Run `make lint` and `make test` before finishing; clippy runs with `-D warnings` and denies `unwrap`/`expect` outside tests.

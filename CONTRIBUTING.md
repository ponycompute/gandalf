# Contributing to Gandalf

Thanks for helping. Bug reports, fixes, and small features are all welcome.

## Before you start

- For anything larger than a bug fix, open an issue first so we can agree on the shape.
- Read [CONCEPTS.md](CONCEPTS.md) for the project's vocabulary and [ARCHITECTURE.md](ARCHITECTURE.md) for how the crates fit together.

## Building

The CLI is a Rust workspace and builds on macOS only (the runtime uses the keychain and launchd). The toolchain is pinned in `rust-toolchain.toml`.

```bash
make build   # release build of gandalf-cli
make lint    # rustfmt check and clippy with -D warnings
make test    # all workspace tests
```

Clippy denies `unwrap` and `expect` outside tests.

The landing page and docs live in `apps/` and use Bun:

```bash
bun install
bun run typecheck
bun run build
bun run test
```

## Pull requests

- Branch from `main` and keep each PR to one change.
- Write commit messages in [Conventional Commits](https://www.conventionalcommits.org/) form (`feat:`, `fix:`, `docs:`, `feat!:` for breaking changes). The release changelog is built from them.
- Run `make lint` and `make test` before pushing. CI runs the same checks.
- Fill in the PR template: what changed and why.

## Reporting security issues

Do not open a public issue for a vulnerability. Use [GitHub's private vulnerability reporting](https://github.com/ponycompute/gandalf/security/advisories/new) instead.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).

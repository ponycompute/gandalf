.PHONY: build test lint

build:
	cargo build --release --locked -p gandalf-cli

test:
	cargo test --workspace --all-features

lint:
	cargo fmt --all -- --check
	cargo clippy --workspace --all-targets --all-features -- -D warnings

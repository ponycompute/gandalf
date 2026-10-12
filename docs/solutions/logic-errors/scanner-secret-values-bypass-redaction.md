---
title: Record where secrets live at parse time instead of storing values that redaction might miss
date: 2026-10-12
category: logic-errors
module: gandalfcore-scan
problem_type: logic_error
component: tooling
symptoms:
  - "Codex `env = { KEY = \"value\" }` inline tables were stored as one raw string, so the literal token reached MCP evidence, `scan --json`, and `report --json`."
  - "The same inline table hid env key names, so cross-agent comparison reported 'different env keys' for identical servers."
  - "Claude Code user-scope MCP servers in ~/.claude.json were invisible to scan, overview, and drift checks because the file is metadata-only."
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - secrets
  - redaction
  - mcp-server
  - codex
  - claude-code
  - scan
---

# Record where secrets live at parse time instead of storing values that redaction might miss

## Context

Scanners redact secrets by rule: Codex keeps only `envKeys` for `[mcp_servers.x.env]`
sections, and secret-like key paths become `"[redacted]"`. Each rule matched one
syntax. TOML inline tables (`env = { ... }`, `http_headers = { ... }`) took a
different path through the hand-rolled parser and were stored verbatim, so the
redaction rules never ran.

Separately, `~/.claude.json` is deliberately metadata-only (it holds session state
and often exceeds `policy.MaxFileBytes`), which meant Claude Code's user-scope MCP
servers never became evidence at all.

## Guidance

- Normalize every syntax for a field into the same per-key path before applying
  redaction rules. Inline tables are expanded through `assignTOMLValue` key by key,
  and a table that cannot be parsed is never stored raw.
- Detect secrets while the value is still in hand, and store only the location
  (`env.GITHUB_TOKEN`, `URL credentials in args`) in evidence metadata as
  `plaintextSecrets`. Audit and the first-run overview read that list, so they can
  warn without the value ever being persisted. `policy.PlaintextSecretLocations`
  is the fallback for evidence whose value is still structured.
- For sensitive files, extract only the needed table with a targeted reader
  (`scanClaudeUserMCPServers`) and redact it with `policy.RedactMCPServerValue`
  (env values to `envKeys`, credential URLs and tokens in args to `"[redacted]"`).
  Mark that evidence `RestoreNotSupported`, because a redacted value cannot be
  written back.

## Known remaining gap

Whole-file `agent_config` evidence for `~/.codex/config.toml` still carries the raw
file content in `scan --json` and `report --json` output. The snapshot store does
not persist it, but the JSON outputs should eventually redact it too.

## Related

- [Scan targets and restore policy](../../../ARCHITECTURE.md)
- [First-Run Overview](../../../CONCEPTS.md#first-run-overview)

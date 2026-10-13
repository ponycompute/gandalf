#!/bin/sh
# Records real gandalf CLI output for the landing page terminals.
#
# Builds the CLI from this repo (or uses $GANDALF_BIN), runs the skill commands
# against a throwaway home directory, and writes src/data/terminal-sessions.json.
# The only edit to the output is replacing the temporary directory prefix with
# /Users/dev so paths read like a normal machine. Re-run after CLI output changes:
#
#   sh apps/landing/scripts/record-terminal.sh
#
# The CLI builds on macOS. Elsewhere, build it yourself and pass GANDALF_BIN.
set -eu

root=$(cd "$(dirname "$0")/../../.." && pwd)
out="$root/apps/landing/src/data/terminal-sessions.json"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "${GANDALF_BIN:-}" ]; then
  bin=$GANDALF_BIN
else
  (cd "$root" && cargo build --release -p gandalf-cli)
  bin="$root/target/release/gandalf"
fi

home="$tmp/Users/dev"
export HOME="$home" NO_COLOR=1
project="$home/acme/api"
mkdir -p "$home/.claude/skills" "$home/.codex/skills" "$home/.cursor/skills" "$project"
(cd "$project" && git init -q)

skill() { # dir name description body
  mkdir -p "$1"
  printf -- '---\nname: %s\ndescription: %s\n---\n%s\n' "$2" "$3" "$4" > "$1/SKILL.md"
}

# One skill everywhere, one only in Claude Code, one edited differently in Codex.
skill "$home/.claude/skills/code-review" code-review "Review a diff before it is pushed" "1. Read the diff."
cp -R "$home/.claude/skills/code-review" "$home/.codex/skills/"
cp -R "$home/.claude/skills/code-review" "$home/.cursor/skills/"
skill "$home/.claude/skills/pr-summary" pr-summary "Summarize a pull request" "Write a three-line summary."
skill "$home/.claude/skills/team-reviewer" team-reviewer "Review against the team style guide" "1. Check tests."
skill "$home/.codex/skills/team-reviewer" team-reviewer "Review against the team style guide" "1. Check tests.
2. Check naming against docs/style.md."
skill "$project/release-checklist" release-checklist "Prepare a release the way this repo does it" "1. Read commits since the last tag."

# Runs a command in the project and records it as one terminal step.
steps="$tmp/steps"
: > "$steps"
step() { # session command...
  session=$1
  shift
  set +e
  output=$(cd "$project" && "$bin" "$@" 2>&1)
  code=$?
  set -e
  printf '%s\t%s\t%s\t%s\n' "$session" "$(echo "gandalf $*" | sed 's/ *$//')" "$code" \
    "$(printf '%s' "$output" | sed "s#$tmp##g" | base64 | tr -d '\n')" >> "$steps"
}

step help --help
step list
step sync skill sync --dry-run
step sync skill sync
step resolve skill sync team-reviewer --from codex
step resolve
step show skill show team-reviewer
step add skill add ./release-checklist
step remove skill remove pr-summary

python3 - "$steps" "$out" <<'PY'
import base64, json, sys
sessions = {}
for line in open(sys.argv[1]):
    session, command, code, output = line.rstrip("\n").split("\t")
    sessions.setdefault(session, []).append({
        "command": command,
        "exitCode": int(code),
        "output": base64.b64decode(output).decode(),
    })
json.dump(sessions, open(sys.argv[2], "w"), indent=2, ensure_ascii=False)
open(sys.argv[2], "a").write("\n")
PY
echo "wrote $out"

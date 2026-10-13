#!/bin/sh
# Records real gandalf CLI output for the landing page terminals.
#
# Builds the CLI from this repo, runs it against a throwaway home directory and
# fixture repos, and writes src/data/terminal-sessions.json. The only edit to
# the output is replacing the temporary directory prefix with /Users/dev so the
# paths read like a normal machine. Re-run after CLI output changes:
#
#   sh apps/landing/scripts/record-terminal.sh
set -eu

root=$(cd "$(dirname "$0")/../../.." && pwd)
out="$root/apps/landing/src/data/terminal-sessions.json"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bin="$tmp/gandalf"
(cd "$root" && go build -o "$bin" ./cmd/gandalf)

home="$tmp/Users/dev"
export HOME="$home" GANDALF_STORE="$home/.gandalf" NO_COLOR=1
mkdir -p "$home/.claude/skills" "$home/.codex" "$home/.cursor"
echo '{}' > "$home/.claude/settings.json"
touch "$home/.codex/config.toml"

skill() { # dir name description
  mkdir -p "$1/$2"
  printf -- '---\nname: %s\ndescription: %s\n---\n' "$2" "$3" > "$1/$2/SKILL.md"
}

# Team repo with two skills. Claude Code already has one of them.
api="$home/acme/api"
mkdir -p "$api" && (cd "$api" && git init -q)
cat > "$api/gandalf.toml" <<'TOML'
version = "1.0"
name = "acme-api"
agents = ["claude-code", "codex", "cursor"]

[[skills]]
name = "team-reviewer"
source = "./.gandalf/skills/team-reviewer"

[[skills]]
name = "release-checklist"
source = "./.gandalf/skills/release-checklist"
TOML
skill "$api/.gandalf/skills" team-reviewer "Review PRs against the team style guide"
skill "$api/.gandalf/skills" release-checklist "Prepare a release the way this repo does it"
cp -R "$api/.gandalf/skills/team-reviewer" "$home/.claude/skills/"

# A second machine whose skills live only in agent folders, for export.
web="$home/acme/web"
mkdir -p "$web" && (cd "$web" && git init -q)
skill "$home/.claude/skills" db-migrations "Write and check a migration"

# Runs a command in a directory and records it as one terminal step.
steps="$tmp/steps"
: > "$steps"
step() { # session dir command...
  session=$1 dir=$2
  shift 2
  set +e
  output=$(cd "$dir" && "$bin" "$@" 2>&1)
  code=$?
  set -e
  printf '%s\t%s\t%s\t%s\n' "$session" "gandalf $*" "$code" \
    "$(printf '%s' "$output" | sed "s#$tmp##g" | base64 | tr -d '\n')" >> "$steps"
}

step help "$api" --help
step export "$web" export
step check "$api" check
step apply "$api" apply --yes
step apply "$api" check
snapshot=$("$bin" snapshot list | head -n 1)
step restore "$api" restore --snapshot "$snapshot" --apply --experimental
rm -rf "$api/.gandalf/skills/release-checklist"
step ci "$api" check --ci --project-only

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

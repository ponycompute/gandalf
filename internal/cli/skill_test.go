package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runCLI(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	cmd := NewRootCmd()
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), errOut.String(), err
}

func writeTestSkill(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCLISkillWorkflow(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	project := filepath.Join(base, "project")
	for _, dir := range []string{project, filepath.Join(home, ".claude"), filepath.Join(home, ".codex")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	common := []string{"--home", home, "--project", project}
	with := func(args ...string) []string { return append(args, common...) }

	out, _, err := runCLI(t, common...)
	if err != nil || !strings.Contains(out, "No skills found for Claude Code, Codex.") {
		t.Fatalf("empty overview: %q, %v", out, err)
	}

	src := filepath.Join(base, "reviewer")
	writeTestSkill(t, src, "---\ndescription: Reviews pull requests\n---\nv1\n")
	out, _, err = runCLI(t, with("skill", "add", src, "--agent", "claude-code")...)
	if err != nil || !strings.Contains(out, "installed") {
		t.Fatalf("add: %q, %v", out, err)
	}

	out, _, err = runCLI(t, common...)
	if err != nil || !strings.Contains(out, "partial") || !strings.Contains(out, "gandalf skill sync") {
		t.Fatalf("overview after add: %q, %v", out, err)
	}

	out, _, err = runCLI(t, with("skill", "sync", "--dry-run")...)
	if err != nil || !strings.Contains(out, "would install") {
		t.Fatalf("sync --dry-run: %q, %v", out, err)
	}
	if _, statErr := os.Stat(filepath.Join(home, ".codex", "skills", "reviewer")); !os.IsNotExist(statErr) {
		t.Fatal("dry run wrote the skill")
	}

	if out, _, err = runCLI(t, with("skill", "sync")...); err != nil {
		t.Fatalf("sync: %q, %v", out, err)
	}
	out, _, err = runCLI(t, with("skill", "list", "--json")...)
	if err != nil {
		t.Fatal(err)
	}
	var inv struct {
		Skills []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"skills"`
	}
	if jsonErr := json.Unmarshal([]byte(out), &inv); jsonErr != nil {
		t.Fatalf("list --json is not JSON: %v\n%s", jsonErr, out)
	}
	if len(inv.Skills) != 1 || inv.Skills[0].Status != "synced" {
		t.Fatalf("inventory after sync: %+v", inv.Skills)
	}

	out, _, err = runCLI(t, with("skill", "show", "reviewer")...)
	if err != nil || !strings.Contains(out, "Reviews pull requests") || !strings.Contains(out, "v1") {
		t.Fatalf("show: %q, %v", out, err)
	}

	// Diverge the Codex copy: sync must refuse and exit non-zero until --from.
	codexSkill := filepath.Join(home, ".codex", "skills", "reviewer", "SKILL.md")
	if err := os.WriteFile(codexSkill, []byte("local edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, _, err = runCLI(t, with("skill", "sync")...)
	if code, ok := IsExitError(err); !ok || code != 1 || !strings.Contains(out, "--from") {
		t.Fatalf("diverged sync should exit 1 with a --from hint: %q, %v", out, err)
	}
	if out, _, err = runCLI(t, with("skill", "sync", "reviewer", "--from", "claude-code")...); err != nil || !strings.Contains(out, "replaced") {
		t.Fatalf("sync --from: %q, %v", out, err)
	}
	if entries, _ := os.ReadDir(filepath.Join(home, ".gandalf", "trash")); len(entries) != 1 {
		t.Fatalf("expected the overwritten copy in trash, got %d entries", len(entries))
	}

	if out, _, err = runCLI(t, with("skill", "remove", "reviewer")...); err != nil || !strings.Contains(out, "removed") {
		t.Fatalf("remove: %q, %v", out, err)
	}
	if out, _, _ = runCLI(t, common...); !strings.Contains(out, "No skills found") {
		t.Fatalf("overview after remove: %q", out)
	}
}

func TestCLISkillRejectsBadInput(t *testing.T) {
	home := t.TempDir()
	cases := [][]string{
		{"skill", "list", "--agent", "vim"},
		{"skill", "list", "--scope", "managed"},
		{"skill", "sync", "--scope", "all"},
		{"skill", "show", "missing"},
		{"skill", "remove", "missing"},
	}
	for _, args := range cases {
		_, errOut, err := runCLI(t, append(args, "--home", home, "--project", home)...)
		if code, ok := IsExitError(err); !ok || code != 1 || !strings.Contains(errOut, "Fix:") {
			t.Errorf("%v: err=%v stderr=%q", args, err, errOut)
		}
	}
}

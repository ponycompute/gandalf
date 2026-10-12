package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qyinm/gandalf/internal/gandalfcore/store"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"

	_ "github.com/qyinm/gandalf/internal/gandalfcore/scan/plugins"
)

func makeSandbox(t *testing.T) (projectPath, homeDir, storeDir string) {
	t.Helper()
	root := t.TempDir()
	projectPath = filepath.Join(root, "project")
	homeDir = filepath.Join(root, "home")
	storeDir = filepath.Join(homeDir, ".gandalf")
	if err := os.MkdirAll(projectPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(homeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return projectPath, homeDir, storeDir
}

func runCLI(t *testing.T, args ...string) (stdout, stderr string, exitCode int) {
	t.Helper()
	cmd := NewRootCmd()
	var outBuf, errBuf bytes.Buffer
	cmd.SetOut(&outBuf)
	cmd.SetErr(&errBuf)
	cmd.SetArgs(args)
	err := cmd.Execute()
	exitCode = 0
	if err != nil {
		if code, ok := IsExitError(err); ok {
			exitCode = code
		} else {
			exitCode = 1
		}
	}
	return outBuf.String(), errBuf.String(), exitCode
}

func TestScanJSONExitsZeroWithEvidence(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, _ := makeSandbox(t)

	stdout, stderr, code := runCLI(t,
		"scan",
		"--project", projectPath,
		"--home", homeDir,
		"--agent", "codex",
		"--scope", "user",
		"--json",
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr)
	}

	var result types.ScanResult
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("stdout is not valid scan JSON: %v\nstdout=%q", err, stdout)
	}
	if result.Trust.ReadOnly != true {
		t.Fatalf("expected read-only scan, got %#v", result.Trust)
	}
}

func TestInvalidAgentReturnsExitOne(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, _ := makeSandbox(t)

	_, stderr, code := runCLI(t,
		"scan",
		"--project", projectPath,
		"--home", homeDir,
		"--agent", "not-a-real-agent",
	)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stderr, "GANDALF_INVALID_AGENT") {
		t.Fatalf("expected GANDALF_INVALID_AGENT in stderr, got %q", stderr)
	}
	if !strings.Contains(stderr, "Valid agents: claude-code, codex") {
		t.Fatalf("expected current supported agent list, got %q", stderr)
	}
}

func TestUnsupportedCurrentAgentReturnsExitOne(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, _ := makeSandbox(t)

	_, stderr, code := runCLI(t,
		"scan",
		"--project", projectPath,
		"--home", homeDir,
		"--agent", "opencode",
	)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stderr, "GANDALF_INVALID_AGENT") {
		t.Fatalf("expected GANDALF_INVALID_AGENT in stderr, got %q", stderr)
	}
	if !strings.Contains(stderr, "Valid agents: claude-code, codex, cursor") {
		t.Fatalf("expected current supported agent list, got %q", stderr)
	}
}

func TestInvalidScopeReturnsExitOne(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, _ := makeSandbox(t)

	_, stderr, code := runCLI(t,
		"scan",
		"--project", projectPath,
		"--home", homeDir,
		"--scope", "galaxy",
	)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stderr, "GANDALF_INVALID_SCOPE") {
		t.Fatalf("expected GANDALF_INVALID_SCOPE in stderr, got %q", stderr)
	}
}

func TestSnapshotCreateMetadataOnly(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, storeDir := makeSandbox(t)

	stdout, stderr, code := runCLI(t,
		"snapshot", "create",
		"--name", "baseline",
		"--metadata-only",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr)
	}
	if !strings.Contains(stdout, "Created metadata-only snapshot: baseline") {
		t.Fatalf("unexpected stdout: %q", stdout)
	}

	exists, err := store.SnapshotExists(storeDir, "baseline", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("expected baseline snapshot to exist")
	}
}

func TestSnapshotCreateRequiresMetadataOnlyByDefault(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, storeDir := makeSandbox(t)

	_, stderr, code := runCLI(t,
		"snapshot", "create",
		"--name", "baseline",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stderr, "GANDALF_METADATA_ONLY_REQUIRED") {
		t.Fatalf("expected metadata-only error, got %q", stderr)
	}
}

func TestSnapshotCreateClaudeCodeUserScopeIsContentBacked(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, storeDir := makeSandbox(t)
	settingsPath := filepath.Join(homeDir, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	settings := `{"permissions":{"allow":["Bash(echo hi)"]}}`
	if err := os.WriteFile(settingsPath, []byte(settings), 0o644); err != nil {
		t.Fatal(err)
	}

	stdout, stderr, code := runCLI(t,
		"snapshot", "create",
		"--name", "clean-claude",
		"--agent", "claude-code",
		"--scope", "user",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr)
	}
	if !strings.Contains(stdout, "Created content-backed snapshot: clean-claude (agent: claude-code) (scope: user)") {
		t.Fatalf("unexpected stdout: %q", stdout)
	}

	agent := types.AgentClaudeCode
	snap, err := store.ReadSnapshot(storeDir, "clean-claude", &agent)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range snap.Content {
		if entry.SourcePath == "~/.claude/settings.json" && entry.CaptureStatus == "captured" {
			got, err := store.ReadSnapshotContent(storeDir, "clean-claude", entry, &agent)
			if err != nil {
				t.Fatal(err)
			}
			if got == settings {
				return
			}
			t.Fatalf("settings content = %q, want %q", got, settings)
		}
	}
	t.Fatalf("expected content-backed Claude settings entry, got %#v", snap.Content)
}

func TestDiffCurrentJSONExitsZero(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, storeDir := makeSandbox(t)

	if _, stderr, code := runCLI(t,
		"snapshot", "create",
		"--name", "baseline",
		"--metadata-only",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	); code != 0 {
		t.Fatalf("snapshot create failed: code=%d stderr=%q", code, stderr)
	}

	stdout, stderr, code := runCLI(t,
		"diff", "baseline", "current",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
		"--json",
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr)
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("diff output is not JSON: %v\nstdout=%q", err, stdout)
	}
	if _, ok := payload["semanticChanges"]; !ok {
		t.Fatalf("expected semanticChanges in diff JSON, got %q", stdout)
	}
}

func TestRestoreDryRunDefaultWithoutApply(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, storeDir := makeSandbox(t)

	if _, stderr, code := runCLI(t,
		"snapshot", "create",
		"--name", "baseline",
		"--metadata-only",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	); code != 0 {
		t.Fatalf("snapshot create failed: code=%d stderr=%q", code, stderr)
	}

	stdout, stderr, code := runCLI(t,
		"restore",
		"--snapshot", "baseline",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	)
	if code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr)
	}
	if !strings.Contains(stdout, "gandalf restore dry-run") {
		t.Fatalf("expected dry-run preview, got %q", stdout)
	}
	if !strings.Contains(stdout, "No files were changed.") {
		t.Fatalf("expected no-mutation notice, got %q", stdout)
	}
}

func TestRestoreApplyWithoutExperimentalRejected(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, storeDir := makeSandbox(t)

	if _, stderr, code := runCLI(t,
		"snapshot", "create",
		"--name", "baseline",
		"--metadata-only",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	); code != 0 {
		t.Fatalf("snapshot create failed: code=%d stderr=%q", code, stderr)
	}

	_, stderr, code := runCLI(t,
		"restore",
		"--snapshot", "baseline",
		"--apply",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stderr, "GANDALF_EXPERIMENTAL_REQUIRED") {
		t.Fatalf("expected experimental gate error, got %q", stderr)
	}
}

func TestTUISubcommandLaunchesConsoleWithRuntime(t *testing.T) {
	t.Parallel()

	projectPath, homeDir, storeDir := makeSandbox(t)
	expectedProjectPath := projectPath
	if abs, err := filepath.Abs(projectPath); err == nil {
		if resolved, err := filepath.EvalSymlinks(abs); err == nil {
			expectedProjectPath = resolved
		} else {
			expectedProjectPath = abs
		}
	}
	originalLaunch := cliLaunchTUIForTest(t, func(runtime types.RuntimeOptions) int {
		if runtime.ProjectPath != expectedProjectPath {
			t.Fatalf("project path = %q, want %q", runtime.ProjectPath, expectedProjectPath)
		}
		if runtime.HomeDir != homeDir {
			t.Fatalf("home dir = %q, want %q", runtime.HomeDir, homeDir)
		}
		if runtime.StoreDir != storeDir {
			t.Fatalf("store dir = %q, want %q", runtime.StoreDir, storeDir)
		}
		return 0
	})
	defer originalLaunch()

	stdout, stderr, code := runCLI(t,
		"tui",
		"--project", projectPath,
		"--home", homeDir,
		"--store", storeDir,
	)
	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if stdout != "" {
		t.Fatalf("expected no stdout from TUI launch stub, got %q", stdout)
	}
	if stderr != "" {
		t.Fatalf("expected no stderr from TUI launch stub, got %q", stderr)
	}
}

func cliLaunchTUIForTest(t *testing.T, fn func(types.RuntimeOptions) int) func() {
	t.Helper()
	previous := launchTUI
	launchTUI = fn
	return func() {
		launchTUI = previous
	}
}

func TestBundleExportRequiresSnapshot(t *testing.T) {
	t.Parallel()
	_, stderr, code := runCLI(t,
		"bundle", "export",
		"--name", "baseline",
		"--out", "test.gandalf",
	)
	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	if !strings.Contains(stderr, "GANDALF_BUNDLE_EXPORT_FAILED") {
		t.Fatalf("expected bundle export error, got %q", stderr)
	}
}

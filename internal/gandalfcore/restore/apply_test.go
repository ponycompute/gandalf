package restore_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/qyinm/gandalf/internal/gandalfcore/pathconfinement"
	"github.com/qyinm/gandalf/internal/gandalfcore/restore"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

func makeItem(
	itemID, itemType, dest string,
	action types.RestoreAction,
	targetContent json.RawMessage,
	metadata json.RawMessage,
) types.RestoreItem {
	return types.RestoreItem{
		ItemID:         itemID,
		Path:           dest,
		ItemType:       itemType,
		Source:         dest,
		Dest:           dest,
		Action:         &action,
		Status:         types.RestoreItemStatusPending,
		ExecutionOrder: 1,
		TargetContent:  targetContent,
		CanRollback:    true,
		Metadata:       metadata,
	}
}

func TestWritesAgentConfigContentWithoutAppendingNewline(t *testing.T) {
	t.Parallel()
	_, homeDir, _ := makeRestoreSandbox(t)
	configPath := filepath.Join(homeDir, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	action := types.RestoreActionUpdate
	content, _ := json.Marshal("model = \"gpt-5\"")
	item := makeItem("config", "agent_config", configPath, action, content, nil)
	if err := restore.ApplyAgentConfig(&item); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "model = \"gpt-5\"" {
		t.Fatalf("got %q", string(got))
	}
}

func TestApplyAgentConfigPreservesExistingFileMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permissions test")
	}
	t.Parallel()
	_, homeDir, _ := makeRestoreSandbox(t)
	configPath := filepath.Join(homeDir, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("model = \"old\""), 0o600); err != nil {
		t.Fatal(err)
	}

	action := types.RestoreActionUpdate
	content, _ := json.Marshal("model = \"gpt-5\"")
	item := makeItem("config", "agent_config", configPath, action, content, nil)
	if err := restore.ApplyAgentConfig(&item); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %o, want 0600", got)
	}
}

func TestDefaultRegistryDispatchesMCPPermissionAndEnvHandlers(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, _ := makeRestoreSandbox(t)
	if err := os.MkdirAll(filepath.Join(homeDir, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	envPath := filepath.Join(projectPath, ".env")
	mcpPath := filepath.Join(projectPath, ".mcp.json")
	settingsPath := filepath.Join(homeDir, ".claude", "settings.json")

	cases := []struct {
		itemType string
		item     types.RestoreItem
	}{
		{
			"mcp_server",
			makeItem(
				"mcp_server:docs:abcd1234",
				"mcp_server",
				mcpPath,
				types.RestoreActionUpdate,
				json.RawMessage(`{"command":"x"}`),
				json.RawMessage(`{"serverName":"docs","mcpPath":"`+mcpPath+`"}`),
			),
		},
		{
			"permission",
			makeItem(
				"home.claude_code.~/.claude/settings.json.perm-bash",
				"permission",
				settingsPath,
				types.RestoreActionUpdate,
				json.RawMessage(`{"rule":{"allow":[]}}`),
				json.RawMessage(`{"permissionKey":"bash"}`),
			),
		},
		{
			"env_key",
			makeItem(
				"env_key.TEST",
				"env_key",
				filepath.Join(projectPath, "env:TEST"),
				types.RestoreActionUpdate,
				json.RawMessage(`"v"`),
				nil,
			),
		},
	}

	for _, tc := range cases {
		item := tc.item
		if err := restore.DispatchDefaultApply(&item); err != nil {
			t.Fatalf("handler for %s failed: %v", tc.itemType, err)
		}
	}
	_ = restore.DefaultApplyHandlerRegistry()
	if _, err := os.Stat(envPath); err != nil {
		t.Fatalf("env file missing: %v", err)
	}
}

func TestAppliesMCPServerToProjectMCPJSON(t *testing.T) {
	t.Parallel()
	projectPath, _, _ := makeRestoreSandbox(t)
	mcpPath := filepath.Join(projectPath, ".mcp.json")
	if err := os.WriteFile(mcpPath, []byte("{\n  \"mcpServers\": {}\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	item := makeItem(
		"mcp_server:docs:abcd1234",
		"mcp_server",
		mcpPath,
		types.RestoreActionUpdate,
		json.RawMessage(`{"command":"docs-old","args":[]}`),
		json.RawMessage(`{"serverName":"docs","mcpPath":"`+mcpPath+`"}`),
	)
	if err := restore.ApplyMCPServer(&item); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(mcpPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(written)
	if !strings.Contains(text, `"docs"`) || !strings.Contains(text, "docs-old") {
		t.Fatalf("mcp = %s", text)
	}
}

func TestApplyMCPServerIgnoresMetadataPathOverride(t *testing.T) {
	t.Parallel()
	projectPath, _, _ := makeRestoreSandbox(t)
	mcpPath := filepath.Join(projectPath, ".mcp.json")
	if err := os.WriteFile(mcpPath, []byte("{\n  \"mcpServers\": {}\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	outsidePath := filepath.Join(projectPath, "nested", "override", ".mcp.json")
	item := makeItem(
		"mcp_server:docs:abcd1234",
		"mcp_server",
		mcpPath,
		types.RestoreActionUpdate,
		json.RawMessage(`{"command":"docs-old","args":[]}`),
		json.RawMessage(`{"serverName":"docs","mcpPath":"`+outsidePath+`"}`),
	)
	if err := restore.ApplyMCPServer(&item); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(outsidePath); !os.IsNotExist(err) {
		t.Fatalf("override path should stay untouched, got %v", err)
	}
	written, err := os.ReadFile(mcpPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), "docs-old") {
		t.Fatalf("mcp = %s", string(written))
	}
}

func TestAppliesPermissionRuleToSettingsJSON(t *testing.T) {
	t.Parallel()
	_, homeDir, _ := makeRestoreSandbox(t)
	settingsPath := filepath.Join(homeDir, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath, []byte("{\n  \"permissions\": {}\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	item := makeItem(
		"home.claude_code.~/.claude/settings.json.perm-bash",
		"permission",
		settingsPath,
		types.RestoreActionUpdate,
		json.RawMessage(`{"rule":{"allow":["Bash"]}}`),
		json.RawMessage(`{"permissionKey":"bash"}`),
	)
	if err := restore.ApplyPermission(&item); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(written, &parsed); err != nil {
		t.Fatal(err)
	}
	permissions := parsed["permissions"].(map[string]any)
	bashRule := permissions["bash"].(map[string]any)
	allow, _ := bashRule["allow"].([]any)
	if len(allow) != 1 {
		t.Fatalf("allow = %#v", allow)
	}
	if _, hasRule := bashRule["rule"]; hasRule {
		t.Fatal("rule wrapper must not be written")
	}
	if !strings.Contains(string(written), "Bash") {
		t.Fatalf("settings = %s", string(written))
	}
}

func TestAppliesEnvKeyToProjectDotenv(t *testing.T) {
	t.Parallel()
	projectPath, _, _ := makeRestoreSandbox(t)
	envPath := filepath.Join(projectPath, ".env")

	item := makeItem(
		"env_key.API_KEY",
		"env_key",
		filepath.Join(projectPath, "env:API_KEY"),
		types.RestoreActionUpdate,
		json.RawMessage(`"secret-value"`),
		nil,
	)
	if err := restore.DispatchDefaultApply(&item); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), "API_KEY=secret-value") {
		t.Fatalf("env = %s", string(written))
	}
}

func TestRejectsRestoreApplyOutsideConfinementRoots(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, _ := makeRestoreSandbox(t)
	outside := "/etc/gandalf-restore-test-target"
	item := makeItem(
		"agent_config:outside",
		"agent_config",
		outside,
		types.RestoreActionUpdate,
		json.RawMessage(`"should-not-write"`),
		nil,
	)
	summary := restore.ApplyRestoreItems(
		[]types.RestoreItem{item},
		restore.CreateDefaultApplyExecutor(),
		&types.ApplyOptions{
			FailFast:    true,
			HomeDir:     &homeDir,
			ProjectPath: &projectPath,
		},
	)
	if summary.Successful != 0 || summary.Failed != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if len(summary.Failures) == 0 || !strings.Contains(summary.Failures[0].Reason, "outside home and project") {
		t.Fatalf("failures = %#v", summary.Failures)
	}
}

func TestMCPApplySetsMCPConfigForUndo(t *testing.T) {
	t.Parallel()
	projectPath, _, _ := makeRestoreSandbox(t)
	mcpPath := filepath.Join(projectPath, ".mcp.json")
	if err := os.WriteFile(mcpPath, []byte("{\n  \"mcpServers\": {}\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	item := makeItem(
		"mcp_server:docs:abcd1234",
		"mcp_server",
		mcpPath,
		types.RestoreActionUpdate,
		json.RawMessage(`{"command":"x"}`),
		json.RawMessage(`{"serverName":"docs","mcpPath":"`+mcpPath+`"}`),
	)
	if err := restore.ApplyMCPServer(&item); err != nil {
		t.Fatal(err)
	}
	if len(item.RollbackState) == 0 {
		t.Fatal("rollback state missing")
	}
	var state map[string]any
	if err := json.Unmarshal(item.RollbackState, &state); err != nil {
		t.Fatal(err)
	}
	if state["mcpConfig"] == nil {
		t.Fatal("mcpConfig missing from rollback state")
	}
	if state["envPath"] != nil {
		t.Fatal("envPath should not be set for mcp rollback")
	}
}

func TestApplyWithRollbackRestoresMCPJSONAfterApply(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, _ := makeRestoreSandbox(t)
	mcpPath := filepath.Join(projectPath, ".mcp.json")
	baseline := "{\n  \"mcpServers\": {\n    \"docs\": { \"command\": \"baseline\" }\n  }\n}\n"
	if err := os.WriteFile(mcpPath, []byte(baseline), 0o644); err != nil {
		t.Fatal(err)
	}

	item := makeItem(
		"mcp_server:docs:abcd1234",
		"mcp_server",
		mcpPath,
		types.RestoreActionUpdate,
		json.RawMessage(`{"command":"changed"}`),
		json.RawMessage(`{"serverName":"docs","mcpPath":"`+mcpPath+`"}`),
	)
	rollback := true
	result := restore.ApplyWithRollback(
		[]types.RestoreItem{item},
		restore.CreateDefaultApplyExecutor(),
		restore.CreateDefaultUndoExecutor(),
		&types.ApplyOptions{
			FailFast:    true,
			Rollback:    &rollback,
			HomeDir:     &homeDir,
			ProjectPath: &projectPath,
		},
	)
	if result.ApplySummary.Successful != 1 {
		t.Fatalf("apply summary = %+v", result.ApplySummary)
	}
	if result.RollbackSummary == nil {
		t.Fatal("rollback summary missing")
	}

	restoredRaw, err := os.ReadFile(mcpPath)
	if err != nil {
		t.Fatal(err)
	}
	var restored, expected map[string]any
	if err := json.Unmarshal(restoredRaw, &restored); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(baseline), &expected); err != nil {
		t.Fatal(err)
	}
	restoredJSON, _ := json.Marshal(restored)
	expectedJSON, _ := json.Marshal(expected)
	if string(restoredJSON) != string(expectedJSON) {
		t.Fatalf("restored = %s", string(restoredJSON))
	}
}

func TestRollbackMCPUsesAppliedPathInsteadOfMetadataOverride(t *testing.T) {
	t.Parallel()
	projectPath, homeDir, _ := makeRestoreSandbox(t)
	mcpPath := filepath.Join(projectPath, ".mcp.json")
	outsidePath := filepath.Join(projectPath, "nested", "override", ".mcp.json")
	baseline := "{\n  \"mcpServers\": {\n    \"docs\": { \"command\": \"baseline\" }\n  }\n}\n"
	if err := os.WriteFile(mcpPath, []byte(baseline), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(outsidePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outsidePath, []byte("{\"mcpServers\":{\"docs\":{\"command\":\"outside\"}}}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	item := makeItem(
		"mcp_server:docs:abcd1234",
		"mcp_server",
		mcpPath,
		types.RestoreActionUpdate,
		json.RawMessage(`{"command":"changed"}`),
		json.RawMessage(`{"serverName":"docs","mcpPath":"`+outsidePath+`"}`),
	)
	rollback := true
	result := restore.ApplyWithRollback(
		[]types.RestoreItem{item},
		restore.CreateDefaultApplyExecutor(),
		restore.CreateDefaultUndoExecutor(),
		&types.ApplyOptions{
			FailFast:    true,
			Rollback:    &rollback,
			HomeDir:     &homeDir,
			ProjectPath: &projectPath,
		},
	)
	if result.RollbackSummary == nil || result.RollbackSummary.Failed != 0 {
		t.Fatalf("rollback summary = %+v", result.RollbackSummary)
	}

	restoredRaw, err := os.ReadFile(mcpPath)
	if err != nil {
		t.Fatal(err)
	}
	var restored, expected map[string]any
	if err := json.Unmarshal(restoredRaw, &restored); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(baseline), &expected); err != nil {
		t.Fatal(err)
	}
	restoredJSON, _ := json.Marshal(restored)
	expectedJSON, _ := json.Marshal(expected)
	if string(restoredJSON) != string(expectedJSON) {
		t.Fatalf("restored = %s", string(restoredRaw))
	}
	outsideRaw, err := os.ReadFile(outsidePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(outsideRaw), "outside") {
		t.Fatalf("override path was modified: %s", string(outsideRaw))
	}
}

func TestValidateConstrainedWritePathRejectsBlockedHomePrefix(t *testing.T) {
	t.Parallel()
	roots := &pathconfinement.Roots{
		HomeDir:     "/home/user",
		ProjectPath: "/home/user/project",
	}
	_, err := pathconfinement.ValidateConstrainedWritePath("/home/user/.ssh/id_rsa", roots)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "blocked") {
		t.Fatalf("expected blocked error, got %v", err)
	}
}

func TestApplyMCPServerRefusesRedactedSnapshotValues(t *testing.T) {
	t.Parallel()
	for name, target := range map[string]string{
		"masked credential": `{"command":"npx","args":["postgresql://u:[redacted]@db/x"]}`,
		"env reduced":       `{"command":"npx","envKeys":["GITHUB_TOKEN"]}`,
	} {
		t.Run(name, func(t *testing.T) {
			projectPath, _, _ := makeRestoreSandbox(t)
			mcpPath := filepath.Join(projectPath, ".mcp.json")
			original := "{\n  \"mcpServers\": {\"docs\": {\"command\": \"npx\", \"env\": {\"GITHUB_TOKEN\": \"real\"}}}\n}\n"
			if err := os.WriteFile(mcpPath, []byte(original), 0o644); err != nil {
				t.Fatal(err)
			}

			item := makeItem(
				"mcp_server:docs:abcd1234",
				"mcp_server",
				mcpPath,
				types.RestoreActionUpdate,
				json.RawMessage(target),
				json.RawMessage(`{"serverName":"docs","mcpPath":"`+mcpPath+`"}`),
			)
			err := restore.ApplyMCPServer(&item)
			if err == nil || !strings.Contains(err.Error(), "redacted copy") {
				t.Fatalf("expected a fail-closed refusal, got %v", err)
			}
			written, readErr := os.ReadFile(mcpPath)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if string(written) != original {
				t.Fatalf("config must stay untouched, got:\n%s", written)
			}
		})
	}
}

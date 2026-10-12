package restore

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/qyinm/gandalf/internal/gandalfcore/fsutil"
	"github.com/qyinm/gandalf/internal/gandalfcore/pathconfinement"
	"github.com/qyinm/gandalf/internal/gandalfcore/policy"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

// RestoreExecutor applies a single restore item.
type RestoreExecutor func(item *types.RestoreItem) error

// UndoExecutor rolls back a single restore item.
type UndoExecutor func(item *types.RestoreItem) error

// ApplyRestoreItems executes restore items in execution order with path confinement.
func ApplyRestoreItems(
	items []types.RestoreItem,
	executor RestoreExecutor,
	options *types.ApplyOptions,
) types.ApplySummary {
	summary := types.ApplySummary{
		Total:          uint32(len(items)),
		StatusRegistry: make(map[string]types.RestoreItemStatus),
	}

	indices := make([]int, len(items))
	for i := range indices {
		indices[i] = i
	}
	sortIndicesByOrder(indices, items)

	stoppedEarly := false
	for _, index := range indices {
		item := &items[index]
		if item.Status == types.RestoreItemStatusUnsupported {
			summary.StatusRegistry[item.ItemID] = item.Status
			summary.Unsupported++
			continue
		}
		if item.Status == types.RestoreItemStatusSkipped {
			summary.StatusRegistry[item.ItemID] = item.Status
			summary.Skipped++
			continue
		}

		roots := pathconfinement.RootsFromPaths(options.HomeDir, options.ProjectPath)
		if roots == nil {
			recordApplyFailure(item, &summary, "restore apply requires home and project roots for path confinement")
			if options.FailFast {
				stoppedEarly = true
				break
			}
			continue
		}
		if _, err := pathconfinement.ValidateConstrainedWritePath(item.Dest, roots); err != nil {
			recordApplyFailure(item, &summary, err.Error())
			if options.FailFast {
				stoppedEarly = true
				break
			}
			continue
		}

		if err := executor(item); err != nil {
			recordApplyFailure(item, &summary, err.Error())
			if options.FailFast {
				stoppedEarly = true
				break
			}
			continue
		}

		now := time.Now().UTC().Format(time.RFC3339)
		item.Status = types.RestoreItemStatusApplied
		item.ApplyAt = &now
		summary.StatusRegistry[item.ItemID] = item.Status
		summary.Successful++
		summary.AppliedItems = append(summary.AppliedItems, *item)
	}

	if stoppedEarly {
		for i := range items {
			item := &items[i]
			if item.Status == types.RestoreItemStatusPending {
				item.Status = types.RestoreItemStatusSkipped
				reason := "Execution stopped before this item"
				item.SkipReason = &reason
				summary.StatusRegistry[item.ItemID] = item.Status
				summary.Skipped++
			} else if item.Status == types.RestoreItemStatusUnsupported {
				if _, tracked := summary.StatusRegistry[item.ItemID]; !tracked {
					summary.Unsupported++
					summary.StatusRegistry[item.ItemID] = item.Status
				}
			}
		}
		summary.Total = uint32(len(items))
	}

	return summary
}

// FormatApplySummary renders a human-readable apply summary.
func FormatApplySummary(summary *types.ApplySummary) string {
	lines := []string{
		"Restore apply results",
		"",
		fmt.Sprintf("  Successful: %d", summary.Successful),
		fmt.Sprintf("  Failed:     %d", summary.Failed),
		fmt.Sprintf("  Skipped:    %d", summary.Skipped),
		fmt.Sprintf("  Unsupported: %d", summary.Unsupported),
		fmt.Sprintf("  Total:      %d", summary.Total),
	}
	if len(summary.Failures) > 0 {
		lines = append(lines, "", "Failures:")
		for _, failure := range summary.Failures {
			lines = append(lines, fmt.Sprintf("  [%s] %s", failure.ItemID, failure.Reason))
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

func writeFileAtomically(filePath, content string) error {
	mode := os.FileMode(0o644)
	if info, err := os.Lstat(filePath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to write through symlink destination: %s", filePath)
		}
		mode = info.Mode().Perm()
	}
	return fsutil.WriteTextAtomically(filePath, content, mode)
}

func recordApplyFailure(item *types.RestoreItem, summary *types.ApplySummary, reason string) {
	item.Status = types.RestoreItemStatusFailed
	item.ErrorMessage = &reason
	summary.StatusRegistry[item.ItemID] = item.Status
	summary.Failed++
	summary.Failures = append(summary.Failures, types.ApplyFailure{
		ItemID: item.ItemID,
		Reason: reason,
	})
}

func readCurrentContent(filePath string) *string {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil
	}
	text := string(data)
	return &text
}

func applyFileMutation(
	item *types.RestoreItem,
	filePath string,
	content *string,
	mode *os.FileMode,
	forceWrite bool,
) error {
	prev := readCurrentContent(filePath)
	rollback := map[string]any{
		"filePath":        filePath,
		"previousContent": prev,
	}
	rollbackBytes, _ := json.Marshal(rollback)
	item.RollbackState = rollbackBytes

	if item.Action != nil && *item.Action == types.RestoreActionDelete && !forceWrite {
		if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if content == nil {
		return fmt.Errorf("Missing target content for %s", item.ItemID)
	}
	if info, err := os.Lstat(filePath); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to write through symlink destination: %s", filePath)
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return err
	}
	if err := writeFileAtomically(filePath, *content); err != nil {
		return err
	}
	if mode != nil {
		if err := os.Chmod(filePath, *mode); err != nil {
			return err
		}
	}
	return nil
}

// ApplyAgentConfig writes content-backed agent config files.
func ApplyAgentConfig(item *types.RestoreItem) error {
	if len(item.TargetContent) == 0 {
		return fmt.Errorf("Missing target content for %s", item.ItemID)
	}
	var text string
	if err := json.Unmarshal(item.TargetContent, &text); err != nil {
		return fmt.Errorf(
			"Refusing to apply parsed metadata as file content for %s — snapshot needs content-backed capture",
			item.ItemID,
		)
	}
	return applyFileMutation(item, item.Dest, &text, nil, false)
}

// ApplyAgentInstruction writes agent instruction files.
func ApplyAgentInstruction(item *types.RestoreItem) error {
	text := ""
	if len(item.TargetContent) > 0 {
		_ = json.Unmarshal(item.TargetContent, &text)
	}
	return applyFileMutation(item, item.Dest, &text, nil, false)
}

// ApplyHook writes executable hook files.
func ApplyHook(item *types.RestoreItem) error {
	text := ""
	if len(item.TargetContent) > 0 {
		_ = json.Unmarshal(item.TargetContent, &text)
	}
	mode := os.FileMode(0o755)
	return applyFileMutation(item, item.Dest, &text, &mode, false)
}

// ApplySkill writes or deletes skill files.
func ApplySkill(item *types.RestoreItem) error {
	if item.Action != nil && *item.Action == types.RestoreActionDelete {
		return applyFileMutation(item, item.Dest, nil, nil, false)
	}
	if len(item.TargetContent) == 0 {
		return fmt.Errorf("missing target content for %s", item.ItemID)
	}
	var text string
	if err := json.Unmarshal(item.TargetContent, &text); err != nil {
		var value any
		if json.Unmarshal(item.TargetContent, &value) != nil {
			return fmt.Errorf("missing target content for %s", item.ItemID)
		}
		pretty, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		text = string(pretty)
	}
	return applyFileMutation(item, item.Dest, &text, nil, false)
}

func mcpConfigPathForItem(item *types.RestoreItem) string {
	dest := item.Dest
	if filepath.Base(dest) == ".mcp.json" {
		return dest
	}
	return filepath.Join(filepath.Dir(dest), ".mcp.json")
}

func mcpServerNameForItem(item *types.RestoreItem) string {
	if len(item.Metadata) > 0 {
		var metadata map[string]any
		if json.Unmarshal(item.Metadata, &metadata) == nil {
			if name, ok := metadata["serverName"].(string); ok && name != "" {
				return name
			}
		}
	}
	parts := strings.Split(item.ItemID, ":")
	if len(parts) >= 2 && parts[1] != "" {
		return parts[1]
	}
	segments := strings.Split(item.ItemID, ".")
	if len(segments) > 0 {
		return segments[len(segments)-1]
	}
	return "unknown"
}

// ApplyMCPServer mutates project or home MCP JSON config.
func ApplyMCPServer(item *types.RestoreItem) error {
	mcpPath := mcpConfigPathForItem(item)
	serverName := mcpServerNameForItem(item)

	mcpConfig := map[string]any{"mcpServers": map[string]any{}}
	if existing := readCurrentContent(mcpPath); existing != nil {
		var parsed map[string]any
		if json.Unmarshal([]byte(*existing), &parsed) == nil {
			for key, value := range parsed {
				mcpConfig[key] = value
			}
		}
	}
	servers, ok := mcpConfig["mcpServers"].(map[string]any)
	if !ok {
		servers = map[string]any{}
		mcpConfig["mcpServers"] = servers
	}

	prevConfig := cloneJSONValue(mcpConfig)
	var prevEntry any
	if entry, exists := servers[serverName]; exists {
		prevEntry = entry
	}

	if item.Action != nil && *item.Action == types.RestoreActionDelete {
		delete(servers, serverName)
	} else {
		if len(item.TargetContent) == 0 {
			return fmt.Errorf("missing target MCP server content for %s", serverName)
		}
		if policy.ContainsRedaction(item.TargetContent) {
			return fmt.Errorf(
				"refusing to restore MCP server %s: the snapshot holds a redacted copy (env values or credentials were masked); restore the whole config file from a content-backed snapshot instead",
				serverName,
			)
		}
		var content any
		if err := json.Unmarshal(item.TargetContent, &content); err != nil {
			return err
		}
		servers[serverName] = content
	}

	serialized, err := json.MarshalIndent(mcpConfig, "", "  ")
	if err != nil {
		return err
	}
	text := string(serialized) + "\n"
	if err := applyFileMutation(item, mcpPath, &text, nil, true); err != nil {
		return err
	}

	var rollback map[string]any
	if len(item.RollbackState) > 0 {
		_ = json.Unmarshal(item.RollbackState, &rollback)
	}
	if rollback == nil {
		rollback = map[string]any{}
	}
	rollback["mcpPath"] = mcpPath
	rollback["mcpConfig"] = prevConfig
	rollback["previousEntry"] = prevEntry
	rollbackBytes, _ := json.Marshal(rollback)
	item.RollbackState = rollbackBytes
	return nil
}

func permissionNameForItem(item *types.RestoreItem) (string, error) {
	if len(item.Metadata) > 0 {
		var metadata map[string]any
		if json.Unmarshal(item.Metadata, &metadata) == nil {
			if name, ok := metadata["permissionName"].(string); ok && name != "" {
				return name, nil
			}
			if name, ok := metadata["permissionKey"].(string); ok && name != "" {
				return name, nil
			}
		}
	}
	for _, candidate := range []string{item.Path, item.Source, item.ItemID} {
		if name := permissionNameFromEvidenceID(candidate); name != "" {
			return name, nil
		}
	}
	return "", fmt.Errorf("unable to resolve permission name for %s", item.ItemID)
}

func permissionRuleValueForApply(value any) any {
	if record, ok := value.(map[string]any); ok {
		if rule, ok := record["rule"]; ok {
			return rule
		}
	}
	return value
}

// ApplyPermission mutates settings.json permission rules.
func ApplyPermission(item *types.RestoreItem) error {
	settings := map[string]any{}
	if existing := readCurrentContent(item.Dest); existing != nil {
		var parsed map[string]any
		if json.Unmarshal([]byte(*existing), &parsed) == nil {
			for key, value := range parsed {
				settings[key] = value
			}
		}
	}
	permissions, ok := settings["permissions"].(map[string]any)
	if !ok {
		permissions = map[string]any{}
		settings["permissions"] = permissions
	}

	permName, err := permissionNameForItem(item)
	if err != nil {
		return err
	}

	if item.Action != nil && *item.Action == types.RestoreActionDelete {
		delete(permissions, permName)
	} else {
		if len(item.TargetContent) == 0 {
			return fmt.Errorf("missing target permission content for %s", permName)
		}
		var permValue any
		if err := json.Unmarshal(item.TargetContent, &permValue); err != nil {
			return err
		}
		permissions[permName] = permissionRuleValueForApply(permValue)
	}

	serialized, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	text := string(serialized) + "\n"
	return applyFileMutation(item, item.Dest, &text, nil, true)
}

func envKeyNameForItem(item *types.RestoreItem) string {
	parts := strings.Split(item.ItemID, ":")
	if len(parts) >= 2 && parts[1] != "" {
		return parts[1]
	}
	segments := strings.Split(item.ItemID, ".")
	if len(segments) > 0 {
		return segments[len(segments)-1]
	}
	return "VAR"
}

// ApplyEnvKey mutates a project .env file for a single key.
func ApplyEnvKey(item *types.RestoreItem) error {
	envPath := filepath.Join(filepath.Dir(item.Dest), ".env")
	keyName := envKeyNameForItem(item)

	value := ""
	if len(item.TargetContent) > 0 {
		var text string
		if json.Unmarshal(item.TargetContent, &text) == nil {
			value = text
		} else {
			value = string(item.TargetContent)
		}
	}

	existing := readCurrentContent(envPath)
	var lines []string
	if existing != nil {
		lines = strings.Split(*existing, "\n")
	}
	prefix := keyName + "="
	keyIndex := -1
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), prefix) {
			keyIndex = i
			break
		}
	}

	if item.Action != nil && *item.Action == types.RestoreActionDelete {
		if keyIndex >= 0 {
			lines = append(lines[:keyIndex], lines[keyIndex+1:]...)
		}
	} else {
		newLine := keyName + "=" + value
		if keyIndex >= 0 {
			lines[keyIndex] = newLine
		} else {
			lines = append(lines, newLine)
		}
	}

	content := strings.Join(lines, "\n")
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	if err := applyFileMutation(item, envPath, &content, nil, true); err != nil {
		return err
	}

	var rollback map[string]any
	if len(item.RollbackState) > 0 {
		_ = json.Unmarshal(item.RollbackState, &rollback)
	}
	if rollback == nil {
		rollback = map[string]any{}
	}
	rollback["envPath"] = envPath
	rollbackBytes, _ := json.Marshal(rollback)
	item.RollbackState = rollbackBytes
	return nil
}

// ApplyEnv is an alias for ApplyEnvKey.
func ApplyEnv(item *types.RestoreItem) error {
	return ApplyEnvKey(item)
}

// NoopUndoHandler is a no-op rollback handler.
func NoopUndoHandler(_ *types.RestoreItem) error {
	return nil
}

// RestorePreviousContentUndoHandler rolls back file, MCP, and env mutations.
func RestorePreviousContentUndoHandler(item *types.RestoreItem) error {
	if len(item.RollbackState) == 0 {
		return nil
	}
	var state map[string]any
	if err := json.Unmarshal(item.RollbackState, &state); err != nil {
		return nil
	}

	prevContent := state["previousContent"]

	if item.ItemType == "mcp_server" {
		mcpPath, _ := state["filePath"].(string)
		if mcpPath == "" {
			mcpPath, _ = state["mcpPath"].(string)
		}
		savedConfig := state["mcpConfig"]
		if mcpPath != "" && savedConfig != nil {
			serialized, err := json.MarshalIndent(savedConfig, "", "  ")
			if err != nil {
				return err
			}
			text := string(serialized) + "\n"
			if err := os.MkdirAll(filepath.Dir(mcpPath), 0o755); err != nil {
				return err
			}
			return writeFileAtomically(mcpPath, text)
		}
	}

	if item.ItemType == "env_key" || item.ItemType == "env" {
		envPath, _ := state["envPath"].(string)
		if envPath != "" {
			if prevContent == nil {
				_ = os.Remove(envPath)
				return nil
			}
			if text, ok := prevContent.(string); ok {
				if err := os.MkdirAll(filepath.Dir(envPath), 0o755); err != nil {
					return err
				}
				return writeFileAtomically(envPath, text)
			}
			return nil
		}
	}

	filePath, _ := state["filePath"].(string)
	if filePath == "" {
		return nil
	}
	if prevContent == nil {
		_ = os.Remove(filePath)
		return nil
	}
	if text, ok := prevContent.(string); ok {
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			return err
		}
		return writeFileAtomically(filePath, text)
	}
	return nil
}

// RollbackAppliedItems undoes applied items in reverse execution order.
func RollbackAppliedItems(
	items []types.RestoreItem,
	undoExecutor UndoExecutor,
	failFast bool,
) types.RollbackSummary {
	summary := types.RollbackSummary{}

	var reversed []int
	for i := range items {
		if items[i].Status == types.RestoreItemStatusApplied {
			reversed = append(reversed, i)
		}
	}
	sortIndicesByDescendingOrder(reversed, items)
	summary.Total = uint32(len(reversed))

	stopped := false
	for _, index := range reversed {
		item := &items[index]
		if !item.CanRollback {
			summary.Skipped++
			reason := "Item does not support rollback"
			summary.Results = append(summary.Results, types.UndoResult{
				ItemID: item.ItemID,
				Status: types.UndoStatusSkipped,
				Reason: &reason,
			})
			continue
		}
		if err := undoExecutor(item); err != nil {
			reason := fmt.Sprintf("Rollback failed: %v", err)
			item.ErrorMessage = &reason
			summary.Failed++
			summary.Results = append(summary.Results, types.UndoResult{
				ItemID: item.ItemID,
				Status: types.UndoStatusFailed,
				Reason: &reason,
			})
			if failFast {
				stopped = true
				break
			}
			continue
		}
		item.Status = types.RestoreItemStatusPending
		item.RollbackState = nil
		summary.Undone++
		summary.Results = append(summary.Results, types.UndoResult{
			ItemID: item.ItemID,
			Status: types.UndoStatusUndone,
		})
	}

	if stopped {
		hasResult := make(map[string]struct{}, len(summary.Results))
		for _, result := range summary.Results {
			hasResult[result.ItemID] = struct{}{}
		}
		for i := range items {
			item := &items[i]
			if item.Status != types.RestoreItemStatusApplied {
				continue
			}
			if _, already := hasResult[item.ItemID]; already {
				continue
			}
			summary.Skipped++
			reason := "Rollback stopped before this item"
			summary.Results = append(summary.Results, types.UndoResult{
				ItemID: item.ItemID,
				Status: types.UndoStatusSkipped,
				Reason: &reason,
			})
		}
	}

	return summary
}

// ApplyWithRollback applies items and optionally rolls them back.
func ApplyWithRollback(
	items []types.RestoreItem,
	executor RestoreExecutor,
	undoExecutor UndoExecutor,
	options *types.ApplyOptions,
) types.ApplyWithRollbackResult {
	applySummary := ApplyRestoreItems(items, executor, options)
	rollbackRequested := options.Rollback != nil && *options.Rollback

	if rollbackRequested && len(applySummary.AppliedItems) > 0 {
		var appliedIndices []int
		for i := range items {
			if applySummary.StatusRegistry[items[i].ItemID] == types.RestoreItemStatusApplied {
				appliedIndices = append(appliedIndices, i)
			}
		}
		subset := make([]types.RestoreItem, len(appliedIndices))
		for i, index := range appliedIndices {
			subset[i] = items[index]
		}
		rollbackSummary := RollbackAppliedItems(subset, undoExecutor, options.FailFast)
		for i, index := range appliedIndices {
			items[index] = subset[i]
		}
		applySummary.AppliedItems = nil
		return types.ApplyWithRollbackResult{
			ApplySummary:    applySummary,
			RollbackSummary: &rollbackSummary,
		}
	}

	if rollbackRequested {
		applySummary.AppliedItems = nil
	}
	return types.ApplyWithRollbackResult{ApplySummary: applySummary}
}

func sortIndicesByOrder(indices []int, items []types.RestoreItem) {
	sort.Slice(indices, func(i, j int) bool {
		return items[indices[i]].ExecutionOrder < items[indices[j]].ExecutionOrder
	})
}

func sortIndicesByDescendingOrder(indices []int, items []types.RestoreItem) {
	sort.Slice(indices, func(i, j int) bool {
		return items[indices[i]].ExecutionOrder > items[indices[j]].ExecutionOrder
	})
}

func cloneJSONValue(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var cloned any
	if json.Unmarshal(raw, &cloned) != nil {
		return value
	}
	return cloned
}

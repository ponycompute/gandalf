package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/qyinm/gandalf/internal/gandalfcore/agents"
	"github.com/qyinm/gandalf/internal/gandalfcore/diff"
	hemerrors "github.com/qyinm/gandalf/internal/gandalfcore/errors"
	"github.com/qyinm/gandalf/internal/gandalfcore/policy"
	"github.com/qyinm/gandalf/internal/gandalfcore/snapshot"
	"github.com/qyinm/gandalf/internal/gandalfcore/store"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

var validScopes = []string{"user", "project", "managed", "unknown"}

// CommonFlags are shared CLI options across commands.
type CommonFlags struct {
	Project string
	Home    string
	Store   string
	Agent   string
	Scope   string
	JSON    bool
}

func (f *CommonFlags) bindFlags(cmdFlags interface {
	StringVarP(*string, string, string, string, string)
	StringVar(*string, string, string, string)
	BoolVar(*bool, string, bool, string)
}) {
	cmdFlags.StringVarP(&f.Project, "project", "p", ".", "Project directory to scan")
	cmdFlags.StringVar(&f.Home, "home", "", "Home directory (defaults to $HOME)")
	cmdFlags.StringVar(&f.Store, "store", "", "Gandalf store directory (defaults to ~/.gandalf or $GANDALF_STORE)")
	cmdFlags.StringVar(&f.Agent, "agent", "", "Filter by agent")
	cmdFlags.StringVar(&f.Scope, "scope", "", "Filter by evidence scope")
	cmdFlags.BoolVar(&f.JSON, "json", false, "Emit JSON output")
}

func resolveRuntime(flags *CommonFlags) (types.RuntimeOptions, *types.SnapError) {
	homeDir := flags.Home
	if homeDir == "" {
		if envHome := os.Getenv("HOME"); envHome != "" {
			homeDir = envHome
		} else if cwd, err := os.Getwd(); err == nil {
			homeDir = cwd
		} else {
			homeDir = "."
		}
	}

	storeDir := flags.Store
	if storeDir == "" {
		if envStore := os.Getenv("GANDALF_STORE"); envStore != "" {
			storeDir = envStore
		} else {
			storeDir = store.DefaultStoreDir(homeDir)
		}
	}

	projectPath := flags.Project
	if abs, err := filepath.Abs(projectPath); err == nil {
		if resolved, err := filepath.EvalSymlinks(abs); err == nil {
			projectPath = resolved
		} else {
			projectPath = abs
		}
	}

	var agent *types.AgentID
	if flags.Agent != "" {
		parsed := types.ParseAgentID(flags.Agent)
		if !agents.IsCurrentSupported(parsed) || parsed.String() != flags.Agent {
			return types.RuntimeOptions{}, &types.SnapError{
				Code:    "GANDALF_INVALID_AGENT",
				Problem: fmt.Sprintf("Invalid agent: %q.", flags.Agent),
				Cause:   "An unsupported agent identifier was provided.",
				Fix:     fmt.Sprintf("Valid agents: %s", strings.Join(agents.CurrentSupportedNames(), ", ")),
			}
		}
		agent = &parsed
	}

	var scope *types.EvidenceScope
	if flags.Scope != "" {
		valid := false
		for _, candidate := range validScopes {
			if candidate == flags.Scope {
				valid = true
				break
			}
		}
		if !valid {
			return types.RuntimeOptions{}, &types.SnapError{
				Code:    "GANDALF_INVALID_SCOPE",
				Problem: fmt.Sprintf("Invalid scope: %q.", flags.Scope),
				Cause:   "An unsupported evidence scope was provided.",
				Fix:     fmt.Sprintf("Valid scopes: %s", strings.Join(validScopes, ", ")),
			}
		}
		parsed, _ := types.ParseScope(flags.Scope)
		scope = &parsed
	}

	return types.RuntimeOptions{
		ProjectPath: projectPath,
		HomeDir:     homeDir,
		StoreDir:    storeDir,
		Agent:       agent,
		Scope:       scope,
	}, nil
}

func snapshotByRef(reference string, runtime *types.RuntimeOptions) (types.Snapshot, *types.SnapError) {
	if reference == "current" {
		state, err := snapshot.CaptureCurrentState(runtime, "current")
		if err != nil {
			return types.Snapshot{}, &types.SnapError{
				Code:    "GANDALF_CURRENT_STATE_FAILED",
				Problem: "Failed to capture current state.",
				Cause:   err.Error(),
				Fix:     "Verify project and store paths are accessible.",
			}
		}
		return state.Snapshot, nil
	}

	snap, err := store.ReadSnapshot(runtime.StoreDir, reference, runtime.Agent)
	if err != nil {
		return types.Snapshot{}, &types.SnapError{
			Code:    "GANDALF_SNAPSHOT_NOT_FOUND",
			Problem: fmt.Sprintf("Snapshot %q not found.", reference),
			Cause:   err.Error(),
			Fix:     "Run `gandalf snapshot list` to see available snapshots.",
		}
	}
	return snap, nil
}

func writeJSON(w io.Writer, value any) int {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return writeError(w, &types.SnapError{
			Code:    "GANDALF_JSON_SERIALIZE_FAILED",
			Problem: "Failed to serialize JSON output.",
			Cause:   err.Error(),
			Fix:     "This is an internal error.",
		})
	}
	data = policy.RedactJSONOutput(data)
	if _, err := fmt.Fprintf(w, "%s\n", data); err != nil {
		return 1
	}
	return 0
}

func writeStdout(w io.Writer, text string) int {
	if _, err := io.WriteString(w, text); err != nil {
		return 1
	}
	return 0
}

func writeError(w io.Writer, err *types.SnapError) int {
	_, _ = io.WriteString(w, hemerrors.FormatSnapError(*err))
	return 1
}

type exitError struct {
	code int
}

func (e exitError) Error() string {
	return fmt.Sprintf("exit %d", e.code)
}

func errExit(code int) error {
	return exitError{code: code}
}

// IsExitError reports whether err is a CLI exit code wrapper.
func IsExitError(err error) (int, bool) {
	var target exitError
	if errors.As(err, &target) {
		return target.code, true
	}
	return 0, false
}

func displayAgent(agent types.AgentID) string {
	return agents.DisplayName(agent)
}

func renderScanText(scan *types.ScanResult) string {
	lines := []string{
		"gandalf scan",
		"",
		fmt.Sprintf("Read-only: %s", boolYesNo(scan.Trust.ReadOnly)),
		fmt.Sprintf("Network: %s", scan.Trust.Network),
		fmt.Sprintf("Commands executed: %d", len(scan.Trust.CommandsExecuted)),
		fmt.Sprintf("Writes: %s/index only", scan.Trust.StoreWriteLocation),
		"",
		"Detected agents",
	}

	agentSet := make(map[types.AgentID]struct{})
	for _, item := range scan.Evidence {
		agentSet[item.Agent] = struct{}{}
	}
	agents := make([]types.AgentID, 0, len(agentSet))
	for agent := range agentSet {
		agents = append(agents, agent)
	}
	sort.Slice(agents, func(i, j int) bool {
		return agents[i].String() < agents[j].String()
	})

	if len(agents) == 0 {
		lines = append(lines, "  none")
	} else {
		for _, agent := range agents {
			scopeSet := make(map[string]struct{})
			for _, item := range scan.Evidence {
				if item.Agent == agent {
					scopeSet[item.Scope.String()] = struct{}{}
				}
			}
			scopes := make([]string, 0, len(scopeSet))
			for scope := range scopeSet {
				scopes = append(scopes, scope)
			}
			sort.Strings(scopes)
			lines = append(lines, fmt.Sprintf("  %s  %s state found", displayAgent(agent), strings.Join(scopes, " + ")))
		}
	}

	lines = append(lines, "", "Blind spots")
	if len(scan.BlindSpots) == 0 {
		lines = append(lines, "  none")
	} else {
		for _, blindSpot := range scan.BlindSpots {
			lines = append(lines, "  "+blindSpot)
		}
	}

	lines = append(lines, "", "Next", "  gandalf snapshot create --name baseline --agent codex --scope user --project .")
	return strings.Join(lines, "\n") + "\n"
}

func renderScanExplainText(scan *types.ScanResult) string {
	output := strings.TrimRight(renderScanText(scan), "\n")
	output += "\n\nPaths considered\n"

	pathSet := make(map[string]struct{})
	for _, item := range scan.Evidence {
		pathSet[item.SourcePath] = struct{}{}
	}
	paths := make([]string, 0, len(pathSet))
	for path := range pathSet {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	if len(paths) == 0 {
		output += "  none found\n"
	} else {
		for _, path := range paths {
			output += "  " + path + "\n"
		}
	}
	return output
}

func renderDiffText(graphDiff *diff.GraphDiff) string {
	lines := []string{
		"gandalf diff",
		"",
		"Semantic changes",
	}
	if len(graphDiff.SemanticChanges) == 0 {
		lines = append(lines, "  none")
	} else {
		for _, change := range graphDiff.SemanticChanges {
			lines = append(lines, fmt.Sprintf(
				"  %s  %s: %s",
				severityLabel(change.Severity),
				change.Code,
				change.EntityName,
			))
		}
	}

	lines = append(lines, "", "Raw source changes")
	if len(graphDiff.RawSourceChanges) == 0 {
		lines = append(lines, "  none")
	} else {
		for _, change := range graphDiff.RawSourceChanges {
			lines = append(lines, fmt.Sprintf("  %s: %s", change.Status, change.SourcePath))
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

func formatRestorePlanPreview(plan *types.RestorePlan) string {
	lines := []string{
		"gandalf restore dry-run",
		"",
		fmt.Sprintf("Snapshot: %s", plan.SourceSnapshot),
		fmt.Sprintf("Target project: %s", plan.TargetProject),
		fmt.Sprintf("Target home: %s", plan.TargetHome),
		fmt.Sprintf("Writable changes: %d", len(plan.Items)),
		fmt.Sprintf("Unsupported items: %d", len(plan.UnsupportedItems)),
		fmt.Sprintf("Risk: %s", formatRiskSummary(&plan.RiskSummary)),
		"",
	}

	if len(plan.Items) == 0 && len(plan.UnsupportedItems) == 0 {
		lines = append(lines, "No restore actions needed.")
	}

	if len(plan.Items) > 0 {
		lines = append(lines, "Plan:")
		for index, item := range plan.Items {
			lines = append(lines, formatRestorePlanItem(&item, index+1))
		}
	}

	if len(plan.UnsupportedItems) > 0 {
		lines = append(lines, "", "Unsupported:")
		for index, item := range plan.UnsupportedItems {
			lines = append(lines, fmt.Sprintf(
				"%d. %s at %s\n   reason: %s",
				index+1,
				item.Kind,
				item.SourcePath,
				item.Reason,
			))
		}
	}

	lines = append(lines,
		"",
		"No files were changed.",
		"Use --apply --experimental to apply this plan.",
		"Use --json for the machine-readable restore plan.",
	)
	return strings.Join(lines, "\n") + "\n"
}

func formatRestorePlanItem(item *types.RestorePlanItem, index int) string {
	fields := []string{
		fmt.Sprintf(
			"%d. %s %s at %s",
			index,
			restoreActionLabel(item.Action),
			item.Kind,
			item.SourcePath,
		),
		fmt.Sprintf(
			"   risk: %s%s",
			severityLabel(item.RiskLevel),
			confirmationSuffix(item.NeedsConfirmation),
		),
		fmt.Sprintf("   rollback: %s", item.RollbackInstruction),
	}

	changedFields := append([]string{}, item.Diff.Changes...)
	for _, addition := range item.Diff.Additions {
		changedFields = append(changedFields, "+"+addition)
	}
	for _, removal := range item.Diff.Removals {
		changedFields = append(changedFields, "-"+removal)
	}
	if len(changedFields) > 0 {
		fields = append(fields, fmt.Sprintf("   fields: %s", strings.Join(changedFields, ", ")))
	}
	return strings.Join(fields, "\n")
}

func formatRollbackSummary(summary *types.RollbackSummary) string {
	lines := []string{
		"Rollback complete.",
		"",
		fmt.Sprintf("  Undone:  %d", summary.Undone),
		fmt.Sprintf("  Skipped: %d", summary.Skipped),
		fmt.Sprintf("  Failed:  %d", summary.Failed),
		fmt.Sprintf("  Total:   %d", summary.Total),
	}

	var failures []types.UndoResult
	var skipped []types.UndoResult
	for _, result := range summary.Results {
		switch result.Status {
		case types.UndoStatusFailed:
			failures = append(failures, result)
		case types.UndoStatusSkipped:
			skipped = append(skipped, result)
		}
	}

	if len(failures) > 0 {
		lines = append(lines, "", "Failures:")
		for _, failure := range failures {
			reason := "Unknown error"
			if failure.Reason != nil {
				reason = *failure.Reason
			}
			lines = append(lines, fmt.Sprintf("  [%s] %s", failure.ItemID, reason))
		}
	}

	if len(skipped) > 0 {
		lines = append(lines, "", "Skipped (non-reversible):")
		for _, entry := range skipped {
			reason := "No reason"
			if entry.Reason != nil {
				reason = *entry.Reason
			}
			lines = append(lines, fmt.Sprintf("  [%s] %s", entry.ItemID, reason))
		}
	}

	return strings.Join(lines, "\n") + "\n"
}

func severityLabel(severity types.Severity) string {
	return string(severity)
}

func restoreActionLabel(action types.RestoreAction) string {
	return string(action)
}

func confirmationSuffix(needs bool) string {
	if needs {
		return " (confirmation required)"
	}
	return ""
}

func formatRiskSummary(riskSummary *types.RiskSummary) string {
	counts := []struct {
		label string
		count uint32
	}{
		{"critical", riskSummary.Critical},
		{"high", riskSummary.High},
		{"medium", riskSummary.Medium},
		{"low", riskSummary.Low},
		{"none", riskSummary.None},
	}
	var parts []string
	for _, entry := range counts {
		if entry.count > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", entry.label, entry.count))
		}
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}

func boolYesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}


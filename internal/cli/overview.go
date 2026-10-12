package cli

import (
	"fmt"
	"strings"

	"github.com/qyinm/gandalf/internal/gandalfcore/audit"
	"github.com/qyinm/gandalf/internal/gandalfcore/overview"
	"github.com/qyinm/gandalf/internal/gandalfcore/scan"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
	"github.com/spf13/cobra"
)

func newOverviewCmd() *cobra.Command {
	var common CommonFlags

	cmd := &cobra.Command{
		Use:   "overview",
		Short: "Summarize your agents, MCP servers across agents, and what to fix first",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runOverviewCommand(cmd, &common)
		},
	}

	common.bindFlags(cmd.Flags())
	return cmd
}

func runOverviewCommand(cmd *cobra.Command, common *CommonFlags) error {
	exitCode := runOverview(cmd, common)
	if exitCode != 0 {
		return errExit(exitCode)
	}
	return nil
}

func runOverview(cmd *cobra.Command, common *CommonFlags) int {
	runtime, snapErr := resolveRuntime(common)
	if snapErr != nil {
		return writeError(cmd.ErrOrStderr(), snapErr)
	}

	scanResult := scan.ScanProject(&types.ScanOptions{
		ProjectPath: runtime.ProjectPath,
		HomeDir:     runtime.HomeDir,
		StoreDir:    runtime.StoreDir,
		Agent:       runtime.Agent,
		Scope:       runtime.Scope,
	})
	summary := overview.Build(scanResult.Evidence, audit.AuditEvidenceWithGraph(scanResult.Evidence))

	if common.JSON {
		return writeJSON(cmd.OutOrStdout(), summary)
	}
	return writeStdout(cmd.OutOrStdout(), renderOverviewText(&summary))
}

func renderOverviewText(summary *overview.Overview) string {
	var b strings.Builder
	b.WriteString("gandalf\n\n")

	if len(summary.Agents) == 0 {
		b.WriteString("No Claude Code, Codex, or Cursor setup found in your home directory.\n\n")
		b.WriteString("Next\n")
		b.WriteString("  gandalf doctor    check what Gandalf can see on this machine\n")
		return b.String()
	}

	names := make([]string, 0, len(summary.Agents))
	for _, agent := range summary.Agents {
		names = append(names, agent.Name)
	}
	fmt.Fprintf(&b, "Your agents  %s\n\n", strings.Join(names, " · "))

	writeServerTable(&b, summary)
	writeIssues(&b, summary)
	writeNextSteps(&b, summary)

	b.WriteString("\nRead-only · no network · no commands executed\n")
	return b.String()
}

func writeServerTable(b *strings.Builder, summary *overview.Overview) {
	if len(summary.Servers) == 0 {
		b.WriteString("MCP servers  none configured\n\n")
		return
	}

	nameWidth := len("MCP servers")
	for _, row := range summary.Servers {
		if len(row.Name)+2 > nameWidth {
			nameWidth = len(row.Name) + 2
		}
	}

	fmt.Fprintf(b, "%-*s", nameWidth+2, "MCP servers")
	for _, agent := range summary.Agents {
		fmt.Fprintf(b, "  %s", agent.Name)
	}
	b.WriteString("\n")

	for _, row := range summary.Servers {
		var line strings.Builder
		fmt.Fprintf(&line, "  %-*s", nameWidth, row.Name)
		for _, agent := range summary.Agents {
			mark := "·"
			if containsAgent(row.Agents, agent.Agent) {
				mark = "✓"
			}
			width := len([]rune(agent.Name))
			left := (width - 1) / 2
			fmt.Fprintf(&line, "  %s%s%s", strings.Repeat(" ", left), mark, strings.Repeat(" ", width-1-left))
		}
		if row.Mismatch != "" {
			fmt.Fprintf(&line, "  ⚠ %s", row.Mismatch)
		}
		b.WriteString(strings.TrimRight(line.String(), " "))
		b.WriteString("\n")
	}
	b.WriteString("\n")
}

func writeIssues(b *strings.Builder, summary *overview.Overview) {
	total := len(summary.Issues) + summary.HiddenIssues
	if total == 0 {
		b.WriteString("No issues found\n")
		return
	}
	if total == 1 {
		b.WriteString("1 thing to fix\n")
	} else {
		fmt.Fprintf(b, "%d things to fix\n", total)
	}
	for _, issue := range summary.Issues {
		fmt.Fprintf(b, "  %-6s %s\n", severityTag(issue.Severity), issue.Title)
		if issue.Path != "" {
			fmt.Fprintf(b, "         %s\n", issue.Path)
		}
	}
	if summary.HiddenIssues > 0 {
		fmt.Fprintf(b, "  … %d more in `gandalf report`\n", summary.HiddenIssues)
	}
}

func writeNextSteps(b *strings.Builder, summary *overview.Overview) {
	type step struct{ command, why string }
	var steps []step
	if len(summary.Issues) > 0 {
		steps = append(steps, step{"gandalf report", "every finding with cause and fix"})
	}
	if hasCrossAgentGap(summary) {
		steps = append(steps, step{"gandalf export", "collect these servers into one gandalf.toml"})
	}
	steps = append(steps,
		step{"gandalf snapshot create --name baseline", "save a restore point before you change anything"},
		step{"gandalf tui", "browse and manage everything interactively"},
	)

	width := 0
	for _, s := range steps {
		if len(s.command) > width {
			width = len(s.command)
		}
	}
	b.WriteString("\nNext\n")
	for _, s := range steps {
		fmt.Fprintf(b, "  %-*s  %s\n", width, s.command, s.why)
	}
}

// hasCrossAgentGap reports whether some MCP server is missing from or
// configured differently in another detected agent.
func hasCrossAgentGap(summary *overview.Overview) bool {
	if len(summary.Agents) < 2 {
		return false
	}
	for _, row := range summary.Servers {
		if row.Mismatch != "" || len(row.Agents) < len(summary.Agents) {
			return true
		}
	}
	return false
}

func containsAgent(ids []types.AgentID, target types.AgentID) bool {
	for _, id := range ids {
		if id == target {
			return true
		}
	}
	return false
}

func severityTag(severity types.Severity) string {
	switch severity {
	case types.SeverityCritical:
		return "CRIT"
	case types.SeverityHigh:
		return "HIGH"
	case types.SeverityMedium:
		return "MED"
	default:
		return "LOW"
	}
}

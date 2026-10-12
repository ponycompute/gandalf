package cli

import (
	"os"

	"github.com/qyinm/gandalf/internal/gandalfcore/diff"
	"github.com/qyinm/gandalf/internal/gandalfcore/policy"
	"github.com/qyinm/gandalf/internal/gandalfcore/report"
	"github.com/qyinm/gandalf/internal/gandalfcore/scan"
	"github.com/qyinm/gandalf/internal/gandalfcore/snapshot"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
	"github.com/spf13/cobra"
)

func newReportCmd() *cobra.Command {
	var common CommonFlags
	var out string

	cmd := &cobra.Command{
		Use:   "report [reference]",
		Short: "Generate a markdown report of agent state and findings",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			reference := "current"
			if len(args) > 0 {
				reference = args[0]
			}
			exitCode := runReport(cmd, &common, reference, out)
			if exitCode != 0 {
				return errExit(exitCode)
			}
			return nil
		},
	}

	common.bindFlags(cmd.Flags())
	cmd.Flags().StringVar(&out, "out", "", "Write report to file instead of stdout")
	return cmd
}

func runReport(cmd *cobra.Command, common *CommonFlags, reference, out string) int {
	runtime, snapErr := resolveRuntime(common)
	if snapErr != nil {
		return writeError(cmd.ErrOrStderr(), snapErr)
	}

	var snap types.Snapshot
	var scanResult types.ScanResult
	var graphDiff *diff.GraphDiff

	if reference == "current" {
		current, err := snapshot.CaptureCurrentState(&runtime, "current")
		if err != nil {
			return writeError(cmd.ErrOrStderr(), &types.SnapError{
				Code:    "GANDALF_CURRENT_STATE_FAILED",
				Problem: "Failed to capture current state.",
				Cause:   err.Error(),
				Fix:     "Verify project and store paths are accessible.",
			})
		}
		snap = current.Snapshot
		scanResult = current.Scan
	} else {
		var snapErr *types.SnapError
		snap, snapErr = snapshotByRef(reference, &runtime)
		if snapErr != nil {
			return writeError(cmd.ErrOrStderr(), snapErr)
		}
		current, err := snapshot.CaptureCurrentState(&runtime, "current")
		if err != nil {
			return writeError(cmd.ErrOrStderr(), &types.SnapError{
				Code:    "GANDALF_CURRENT_STATE_FAILED",
				Problem: "Failed to capture current state.",
				Cause:   err.Error(),
				Fix:     "Verify project and store paths are accessible.",
			})
		}
		d := diff.DiffGraphs(snap.Graph, current.Snapshot.Graph)
		graphDiff = &d
		scanResult = scan.ScanProject(&types.ScanOptions{
			ProjectPath: runtime.ProjectPath,
			HomeDir:     runtime.HomeDir,
			StoreDir:    runtime.StoreDir,
			Agent:       runtime.Agent,
			Scope:       runtime.Scope,
		})
	}

	snapshotName := snap.Manifest.Name
	markdown := report.RenderMarkdownReport(&report.Input{
		SnapshotName: &snapshotName,
		Trust: report.Trust{
			ReadOnly:         scanResult.Trust.ReadOnly,
			Network:          scanResult.Trust.Network,
			CommandsExecuted: uint32(len(scanResult.Trust.CommandsExecuted)),
		},
		Evidence:   snap.Evidence,
		Graph:      snap.Graph,
		Findings:   snap.AuditFindings,
		Provenance: snap.Provenance,
		BlindSpots: scanResult.BlindSpots,
		Diffs:      graphDiff,
	})

	if common.JSON {
		data, err := report.MarshalInputJSON(snap, markdown)
		if err != nil {
			return writeError(cmd.ErrOrStderr(), &types.SnapError{
				Code:    "GANDALF_JSON_SERIALIZE_FAILED",
				Problem: "Failed to serialize report JSON.",
				Cause:   err.Error(),
				Fix:     "This is an internal error.",
			})
		}
		data = policy.RedactJSONOutput(data)
		if _, err := cmd.OutOrStdout().Write(append(data, '\n')); err != nil {
			return 1
		}
		return 0
	}

	if out != "" {
		if err := os.WriteFile(out, []byte(markdown), 0o644); err != nil {
			return writeError(cmd.ErrOrStderr(), &types.SnapError{
				Code:    "GANDALF_REPORT_WRITE_FAILED",
				Problem: "Failed to write report file.",
				Cause:   err.Error(),
				Fix:     "Verify the output path is writable.",
			})
		}
		return writeStdout(cmd.OutOrStdout(), "Report written to "+out+"\n")
	}
	return writeStdout(cmd.OutOrStdout(), markdown)
}

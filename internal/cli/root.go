package cli

import (
	"os"

	"github.com/spf13/cobra"
)

// Execute runs the gandalf CLI and returns an exit code.
func Execute() int {
	cmd := NewRootCmd()
	cmd.SetOut(os.Stdout)
	cmd.SetErr(os.Stderr)
	cmd.SilenceUsage = true
	cmd.SilenceErrors = true
	if err := cmd.Execute(); err != nil {
		if code, ok := IsExitError(err); ok {
			return code
		}
		return 1
	}
	return 0
}

// NewRootCmd builds the root Cobra command tree.
func NewRootCmd() *cobra.Command {
	var flags skillFlags

	root := &cobra.Command{
		Use:   "gandalf",
		Short: "Skill manager for Claude Code, Codex, and Cursor.",
		Long: `Skill manager for Claude Code, Codex, and Cursor.

Run without a command to see every skill and how it lines up across your
agents. Use ` + "`gandalf skill`" + ` to add, sync, and remove skills.`,
		Args:          cobra.NoArgs,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return exitWith(runSkillList(cmd, &flags))
		},
	}

	flags.bind(root, "Skill scope: user, project, or all")
	root.AddCommand(newSkillCmd())
	root.AddCommand(newBoostCmd())

	return root
}

package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/qyinm/gandalf/internal/gandalfcore/boost"
	"github.com/qyinm/gandalf/internal/gandalfcore/manifest"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

type boostFlags struct {
	CommonFlags
	Scope       string
	List        bool
	Clear       bool
	Status      bool
	DryRun      bool
	SetupAgents bool
}

func newBoostCmd() *cobra.Command {
	var flags boostFlags

	cmd := &cobra.Command{
		Use:   "boost [profile]",
		Short: "Selectively inject agent skill profiles via portable relative symlinks.",
		Long: `Boost switches and injects task-specific skills into your local agent runtimes
(Claude Code, Cursor, Codex) based on profiles defined in gandalf.toml.
Avoids context bloat and prevents tool hallucination by keeping agent environments clean.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			exitCode := runBoost(cmd, args, &flags)
			if exitCode != 0 {
				return errExit(exitCode)
			}
			return nil
		},
	}

	flags.bindFlags(cmd.Flags())
	cmd.Flags().StringVar(&flags.Scope, "scope", "project", "Where to inject skill links: project or global")
	cmd.Flags().BoolVarP(&flags.List, "list", "l", false, "List available profiles in manifest and show active profile")
	cmd.Flags().BoolVarP(&flags.Clear, "clear", "c", false, "Remove all Gandalf-injected symlinks (restore clean environment)")
	cmd.Flags().BoolVarP(&flags.Status, "status", "s", false, "Show active profile and injected skills")
	cmd.Flags().BoolVar(&flags.DryRun, "dry-run", false, "Preview planned symlink changes without applying")
	cmd.Flags().BoolVar(&flags.SetupAgents, "setup-agents", false, "Install agent slash command templates (.claude/commands/boost.md, etc.)")

	return cmd
}

func runBoost(cmd *cobra.Command, args []string, flags *boostFlags) int {
	runtime, snapErr := resolveRuntime(&flags.CommonFlags)
	if snapErr != nil {
		return writeError(cmd.ErrOrStderr(), snapErr)
	}

	out := cmd.OutOrStdout()
	errOut := cmd.ErrOrStderr()

	// 1. Handle --setup-agents
	if flags.SetupAgents {
		return setupAgentTemplates(runtime.ProjectPath, out, errOut)
	}

	// 2. Load manifest
	manifestPath, err := manifest.FindManifestFile(runtime.ProjectPath)
	if err != nil {
		return writeError(errOut, &types.SnapError{
			Code:    "MANIFEST_NOT_FOUND",
			Problem: "No team manifest file found in project",
			Cause:   err.Error(),
			Fix:     "Create a gandalf.toml with [[skills]] and [profiles.<name>] sections in this repository",
		})
	}

	res, err := manifest.LoadManifest(manifestPath, nil)
	if err != nil {
		return writeError(errOut, &types.SnapError{
			Code:    "MANIFEST_PARSE_ERROR",
			Problem: "Failed to parse gandalf.toml",
			Cause:   err.Error(),
			Fix:     "Check syntax of gandalf.toml",
		})
	}

	m := res.Manifest
	vErrs := manifest.Validate(m, runtime.ProjectPath)
	if len(vErrs) > 0 {
		var msgs []string
		for _, v := range vErrs {
			msgs = append(msgs, v.Error())
		}
		return writeError(errOut, &types.SnapError{
			Code:    "MANIFEST_VALIDATION_ERROR",
			Problem: "Manifest validation failed",
			Cause:   strings.Join(msgs, "; "),
			Fix:     vErrs[0].Fix,
		})
	}

	// Load existing boost state
	state, _ := boost.LoadState(runtime.ProjectPath)

	// 3. Handle --status
	if flags.Status {
		if flags.JSON {
			return writeJSON(out, state)
		}
		if state == nil || state.ActiveProfile == "" {
			_, _ = fmt.Fprintln(out, "ℹ️ No active profile boosted. Environment is clean.")
			_, _ = fmt.Fprintln(out, "💡 Run 'gandalf boost --list' to see available profiles.")
		} else {
			_, _ = fmt.Fprintf(out, "🚀 Active Profile: %s (scope: %s)\n", state.ActiveProfile, state.Scope)
			_, _ = fmt.Fprintf(out, "🕒 Boosted at: %s\n", state.UpdatedAt)
			_, _ = fmt.Fprintf(out, "📦 Injected Skills (%d):\n", len(state.InjectedSkills))
			for _, entry := range state.InjectedSkills {
				_, _ = fmt.Fprintf(out, "   • [%s] %s -> %s\n", entry.Agent, entry.SkillName, entry.TargetPath)
			}
		}
		return 0
	}

	// 4. Handle --list or no-arguments default
	if flags.List || (len(args) == 0 && !flags.Clear) {
		if len(m.Profiles) == 0 {
			_, _ = fmt.Fprintln(out, "ℹ️ No profiles declared in gandalf.toml.")
			_, _ = fmt.Fprintln(out, "💡 Add [profiles.<name>] sections to gandalf.toml to define skill profiles.")
			return 0
		}

		if flags.JSON {
			return writeJSON(out, map[string]any{
				"active_profile": state.ActiveProfile,
				"profiles":       m.Profiles,
			})
		}

		_, _ = fmt.Fprintf(out, "📦 Available Profiles for %s:\n\n", m.Name)
		var pNames []string
		for k := range m.Profiles {
			pNames = append(pNames, k)
		}
		sort.Strings(pNames)

		for _, pName := range pNames {
			p := m.Profiles[pName]
			badge := "  "
			if state != nil && state.ActiveProfile == pName {
				badge = "● "
			}

			skills, _ := boost.ResolveSkills(m, pName)
			desc := p.Description
			if desc == "" {
				desc = "No description"
			}
			_, _ = fmt.Fprintf(out, "%s%-16s %s\n", badge, pName, desc)
			if len(p.Includes) > 0 {
				_, _ = fmt.Fprintf(out, "    Includes: %s\n", strings.Join(p.Includes, ", "))
			}
			_, _ = fmt.Fprintf(out, "    Skills (%d): %s\n\n", len(skills), strings.Join(skills, ", "))
		}

		if state != nil && state.ActiveProfile != "" {
			_, _ = fmt.Fprintf(out, "Active profile is marked with ●. Run 'gandalf boost <profile>' to switch, or 'gandalf boost --clear' to reset.\n")
		} else {
			_, _ = fmt.Fprintln(out, "💡 Run 'gandalf boost <profile>' to activate a profile.")
		}
		return 0
	}

	// 5. Determine target profile
	targetProfile := ""
	if !flags.Clear && len(args) > 0 {
		targetProfile = args[0]
		if _, exists := m.Profiles[targetProfile]; !exists {
			return writeError(errOut, &types.SnapError{
				Code:    "PROFILE_NOT_FOUND",
				Problem: fmt.Sprintf("Profile '%s' is not defined in gandalf.toml", targetProfile),
				Fix:     "Run 'gandalf boost --list' to see available profiles",
			})
		}
	}

	scope := boost.Scope(flags.Scope)
	if scope != boost.ScopeProject && scope != boost.ScopeGlobal {
		scope = boost.ScopeProject
	}

	// 6. Create Boost Plan
	plan, err := boost.CreateBoostPlan(m, targetProfile, scope, runtime.ProjectPath, runtime.HomeDir)
	if err != nil {
		return writeError(errOut, &types.SnapError{
			Code:    "BOOST_PLAN_ERROR",
			Problem: "Failed to create boost plan",
			Cause:   err.Error(),
		})
	}

	if flags.JSON && flags.DryRun {
		return writeJSON(out, plan)
	}

	// Print Plan summary
	if targetProfile != "" {
		_, _ = fmt.Fprintf(out, "🚀 Boosting agent environment for '%s' (Profile: %s)\n", m.Name, targetProfile)
		_, _ = fmt.Fprintf(out, "📦 Resolved Skills (%d): %s\n\n", len(plan.ResolvedSkills), strings.Join(plan.ResolvedSkills, ", "))
	} else {
		_, _ = fmt.Fprintf(out, "🧹 Clearing boosted agent environment for '%s'...\n\n", m.Name)
	}

	if len(plan.Warnings) > 0 {
		for _, w := range plan.Warnings {
			_, _ = fmt.Fprintf(out, "⚠️ %s\n", w)
		}
		_, _ = fmt.Fprintln(out)
	}

	if len(plan.Mutations) == 0 {
		_, _ = fmt.Fprintln(out, "✨ Environment is already in sync with requested state. No changes needed.")
		return 0
	}

	for _, mut := range plan.Mutations {
		switch mut.Action {
		case boost.ActionCreateSymlink:
			_, _ = fmt.Fprintf(out, "   + [%s] %s -> %s\n", mut.Agent, mut.TargetPath, mut.SymlinkTarget)
		case boost.ActionRemoveSymlink:
			_, _ = fmt.Fprintf(out, "   - [%s] %s (pruned)\n", mut.Agent, mut.TargetPath)
		case boost.ActionKeepSymlink:
			_, _ = fmt.Fprintf(out, "   = [%s] %s (already active)\n", mut.Agent, mut.TargetPath)
		case boost.ActionConflictSkip:
			_, _ = fmt.Fprintf(out, "   ! [%s] %s (skipped: %s)\n", mut.Agent, mut.TargetPath, mut.Reason)
		}
	}
	_, _ = fmt.Fprintln(out)

	if flags.DryRun {
		_, _ = fmt.Fprintln(out, "🔍 Dry-run mode: no changes applied.")
		return 0
	}

	// 7. Apply Plan
	result, err := boost.ApplyBoostPlan(plan, runtime.ProjectPath)
	if err != nil {
		return writeError(errOut, &types.SnapError{
			Code:    "BOOST_APPLY_ERROR",
			Problem: "Failed to apply boost plan",
			Cause:   err.Error(),
		})
	}

	if flags.JSON {
		return writeJSON(out, result)
	}

	if !result.Success {
		_, _ = fmt.Fprintf(errOut, "❌ Encountered %d errors during apply:\n", len(result.Errors))
		for _, e := range result.Errors {
			_, _ = fmt.Fprintf(errOut, "   • %s\n", e)
		}
		return 1
	}

	if targetProfile != "" {
		_, _ = fmt.Fprintf(out, "✨ Agents (%s) are now boosted with '%s'!\n", formatAgentsList(m.Agents), targetProfile)
		_, _ = fmt.Fprintln(out, "💡 Run 'gandalf boost --clear' to restore a clean environment.")
	} else {
		_, _ = fmt.Fprintln(out, "✨ All Gandalf skill links removed. Clean environment restored.")
	}

	return 0
}

func setupAgentTemplates(projectRoot string, out, errOut io.Writer) int {
	// 1. Claude Code slash command
	claudeCmdDir := filepath.Join(projectRoot, ".claude", "commands")
	_ = os.MkdirAll(claudeCmdDir, 0755)
	claudeCmdFile := filepath.Join(claudeCmdDir, "boost.md")
	claudeContent := `---
description: Switch AI agent skill profile using Gandalf (e.g. /boost frontend, /boost infra, /boost --clear)
---
Execute ` + "`gandalf boost $ARGUMENTS`" + ` via the Bash tool to update current skills.
Report the boosted profile and active skills concisely.
`
	_ = os.WriteFile(claudeCmdFile, []byte(claudeContent), 0644)

	// 2. Cursor Rule
	cursorRuleDir := filepath.Join(projectRoot, ".cursor", "rules")
	_ = os.MkdirAll(cursorRuleDir, 0755)
	cursorRuleFile := filepath.Join(cursorRuleDir, "boost.mdc")
	cursorContent := `---
description: Gandalf Boost Controller
globs: *
---
When the user asks to switch skills, boost a profile, or runs ` + "`/boost <profile>`" + `:
1. Run ` + "`gandalf boost <profile>`" + ` via terminal.
2. Explain which skills were linked.
`
	_ = os.WriteFile(cursorRuleFile, []byte(cursorContent), 0644)

	// 3. Project Skill
	skillDir := filepath.Join(projectRoot, ".gandalf", "skills", "boost")
	_ = os.MkdirAll(skillDir, 0755)
	skillFile := filepath.Join(skillDir, "SKILL.md")
	skillContent := `---
name: boost
description: Gandalf skill profile controller to switch agent skills
---
# Gandalf Boost Skill

Use ` + "`gandalf boost [profile]`" + ` to selectively inject skills for the current task.
Use ` + "`gandalf boost --list`" + ` to view available profiles.
Use ` + "`gandalf boost --clear`" + ` to restore a clean environment.
`
	_ = os.WriteFile(skillFile, []byte(skillContent), 0644)

	_, _ = fmt.Fprintln(out, "✅ Agent boost templates installed successfully:")
	_, _ = fmt.Fprintf(out, "   • Claude Code command: .claude/commands/boost.md\n")
	_, _ = fmt.Fprintf(out, "   • Cursor rule: .cursor/rules/boost.mdc\n")
	_, _ = fmt.Fprintf(out, "   • Gandalf skill: .gandalf/skills/boost/SKILL.md\n")

	return 0
}

func formatAgentsList(agents []types.AgentID) string {
	var names []string
	for _, a := range agents {
		names = append(names, string(a))
	}
	return strings.Join(names, ", ")
}

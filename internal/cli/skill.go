package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/qyinm/gandalf/internal/gandalfcore/agents"
	"github.com/qyinm/gandalf/internal/gandalfcore/skills"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

// skillFlags are the options shared by every `gandalf skill` subcommand.
type skillFlags struct {
	CommonFlags
	Scope  string
	Agents []string
}

func (f *skillFlags) bind(cmd *cobra.Command, scopeHelp string) {
	f.bindFlags(cmd.Flags())
	cmd.Flags().StringVar(&f.Scope, "scope", "user", scopeHelp)
	cmd.Flags().StringSliceVar(&f.Agents, "agent", nil, "Limit to these agents (default: agents found in your home directory)")
}

// skillContext is the resolved form of skillFlags.
type skillContext struct {
	loc    skills.Location
	agents []types.AgentID
	scopes []skills.Scope
}

func (f *skillFlags) resolve(allowAllScopes bool) (skillContext, *types.SnapError) {
	runtime, snapErr := resolveRuntime(&f.CommonFlags)
	if snapErr != nil {
		return skillContext{}, snapErr
	}
	ctx := skillContext{loc: skills.Location{HomeDir: runtime.HomeDir, ProjectPath: runtime.ProjectPath}}

	switch f.Scope {
	case "user":
		ctx.scopes = []skills.Scope{skills.ScopeUser}
	case "project":
		ctx.scopes = []skills.Scope{skills.ScopeProject}
	case "all":
		if allowAllScopes {
			ctx.scopes = []skills.Scope{skills.ScopeUser, skills.ScopeProject}
			break
		}
		fallthrough
	default:
		valid := "user, project"
		if allowAllScopes {
			valid += ", all"
		}
		return skillContext{}, &types.SnapError{
			Code:    "GANDALF_INVALID_SCOPE",
			Problem: fmt.Sprintf("Invalid scope: %q.", f.Scope),
			Cause:   "This command does not support that scope.",
			Fix:     "Valid scopes: " + valid,
		}
	}

	parsed, snapErr := parseAgents(f.Agents)
	if snapErr != nil {
		return skillContext{}, snapErr
	}
	ctx.agents = parsed
	if len(ctx.agents) == 0 {
		ctx.agents = skills.DetectAgents(ctx.loc)
	}
	return ctx, nil
}

func parseAgents(names []string) ([]types.AgentID, *types.SnapError) {
	var parsed []types.AgentID
	for _, name := range names {
		agent := types.ParseAgentID(name)
		if !agents.IsCurrentSupported(agent) || agent.String() != name {
			return nil, &types.SnapError{
				Code:    "GANDALF_INVALID_AGENT",
				Problem: fmt.Sprintf("Invalid agent: %q.", name),
				Cause:   "An unsupported agent identifier was provided.",
				Fix:     "Valid agents: " + strings.Join(agents.CurrentSupportedNames(), ", "),
			}
		}
		parsed = append(parsed, agent)
	}
	return parsed, nil
}

func skillError(w io.Writer, code, problem string, err error, fix string) int {
	return writeError(w, &types.SnapError{Code: code, Problem: problem, Cause: err.Error(), Fix: fix})
}

func newSkillCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "skill",
		Aliases: []string{"skills"},
		Short:   "See and manage skills across Claude Code, Codex, and Cursor.",
		Long: `Skill lists the skills each coding agent has installed, shows where they are
missing or differ, and copies, adds, or removes them across agents.

Nothing is deleted outright: replaced and removed skills move to ~/.gandalf/trash.`,
	}
	cmd.AddCommand(newSkillListCmd())
	cmd.AddCommand(newSkillShowCmd())
	cmd.AddCommand(newSkillAddCmd())
	cmd.AddCommand(newSkillSyncCmd())
	cmd.AddCommand(newSkillRemoveCmd())
	return cmd
}

func newSkillListCmd() *cobra.Command {
	var flags skillFlags
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List skills and how they line up across agents.",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return exitWith(runSkillList(cmd, &flags))
		},
	}
	flags.bind(cmd, "Skill scope: user, project, or all")
	return cmd
}

func exitWith(code int) error {
	if code != 0 {
		return errExit(code)
	}
	return nil
}

func runSkillList(cmd *cobra.Command, flags *skillFlags) int {
	ctx, snapErr := flags.resolve(true)
	if snapErr != nil {
		return writeError(cmd.ErrOrStderr(), snapErr)
	}
	inv, err := skills.Discover(ctx.loc, ctx.agents, ctx.scopes)
	if err != nil {
		return skillError(cmd.ErrOrStderr(), "GANDALF_SKILL_SCAN_FAILED", "Failed to read skill directories.", err, "Check that the agent skill directories are readable.")
	}
	out := cmd.OutOrStdout()
	if flags.JSON {
		return writeJSON(out, inv)
	}
	renderInventory(out, inv, ctx.scopes)
	return 0
}

func renderInventory(out io.Writer, inv skills.Inventory, scopes []skills.Scope) {
	if len(inv.Skills) == 0 {
		fmt.Fprintf(out, "No skills found for %s.\n", agentList(inv.Agents))
		fmt.Fprintln(out, "Add one with `gandalf skill add <path-to-skill-dir>`.")
		return
	}

	showScope := len(scopes) > 1
	table := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	header := []string{"SKILL"}
	if showScope {
		header = append(header, "SCOPE")
	}
	for _, agent := range inv.Agents {
		header = append(header, strings.ToUpper(agents.DisplayName(agent)))
	}
	header = append(header, "STATUS")
	fmt.Fprintln(table, strings.Join(header, "\t"))

	counts := make(map[skills.Status]int)
	for _, skill := range inv.Skills {
		counts[skill.Status]++
		row := []string{skill.Name}
		if showScope {
			row = append(row, string(skill.Scope))
		}
		for _, agent := range inv.Agents {
			row = append(row, inventoryCell(skill, agent))
		}
		row = append(row, string(skill.Status))
		fmt.Fprintln(table, strings.Join(row, "\t"))
	}
	_ = table.Flush()

	fmt.Fprintf(out, "\n%d skill(s): %d synced, %d partial, %d diverged\n",
		len(inv.Skills), counts[skills.StatusSynced], counts[skills.StatusPartial], counts[skills.StatusDiverged])
	if counts[skills.StatusPartial] > 0 {
		fmt.Fprintln(out, "Run `gandalf skill sync` to copy partial skills to the agents missing them.")
	}
	if counts[skills.StatusDiverged] > 0 {
		fmt.Fprintln(out, "Diverged skills differ between agents: `gandalf skill sync <name> --from <agent>` picks the copy that wins.")
	}
}

// inventoryCell renders one agent's copy: present, missing, or — for diverged
// skills — the short content hash so differing copies can be told apart.
func inventoryCell(skill skills.Skill, agent types.AgentID) string {
	install, ok := skill.InstallFor(agent)
	if !ok {
		return "-"
	}
	cell := "yes"
	if skill.Status == skills.StatusDiverged {
		cell = shortHash(install.Hash)
	}
	if install.Linked {
		cell += " (link)"
	}
	return cell
}

func shortHash(hash string) string {
	if len(hash) > 7 {
		return hash[:7]
	}
	return hash
}

func agentList(ids []types.AgentID) string {
	names := make([]string, len(ids))
	for i, id := range ids {
		names[i] = agents.DisplayName(id)
	}
	return strings.Join(names, ", ")
}

func newSkillShowCmd() *cobra.Command {
	var flags skillFlags
	cmd := &cobra.Command{
		Use:   "show <name>",
		Short: "Show where a skill is installed and print its SKILL.md.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return exitWith(runSkillShow(cmd, args[0], &flags))
		},
	}
	flags.bind(cmd, "Skill scope: user or project")
	return cmd
}

func runSkillShow(cmd *cobra.Command, name string, flags *skillFlags) int {
	ctx, snapErr := flags.resolve(false)
	if snapErr != nil {
		return writeError(cmd.ErrOrStderr(), snapErr)
	}
	inv, err := skills.Discover(ctx.loc, ctx.agents, ctx.scopes)
	if err != nil {
		return skillError(cmd.ErrOrStderr(), "GANDALF_SKILL_SCAN_FAILED", "Failed to read skill directories.", err, "Check that the agent skill directories are readable.")
	}
	skill, ok := inv.Find(name, ctx.scopes[0])
	if !ok {
		return skillError(cmd.ErrOrStderr(), "GANDALF_SKILL_NOT_FOUND", fmt.Sprintf("Skill %q not found.", name),
			fmt.Errorf("no %s-scope skill with that name in %s", ctx.scopes[0], agentList(ctx.agents)),
			"Run `gandalf skill list --scope all` to see installed skills.")
	}
	out := cmd.OutOrStdout()
	if flags.JSON {
		return writeJSON(out, skill)
	}

	fmt.Fprintf(out, "%s (%s scope, %s)\n", skill.Name, skill.Scope, skill.Status)
	if skill.Description != "" {
		fmt.Fprintln(out, skill.Description)
	}
	fmt.Fprintln(out)
	table := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	for _, install := range skill.Installs {
		path := install.Path
		if install.Linked {
			path += " -> " + install.LinkTarget
		}
		fmt.Fprintf(table, "%s\t%s\t%s\n", agents.DisplayName(install.Agent), shortHash(install.Hash), path)
	}
	for _, agent := range skill.Missing {
		fmt.Fprintf(table, "%s\t-\tnot installed\n", agents.DisplayName(agent))
	}
	_ = table.Flush()

	// For a diverged skill the first copy is only one of several; say which.
	shown := skill.Installs[0]
	body, err := os.ReadFile(filepath.Join(shown.Path, skills.Entrypoint))
	if err != nil {
		return skillError(cmd.ErrOrStderr(), "GANDALF_SKILL_READ_FAILED", "Failed to read SKILL.md.", err, "Check that the file is readable.")
	}
	fmt.Fprintf(out, "\n--- %s (%s) ---\n%s", skills.Entrypoint, agents.DisplayName(shown.Agent), body)
	if len(body) > 0 && body[len(body)-1] != '\n' {
		fmt.Fprintln(out)
	}
	return 0
}

func newSkillAddCmd() *cobra.Command {
	var flags skillFlags
	var name string
	var force, dryRun bool
	cmd := &cobra.Command{
		Use:   "add <path>",
		Short: "Install a skill directory into your agents.",
		Long: `Add copies a local skill directory (one containing SKILL.md) into every
selected agent. An agent that already holds a different copy is left alone
unless --force is given; the replaced copy moves to ~/.gandalf/trash.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, snapErr := flags.resolve(false)
			if snapErr != nil {
				return exitWith(writeError(cmd.ErrOrStderr(), snapErr))
			}
			changes, err := skills.Add(args[0], skills.AddOptions{
				Loc: ctx.loc, Scope: ctx.scopes[0], Agents: ctx.agents, Name: name, Force: force, DryRun: dryRun,
			})
			return exitWith(reportChanges(cmd, changes, err, dryRun, flags.JSON))
		},
	}
	flags.bind(cmd, "Skill scope: user or project")
	cmd.Flags().StringVar(&name, "name", "", "Install under this name (default: the source directory name)")
	cmd.Flags().BoolVar(&force, "force", false, "Replace copies that differ from the source")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would change without writing")
	return cmd
}

func newSkillSyncCmd() *cobra.Command {
	var flags skillFlags
	var from string
	var dryRun bool
	cmd := &cobra.Command{
		Use:   "sync [name...]",
		Short: "Copy skills to the agents that are missing them.",
		Long: `Sync brings every selected agent to the same set of skills. With no names it
syncs all skills in the scope.

Skills whose copies already agree are copied to the agents missing them.
Skills whose copies differ are left alone until you pass --from <agent> to
choose the copy that wins; overwritten copies move to ~/.gandalf/trash.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, snapErr := flags.resolve(false)
			if snapErr != nil {
				return exitWith(writeError(cmd.ErrOrStderr(), snapErr))
			}
			var fromAgent types.AgentID
			if from != "" {
				parsed, snapErr := parseAgents([]string{from})
				if snapErr != nil {
					return exitWith(writeError(cmd.ErrOrStderr(), snapErr))
				}
				fromAgent = parsed[0]
			}
			changes, err := skills.Sync(skills.SyncOptions{
				Loc: ctx.loc, Scope: ctx.scopes[0], Names: args, From: fromAgent, To: ctx.agents, DryRun: dryRun,
			})
			return exitWith(reportChanges(cmd, changes, err, dryRun, flags.JSON))
		},
	}
	flags.bind(cmd, "Skill scope: user or project")
	cmd.Flags().StringVar(&from, "from", "", "Agent whose copy wins when copies differ")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would change without writing")
	return cmd
}

func newSkillRemoveCmd() *cobra.Command {
	var flags skillFlags
	var dryRun bool
	cmd := &cobra.Command{
		Use:     "remove <name>",
		Aliases: []string{"rm"},
		Short:   "Remove a skill from your agents (moved to ~/.gandalf/trash).",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, snapErr := flags.resolve(false)
			if snapErr != nil {
				return exitWith(writeError(cmd.ErrOrStderr(), snapErr))
			}
			changes, err := skills.Remove(args[0], skills.RemoveOptions{
				Loc: ctx.loc, Scope: ctx.scopes[0], Agents: ctx.agents, DryRun: dryRun,
			})
			return exitWith(reportChanges(cmd, changes, err, dryRun, flags.JSON))
		},
	}
	flags.bind(cmd, "Skill scope: user or project")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would change without writing")
	return cmd
}

// reportChanges prints the outcome of a mutating command. It exits non-zero
// when the operation failed or any change was refused, and still reports the
// changes that did land before a failure.
func reportChanges(cmd *cobra.Command, changes []skills.Change, err error, dryRun, asJSON bool) int {
	out := cmd.OutOrStdout()
	code := 0
	if skills.HasConflicts(changes) {
		code = 1
	}
	if asJSON {
		if changes == nil {
			changes = []skills.Change{}
		}
		payload := map[string]any{"dryRun": dryRun, "changes": changes}
		if err != nil {
			payload["error"] = err.Error()
			code = 1
		}
		if writeJSON(out, payload) != 0 {
			return 1
		}
		return code
	}

	if len(changes) == 0 && err == nil {
		fmt.Fprintln(out, "Nothing to do: skills already line up.")
		return 0
	}
	for _, change := range changes {
		fmt.Fprintln(out, formatChange(change, dryRun))
	}
	if dryRun && len(changes) > 0 {
		fmt.Fprintln(out, "\nDry run: nothing was written.")
	}
	if err != nil {
		return skillError(cmd.ErrOrStderr(), "GANDALF_SKILL_OPERATION_FAILED", "The skill operation did not complete.", err, "Fix the cause above and run the command again; changes listed above were applied.")
	}
	return code
}

func formatChange(change skills.Change, dryRun bool) string {
	subject := change.Skill
	if change.Agent != "" {
		subject = fmt.Sprintf("%s [%s]", change.Skill, agents.DisplayName(change.Agent))
	}
	verb := map[skills.Action]string{
		skills.ActionInstall:  "installed",
		skills.ActionReplace:  "replaced",
		skills.ActionRemove:   "removed",
		skills.ActionUnlink:   "unlinked",
		skills.ActionSkip:     "unchanged",
		skills.ActionConflict: "skipped",
	}[change.Action]
	if dryRun {
		verb = map[skills.Action]string{
			skills.ActionInstall:  "would install",
			skills.ActionReplace:  "would replace",
			skills.ActionRemove:   "would remove",
			skills.ActionUnlink:   "would unlink",
			skills.ActionSkip:     "unchanged",
			skills.ActionConflict: "would skip",
		}[change.Action]
	}
	line := fmt.Sprintf("%-14s %s", verb, subject)
	if change.Reason != "" {
		line += ": " + change.Reason
	}
	if change.Backup != "" {
		line += " (previous copy: " + change.Backup + ")"
	}
	return line
}

package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

// Action is what a Change does to one agent's copy of a skill.
type Action string

const (
	// ActionInstall copies a skill into an agent that lacks it.
	ActionInstall Action = "install"
	// ActionReplace overwrites a differing copy; the old copy goes to trash.
	ActionReplace Action = "replace"
	// ActionRemove moves a copy to trash.
	ActionRemove Action = "remove"
	// ActionUnlink removes a symlinked skill without touching its target.
	ActionUnlink Action = "unlink"
	// ActionSkip means nothing needed doing.
	ActionSkip Action = "skip"
	// ActionConflict means Gandalf refused to act; Reason says why.
	ActionConflict Action = "conflict"
)

// Change is one planned or applied mutation. With DryRun the same values are
// returned without touching the filesystem.
type Change struct {
	Action Action        `json:"action"`
	Skill  string        `json:"skill"`
	Agent  types.AgentID `json:"agent,omitempty"`
	Scope  Scope         `json:"scope"`
	Path   string        `json:"path,omitempty"`
	Source string        `json:"source,omitempty"`
	Reason string        `json:"reason,omitempty"`
	// Backup is where the previous copy was moved, when one was displaced.
	Backup string `json:"backup,omitempty"`
}

// HasConflicts reports whether any change was refused.
func HasConflicts(changes []Change) bool {
	for _, change := range changes {
		if change.Action == ActionConflict {
			return true
		}
	}
	return false
}

// TrashDir is where displaced and removed skills are kept for recovery.
func TrashDir(loc Location) string {
	return filepath.Join(loc.HomeDir, ".gandalf", "trash")
}

// AddOptions configures Add.
type AddOptions struct {
	Loc    Location
	Scope  Scope
	Agents []types.AgentID
	// Name overrides the skill name; it defaults to the source directory name.
	Name   string
	Force  bool
	DryRun bool
}

// Add installs the skill directory at src into every agent in opts.Agents.
func Add(src string, opts AddOptions) ([]Change, error) {
	absSrc, err := filepath.Abs(src)
	if err != nil {
		return nil, err
	}
	if filepath.Base(absSrc) == Entrypoint {
		absSrc = filepath.Dir(absSrc)
	}
	resolvedSrc, err := filepath.EvalSymlinks(absSrc)
	if err != nil {
		return nil, fmt.Errorf("skill source %s: %w", src, err)
	}
	if info, err := os.Stat(filepath.Join(resolvedSrc, Entrypoint)); err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a skill: no %s found", src, Entrypoint)
	}
	name := opts.Name
	if name == "" {
		name = filepath.Base(absSrc)
	}
	if err := ValidateName(name); err != nil {
		return nil, err
	}
	srcHash, err := HashDir(resolvedSrc)
	if err != nil {
		return nil, err
	}

	var changes []Change
	for _, agent := range opts.Agents {
		root, err := Root(agent, opts.Scope, opts.Loc)
		if err != nil {
			return nil, err
		}
		dest := filepath.Join(root, name)
		change := planWrite(name, agent, opts.Scope, dest, resolvedSrc, srcHash, opts.Force, "use --force to replace it")
		changes = append(changes, change)
	}
	return apply(changes, opts.Loc, opts.DryRun)
}

// SyncOptions configures Sync.
type SyncOptions struct {
	Loc   Location
	Scope Scope
	// Names limits the sync to these skills; empty means every skill.
	Names []string
	// From names the agent whose copy wins. When empty, only skills whose
	// existing copies already agree are propagated.
	From   types.AgentID
	To     []types.AgentID
	DryRun bool
}

// Sync copies skills across agents so every agent in opts.To holds the same
// content. Copies that differ are only overwritten when opts.From is set.
func Sync(opts SyncOptions) ([]Change, error) {
	view := append([]types.AgentID(nil), opts.To...)
	if opts.From != "" && !containsAgent(view, opts.From) {
		view = append(view, opts.From)
	}
	inv, err := Discover(opts.Loc, view, []Scope{opts.Scope})
	if err != nil {
		return nil, err
	}

	selected := inv.Skills
	if len(opts.Names) > 0 {
		selected = nil
		for _, name := range opts.Names {
			skill, ok := inv.Find(name, opts.Scope)
			if !ok {
				return nil, fmt.Errorf("skill %q is not installed in %s scope", name, opts.Scope)
			}
			selected = append(selected, skill)
		}
	}

	var changes []Change
	for _, skill := range selected {
		source, ok, reason := pickSource(skill, opts.From)
		if !ok {
			// Without explicit names, a skill the --from agent lacks is simply
			// not that agent's to propagate.
			if opts.From != "" && len(opts.Names) == 0 {
				continue
			}
			changes = append(changes, Change{Action: ActionConflict, Skill: skill.Name, Scope: skill.Scope, Reason: reason})
			continue
		}
		resolvedSrc, err := filepath.EvalSymlinks(source.Path)
		if err != nil {
			return nil, err
		}
		for _, agent := range opts.To {
			if agent == source.Agent {
				continue
			}
			root, err := Root(agent, opts.Scope, opts.Loc)
			if err != nil {
				return nil, err
			}
			dest := filepath.Join(root, skill.Name)
			change := planWrite(skill.Name, agent, opts.Scope, dest, resolvedSrc, source.Hash, opts.From != "", "pass --from <agent> to choose which copy wins")
			if change.Action == ActionSkip {
				continue
			}
			changes = append(changes, change)
		}
	}
	return apply(changes, opts.Loc, opts.DryRun)
}

func pickSource(skill Skill, from types.AgentID) (Install, bool, string) {
	if from != "" {
		install, ok := skill.InstallFor(from)
		if !ok {
			return Install{}, false, fmt.Sprintf("not installed in %s", from)
		}
		return install, true, ""
	}
	if skill.Status == StatusDiverged {
		return Install{}, false, "copies differ; pass --from <agent> to choose which copy wins"
	}
	return skill.Installs[0], true, ""
}

// planWrite decides how to bring dest in line with the source skill.
func planWrite(name string, agent types.AgentID, scope Scope, dest, resolvedSrc, srcHash string, replace bool, replaceHint string) Change {
	change := Change{Skill: name, Agent: agent, Scope: scope, Path: dest, Source: resolvedSrc}

	linfo, err := os.Lstat(dest)
	if err != nil {
		change.Action = ActionInstall
		return change
	}
	if resolvedDest, err := filepath.EvalSymlinks(dest); err == nil && resolvedDest == resolvedSrc {
		change.Action = ActionSkip
		change.Reason = "already points at the source"
		return change
	}
	existing, isSkill := inspect(dest, agent, scope)
	if isSkill && existing.Hash == srcHash {
		change.Action = ActionSkip
		change.Reason = "already up to date"
		return change
	}
	if linfo.Mode()&os.ModeSymlink != 0 {
		change.Action = ActionConflict
		change.Reason = "is a symlink with different content; remove the link first"
		return change
	}
	if !replace {
		change.Action = ActionConflict
		if isSkill {
			change.Reason = "a different copy is already installed; " + replaceHint
		} else {
			change.Reason = "path exists and is not a skill; " + replaceHint
		}
		return change
	}
	change.Action = ActionReplace
	return change
}

// RemoveOptions configures Remove.
type RemoveOptions struct {
	Loc    Location
	Scope  Scope
	Agents []types.AgentID
	DryRun bool
}

// Remove takes the named skill out of every agent in opts.Agents. Real
// directories move to trash; symlinked skills are only unlinked.
func Remove(name string, opts RemoveOptions) ([]Change, error) {
	inv, err := Discover(opts.Loc, opts.Agents, []Scope{opts.Scope})
	if err != nil {
		return nil, err
	}
	skill, ok := inv.Find(name, opts.Scope)
	if !ok {
		return nil, fmt.Errorf("skill %q is not installed in %s scope", name, opts.Scope)
	}
	var changes []Change
	for _, install := range skill.Installs {
		action := ActionRemove
		if install.Linked {
			action = ActionUnlink
		}
		changes = append(changes, Change{Action: action, Skill: name, Agent: install.Agent, Scope: install.Scope, Path: install.Path})
	}
	return apply(changes, opts.Loc, opts.DryRun)
}

func apply(changes []Change, loc Location, dryRun bool) ([]Change, error) {
	if dryRun {
		return changes, nil
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	for i := range changes {
		change := &changes[i]
		switch change.Action {
		case ActionInstall:
			if err := copyTree(change.Source, change.Path); err != nil {
				return changes[:i], fmt.Errorf("install %s for %s: %w", change.Skill, change.Agent, err)
			}
		case ActionReplace:
			backup, err := moveToTrash(change.Path, loc, stamp, change)
			if err != nil {
				return changes[:i], fmt.Errorf("back up %s for %s: %w", change.Skill, change.Agent, err)
			}
			change.Backup = backup
			if err := copyTree(change.Source, change.Path); err != nil {
				// Put the previous copy back so a failed replace is not a removal.
				_ = os.Rename(backup, change.Path)
				return changes[:i], fmt.Errorf("replace %s for %s: %w", change.Skill, change.Agent, err)
			}
		case ActionRemove:
			backup, err := moveToTrash(change.Path, loc, stamp, change)
			if err != nil {
				return changes[:i], fmt.Errorf("remove %s for %s: %w", change.Skill, change.Agent, err)
			}
			change.Backup = backup
		case ActionUnlink:
			if err := os.Remove(change.Path); err != nil {
				return changes[:i], fmt.Errorf("unlink %s for %s: %w", change.Skill, change.Agent, err)
			}
		}
	}
	return changes, nil
}

// moveToTrash moves path under the trash directory and returns its new
// location. It falls back to copy-then-delete when a rename cannot cross
// filesystems.
func moveToTrash(path string, loc Location, stamp string, change *Change) (string, error) {
	base := filepath.Join(TrashDir(loc), stamp, string(change.Scope), string(change.Agent), change.Skill)
	dest := base
	for suffix := 2; ; suffix++ {
		if _, err := os.Lstat(dest); os.IsNotExist(err) {
			break
		}
		dest = fmt.Sprintf("%s-%d", base, suffix)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(path, dest); err == nil {
		return dest, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(dest, data, info.Mode().Perm()); err != nil {
			return "", err
		}
		return dest, os.Remove(path)
	}
	if err := os.CopyFS(dest, os.DirFS(path)); err != nil {
		_ = os.RemoveAll(dest)
		return "", err
	}
	return dest, os.RemoveAll(path)
}

func containsAgent(list []types.AgentID, agent types.AgentID) bool {
	for _, candidate := range list {
		if candidate == agent {
			return true
		}
	}
	return false
}

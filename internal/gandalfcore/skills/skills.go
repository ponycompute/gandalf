// Package skills inventories and manages agent skills (directories holding a
// SKILL.md entrypoint) across the supported coding agents.
package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/qyinm/gandalf/internal/gandalfcore/agents"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

// Entrypoint is the file that makes a directory a skill.
const Entrypoint = "SKILL.md"

// Scope says whether a skill lives in the user's home or in a project.
type Scope string

const (
	ScopeUser    Scope = "user"
	ScopeProject Scope = "project"
)

// Status summarizes how one skill lines up across the agents in view.
type Status string

const (
	// StatusSynced: every agent in view has identical content.
	StatusSynced Status = "synced"
	// StatusPartial: content is identical where present, but some agents lack it.
	StatusPartial Status = "partial"
	// StatusDiverged: at least two agents hold different content.
	StatusDiverged Status = "diverged"
)

// Location carries the directories skill roots are resolved against.
type Location struct {
	HomeDir     string
	ProjectPath string
}

// Install is one copy of a skill inside one agent's skill root.
type Install struct {
	Agent types.AgentID `json:"agent"`
	Scope Scope         `json:"scope"`
	Path  string        `json:"path"`
	Hash  string        `json:"hash"`
	// Linked is true when the skill directory is a symlink. Gandalf never
	// rewrites or follows-and-deletes linked skills; it only unlinks them.
	Linked     bool   `json:"linked,omitempty"`
	LinkTarget string `json:"linkTarget,omitempty"`
}

// Skill is one named skill within a scope, with every agent copy found.
type Skill struct {
	Name        string          `json:"name"`
	Scope       Scope           `json:"scope"`
	Description string          `json:"description,omitempty"`
	Status      Status          `json:"status"`
	Installs    []Install       `json:"installs"`
	Missing     []types.AgentID `json:"missing,omitempty"`
}

// InstallFor returns the copy held by agent, if any.
func (s Skill) InstallFor(agent types.AgentID) (Install, bool) {
	for _, install := range s.Installs {
		if install.Agent == agent {
			return install, true
		}
	}
	return Install{}, false
}

// Inventory is the cross-agent view of skills for the requested scopes.
type Inventory struct {
	Agents []types.AgentID `json:"agents"`
	Skills []Skill         `json:"skills"`
}

// Find returns the skill with the given name and scope.
func (inv Inventory) Find(name string, scope Scope) (Skill, bool) {
	for _, skill := range inv.Skills {
		if skill.Name == name && skill.Scope == scope {
			return skill, true
		}
	}
	return Skill{}, false
}

var agentConfigDirs = map[types.AgentID]string{
	types.AgentClaudeCode: ".claude",
	types.AgentCodex:      ".codex",
	types.AgentCursor:     ".cursor",
}

// Root returns the directory where agent keeps its skills for scope.
func Root(agent types.AgentID, scope Scope, loc Location) (string, error) {
	configDir, ok := agentConfigDirs[agent]
	if !ok {
		return "", fmt.Errorf("agent %q has no known skill directory", agent)
	}
	switch scope {
	case ScopeUser:
		return filepath.Join(loc.HomeDir, configDir, "skills"), nil
	case ScopeProject:
		return filepath.Join(loc.ProjectPath, configDir, "skills"), nil
	default:
		return "", fmt.Errorf("unknown scope %q", scope)
	}
}

// DetectAgents returns the supported agents that have a config directory in
// the user's home. It falls back to every supported agent when none is found,
// so a fresh machine still gets a meaningful view.
func DetectAgents(loc Location) []types.AgentID {
	var detected []types.AgentID
	for _, agent := range agents.CurrentSupportedIDs() {
		info, err := os.Stat(filepath.Join(loc.HomeDir, agentConfigDirs[agent]))
		if err == nil && info.IsDir() {
			detected = append(detected, agent)
		}
	}
	if len(detected) == 0 {
		return agents.CurrentSupportedIDs()
	}
	return detected
}

var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// ValidateName rejects names that could not be a single safe directory name.
func ValidateName(name string) error {
	if !namePattern.MatchString(name) {
		return fmt.Errorf("invalid skill name %q: use letters, digits, '.', '_' or '-', starting with a letter or digit", name)
	}
	return nil
}

// Discover builds the inventory for the given agents and scopes.
func Discover(loc Location, agentIDs []types.AgentID, scopes []Scope) (Inventory, error) {
	inv := Inventory{Agents: append([]types.AgentID(nil), agentIDs...)}

	type key struct {
		scope Scope
		name  string
	}
	grouped := make(map[key]*Skill)

	for _, scope := range scopes {
		for _, agent := range agentIDs {
			root, err := Root(agent, scope, loc)
			if err != nil {
				return Inventory{}, err
			}
			installs, err := scanRoot(root, agent, scope)
			if err != nil {
				return Inventory{}, err
			}
			for _, found := range installs {
				k := key{scope: scope, name: found.name}
				skill, ok := grouped[k]
				if !ok {
					skill = &Skill{Name: found.name, Scope: scope}
					grouped[k] = skill
				}
				if skill.Description == "" {
					skill.Description = found.description
				}
				skill.Installs = append(skill.Installs, found.install)
			}
		}
	}

	for _, skill := range grouped {
		skill.Missing, skill.Status = classify(*skill, agentIDs)
		inv.Skills = append(inv.Skills, *skill)
	}
	sort.Slice(inv.Skills, func(i, j int) bool {
		if inv.Skills[i].Scope != inv.Skills[j].Scope {
			return inv.Skills[i].Scope == ScopeUser
		}
		return inv.Skills[i].Name < inv.Skills[j].Name
	})
	return inv, nil
}

func classify(skill Skill, agentIDs []types.AgentID) ([]types.AgentID, Status) {
	var missing []types.AgentID
	hashes := make(map[string]struct{})
	for _, agent := range agentIDs {
		install, ok := skill.InstallFor(agent)
		if !ok {
			missing = append(missing, agent)
			continue
		}
		hashes[install.Hash] = struct{}{}
	}
	switch {
	case len(hashes) > 1:
		return missing, StatusDiverged
	case len(missing) > 0:
		return missing, StatusPartial
	default:
		return missing, StatusSynced
	}
}

type foundSkill struct {
	name        string
	description string
	install     Install
}

// scanRoot lists the skills directly under one agent skill root. A missing
// root is an empty result, not an error.
func scanRoot(root string, agent types.AgentID, scope Scope) ([]foundSkill, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read skill directory %s: %w", root, err)
	}

	var found []foundSkill
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		path := filepath.Join(root, name)
		install, ok := inspect(path, agent, scope)
		if !ok {
			continue
		}
		found = append(found, foundSkill{
			name:        name,
			description: readDescription(filepath.Join(path, Entrypoint)),
			install:     install,
		})
	}
	return found, nil
}

// inspect reports the install at path, or false when path is not a skill.
func inspect(path string, agent types.AgentID, scope Scope) (Install, bool) {
	linfo, err := os.Lstat(path)
	if err != nil {
		return Install{}, false
	}
	install := Install{Agent: agent, Scope: scope, Path: path}
	if linfo.Mode()&os.ModeSymlink != 0 {
		install.Linked = true
		if target, err := os.Readlink(path); err == nil {
			install.LinkTarget = target
		}
	}

	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return Install{}, false
	}
	if info, err := os.Stat(resolved); err != nil || !info.IsDir() {
		return Install{}, false
	}
	if info, err := os.Stat(filepath.Join(resolved, Entrypoint)); err != nil || !info.Mode().IsRegular() {
		return Install{}, false
	}

	hash, err := HashDir(resolved)
	if err != nil {
		return Install{}, false
	}
	install.Hash = hash
	return install, true
}

var (
	frontmatterPattern = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---`)
	descriptionPattern = regexp.MustCompile(`(?m)^description:[ \t]*(.*)$`)
)

// readDescription extracts a single-line `description:` from SKILL.md
// frontmatter. Block scalars and missing values yield an empty string.
func readDescription(entrypoint string) string {
	text, err := os.ReadFile(entrypoint)
	if err != nil {
		return ""
	}
	frontmatter := frontmatterPattern.FindSubmatch(text)
	if frontmatter == nil {
		return ""
	}
	match := descriptionPattern.FindSubmatch(frontmatter[1])
	if match == nil {
		return ""
	}
	value := strings.TrimSpace(string(match[1]))
	if value == "|" || value == ">" || strings.HasPrefix(value, "|-") || strings.HasPrefix(value, ">-") {
		return ""
	}
	if len(value) >= 2 {
		first, last := value[0], value[len(value)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			value = value[1 : len(value)-1]
		}
	}
	return value
}

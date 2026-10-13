package skills_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/qyinm/gandalf/internal/gandalfcore/skills"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

var allAgents = []types.AgentID{types.AgentClaudeCode, types.AgentCodex, types.AgentCursor}

func newLocation(t *testing.T) skills.Location {
	t.Helper()
	base := t.TempDir()
	loc := skills.Location{HomeDir: filepath.Join(base, "home"), ProjectPath: filepath.Join(base, "project")}
	for _, dir := range []string{loc.HomeDir, loc.ProjectPath} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return loc
}

func writeSkill(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, skills.Entrypoint), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func installSkill(t *testing.T, loc skills.Location, agent types.AgentID, name, body string) string {
	t.Helper()
	root, err := skills.Root(agent, skills.ScopeUser, loc)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, name)
	writeSkill(t, dir, body)
	return dir
}

func discover(t *testing.T, loc skills.Location) skills.Inventory {
	t.Helper()
	inv, err := skills.Discover(loc, allAgents, []skills.Scope{skills.ScopeUser})
	if err != nil {
		t.Fatal(err)
	}
	return inv
}

func mustFind(t *testing.T, inv skills.Inventory, name string) skills.Skill {
	t.Helper()
	skill, ok := inv.Find(name, skills.ScopeUser)
	if !ok {
		t.Fatalf("skill %q not in inventory", name)
	}
	return skill
}

func TestDiscoverClassifiesSkillsAcrossAgents(t *testing.T) {
	loc := newLocation(t)
	for _, agent := range allAgents {
		installSkill(t, loc, agent, "everywhere", "---\ndescription: \"Shared skill\"\n---\nbody\n")
	}
	installSkill(t, loc, types.AgentClaudeCode, "claude-only", "one\n")
	installSkill(t, loc, types.AgentClaudeCode, "drifted", "version a\n")
	installSkill(t, loc, types.AgentCodex, "drifted", "version b\n")

	// Directories without SKILL.md and hidden directories are not skills.
	root, _ := skills.Root(types.AgentCodex, skills.ScopeUser, loc)
	if err := os.MkdirAll(filepath.Join(root, "not-a-skill"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeSkill(t, filepath.Join(root, ".system"), "hidden\n")

	inv := discover(t, loc)
	if len(inv.Skills) != 3 {
		t.Fatalf("got %d skills, want 3: %+v", len(inv.Skills), inv.Skills)
	}

	everywhere := mustFind(t, inv, "everywhere")
	if everywhere.Status != skills.StatusSynced || everywhere.Description != "Shared skill" {
		t.Fatalf("everywhere = %+v", everywhere)
	}
	claudeOnly := mustFind(t, inv, "claude-only")
	if claudeOnly.Status != skills.StatusPartial || len(claudeOnly.Missing) != 2 {
		t.Fatalf("claude-only = %+v", claudeOnly)
	}
	if drifted := mustFind(t, inv, "drifted"); drifted.Status != skills.StatusDiverged {
		t.Fatalf("drifted = %+v", drifted)
	}
}

func TestDiscoverKeepsScopesSeparate(t *testing.T) {
	loc := newLocation(t)
	installSkill(t, loc, types.AgentClaudeCode, "shared-name", "user\n")
	writeSkill(t, filepath.Join(loc.ProjectPath, ".claude", "skills", "shared-name"), "project\n")

	inv, err := skills.Discover(loc, allAgents, []skills.Scope{skills.ScopeUser, skills.ScopeProject})
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Skills) != 2 || inv.Skills[0].Scope != skills.ScopeUser || inv.Skills[1].Scope != skills.ScopeProject {
		t.Fatalf("inventory = %+v", inv.Skills)
	}
}

func TestHashIgnoresNoiseAndTracksContent(t *testing.T) {
	base := t.TempDir()
	a, b := filepath.Join(base, "a"), filepath.Join(base, "b")
	writeSkill(t, a, "same\n")
	writeSkill(t, b, "same\n")
	if err := os.WriteFile(filepath.Join(b, ".DS_Store"), []byte("noise"), 0o644); err != nil {
		t.Fatal(err)
	}
	hashA, _ := skills.HashDir(a)
	hashB, _ := skills.HashDir(b)
	if hashA != hashB {
		t.Fatal("ignored files changed the hash")
	}
	if err := os.WriteFile(filepath.Join(b, "extra.md"), []byte("more"), 0o644); err != nil {
		t.Fatal(err)
	}
	if hashB2, _ := skills.HashDir(b); hashB2 == hashA {
		t.Fatal("an added file did not change the hash")
	}
}

func TestAddInstallsAndRefusesToOverwriteWithoutForce(t *testing.T) {
	loc := newLocation(t)
	src := filepath.Join(t.TempDir(), "reviewer")
	writeSkill(t, src, "v1\n")
	if err := os.MkdirAll(filepath.Join(src, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "scripts", "run.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A link escaping the skill must not be carried into agent directories.
	if err := os.Symlink("/etc/hosts", filepath.Join(src, "escape")); err != nil {
		t.Fatal(err)
	}
	existing := installSkill(t, loc, types.AgentCodex, "reviewer", "local edits\n")

	opts := skills.AddOptions{Loc: loc, Scope: skills.ScopeUser, Agents: allAgents}
	changes, err := skills.Add(src, opts)
	if err != nil {
		t.Fatal(err)
	}
	if !skills.HasConflicts(changes) {
		t.Fatalf("expected a conflict for the differing Codex copy: %+v", changes)
	}
	if data, _ := os.ReadFile(filepath.Join(existing, skills.Entrypoint)); string(data) != "local edits\n" {
		t.Fatalf("Codex copy was overwritten without --force: %q", data)
	}

	claudeRoot, _ := skills.Root(types.AgentClaudeCode, skills.ScopeUser, loc)
	installed := filepath.Join(claudeRoot, "reviewer")
	if info, err := os.Stat(filepath.Join(installed, "scripts", "run.sh")); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("nested executable not copied intact: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(installed, "escape")); !os.IsNotExist(err) {
		t.Fatal("escaping symlink was copied")
	}

	opts.Force = true
	changes, err = skills.Add(src, opts)
	if err != nil {
		t.Fatal(err)
	}
	var replaced *skills.Change
	for i := range changes {
		if changes[i].Action == skills.ActionReplace {
			replaced = &changes[i]
		}
	}
	if replaced == nil || replaced.Agent != types.AgentCodex {
		t.Fatalf("expected Codex replace, got %+v", changes)
	}
	if data, _ := os.ReadFile(filepath.Join(replaced.Backup, skills.Entrypoint)); string(data) != "local edits\n" {
		t.Fatalf("replaced copy not preserved in trash: %q", data)
	}
	if got := mustFind(t, discover(t, loc), "reviewer"); got.Status != skills.StatusSynced {
		t.Fatalf("after forced add: %+v", got)
	}
}

func TestAddRejectsNonSkillAndBadName(t *testing.T) {
	loc := newLocation(t)
	empty := t.TempDir()
	if _, err := skills.Add(empty, skills.AddOptions{Loc: loc, Scope: skills.ScopeUser, Agents: allAgents}); err == nil {
		t.Fatal("expected an error for a directory without SKILL.md")
	}
	src := filepath.Join(t.TempDir(), "ok")
	writeSkill(t, src, "x\n")
	if _, err := skills.Add(src, skills.AddOptions{Loc: loc, Scope: skills.ScopeUser, Agents: allAgents, Name: "../escape"}); err == nil {
		t.Fatal("expected an error for a traversal name")
	}
}

func TestSyncFillsGapsButLeavesDivergedCopiesAlone(t *testing.T) {
	loc := newLocation(t)
	installSkill(t, loc, types.AgentClaudeCode, "claude-only", "one\n")
	installSkill(t, loc, types.AgentClaudeCode, "drifted", "version a\n")
	codexDrifted := installSkill(t, loc, types.AgentCodex, "drifted", "version b\n")

	opts := skills.SyncOptions{Loc: loc, Scope: skills.ScopeUser, To: allAgents}
	dry := opts
	dry.DryRun = true
	planned, err := skills.Sync(dry)
	if err != nil {
		t.Fatal(err)
	}
	if got := mustFind(t, discover(t, loc), "claude-only"); got.Status != skills.StatusPartial {
		t.Fatalf("dry run wrote to disk: %+v", got)
	}

	applied, err := skills.Sync(opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != len(planned) {
		t.Fatalf("dry run planned %d changes, apply made %d", len(planned), len(applied))
	}
	if !skills.HasConflicts(applied) {
		t.Fatalf("expected the diverged skill to be reported: %+v", applied)
	}

	inv := discover(t, loc)
	if got := mustFind(t, inv, "claude-only"); got.Status != skills.StatusSynced {
		t.Fatalf("claude-only after sync: %+v", got)
	}
	if got := mustFind(t, inv, "drifted"); got.Status != skills.StatusDiverged {
		t.Fatalf("drifted was touched without --from: %+v", got)
	}

	opts.From = types.AgentClaudeCode
	opts.Names = []string{"drifted"}
	if _, err := skills.Sync(opts); err != nil {
		t.Fatal(err)
	}
	if got := mustFind(t, discover(t, loc), "drifted"); got.Status != skills.StatusSynced {
		t.Fatalf("drifted after --from sync: %+v", got)
	}
	if data, _ := os.ReadFile(filepath.Join(codexDrifted, skills.Entrypoint)); string(data) != "version a\n" {
		t.Fatalf("Codex copy = %q, want the Claude Code version", data)
	}

	again, err := skills.Sync(skills.SyncOptions{Loc: loc, Scope: skills.ScopeUser, To: allAgents})
	if err != nil || len(again) != 0 {
		t.Fatalf("sync is not idempotent: %+v, %v", again, err)
	}
}

func TestSyncUnknownNameFails(t *testing.T) {
	loc := newLocation(t)
	if _, err := skills.Sync(skills.SyncOptions{Loc: loc, Scope: skills.ScopeUser, To: allAgents, Names: []string{"nope"}}); err == nil {
		t.Fatal("expected an error for an unknown skill")
	}
}

func TestRemoveTrashesDirectoriesAndOnlyUnlinksSymlinks(t *testing.T) {
	loc := newLocation(t)
	claudeCopy := installSkill(t, loc, types.AgentClaudeCode, "doomed", "keep me recoverable\n")

	shared := filepath.Join(t.TempDir(), "doomed")
	writeSkill(t, shared, "keep me recoverable\n")
	codexRoot, _ := skills.Root(types.AgentCodex, skills.ScopeUser, loc)
	if err := os.MkdirAll(codexRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(shared, filepath.Join(codexRoot, "doomed")); err != nil {
		t.Fatal(err)
	}

	changes, err := skills.Remove("doomed", skills.RemoveOptions{Loc: loc, Scope: skills.ScopeUser, Agents: allAgents})
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 2 {
		t.Fatalf("changes = %+v", changes)
	}
	for _, change := range changes {
		switch change.Agent {
		case types.AgentClaudeCode:
			if change.Action != skills.ActionRemove {
				t.Fatalf("Claude Code change = %+v", change)
			}
			if _, err := os.Stat(filepath.Join(change.Backup, skills.Entrypoint)); err != nil {
				t.Fatalf("removed skill not in trash: %v", err)
			}
		case types.AgentCodex:
			if change.Action != skills.ActionUnlink {
				t.Fatalf("Codex change = %+v", change)
			}
		}
	}
	if _, err := os.Lstat(claudeCopy); !os.IsNotExist(err) {
		t.Fatal("Claude Code copy still present")
	}
	if _, err := os.Stat(filepath.Join(shared, skills.Entrypoint)); err != nil {
		t.Fatalf("symlink target was deleted: %v", err)
	}
	if len(discover(t, loc).Skills) != 0 {
		t.Fatal("skill still in inventory")
	}
}

func TestDetectAgentsUsesHomeConfigDirs(t *testing.T) {
	loc := newLocation(t)
	if got := skills.DetectAgents(loc); len(got) != 3 {
		t.Fatalf("empty home should fall back to all agents, got %v", got)
	}
	if err := os.MkdirAll(filepath.Join(loc.HomeDir, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := skills.DetectAgents(loc); len(got) != 1 || got[0] != types.AgentCodex {
		t.Fatalf("DetectAgents = %v, want [codex]", got)
	}
}

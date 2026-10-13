package agents_test

import (
	"reflect"
	"testing"

	"github.com/qyinm/gandalf/internal/gandalfcore/agents"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

func TestCurrentSupportedIDsAreCodexClaudeCodeAndCursor(t *testing.T) {
	t.Parallel()

	want := []types.AgentID{types.AgentClaudeCode, types.AgentCodex, types.AgentCursor}
	if got := agents.CurrentSupportedIDs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CurrentSupportedIDs() = %#v, want %#v", got, want)
	}
	if got := agents.CurrentSupportedNames(); !reflect.DeepEqual(got, []string{"claude-code", "codex", "cursor"}) {
		t.Fatalf("CurrentSupportedNames() = %#v", got)
	}
}

func TestIsCurrentSupported(t *testing.T) {
	t.Parallel()

	for _, id := range []types.AgentID{types.AgentClaudeCode, types.AgentCodex, types.AgentCursor} {
		if !agents.IsCurrentSupported(id) {
			t.Fatalf("%s should be current supported", id)
		}
	}
	for _, id := range []types.AgentID{
		types.AgentOpencode,
		types.AgentPiAgent,
		types.AgentProject,
		types.AgentUnknown,
	} {
		if agents.IsCurrentSupported(id) {
			t.Fatalf("%s should not be current supported", id)
		}
	}
}

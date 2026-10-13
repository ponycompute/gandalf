package types

import "encoding/json"

type AgentID string

const (
	AgentClaudeCode AgentID = "claude-code"
	AgentCodex      AgentID = "codex"
	AgentCursor     AgentID = "cursor"
	AgentOpencode   AgentID = "opencode"
	AgentPiAgent    AgentID = "pi-agent"
	AgentProject    AgentID = "project"
	AgentUnknown    AgentID = "unknown"
)

func ParseAgentID(value string) AgentID {
	switch value {
	case "claude-code":
		return AgentClaudeCode
	case "codex":
		return AgentCodex
	case "cursor":
		return AgentCursor
	case "opencode":
		return AgentOpencode
	case "pi-agent":
		return AgentPiAgent
	case "project":
		return AgentProject
	case "unknown":
		return AgentUnknown
	default:
		return AgentUnknown
	}
}

func (a AgentID) String() string {
	if a == "" {
		return string(AgentUnknown)
	}
	return string(a)
}

func (a *AgentID) UnmarshalJSON(data []byte) error {
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*a = ParseAgentID(value)
	return nil
}

type SnapError struct {
	Code    string
	Problem string
	Cause   string
	Fix     string
	Path    *string
}

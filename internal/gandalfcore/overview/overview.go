// Package overview builds the first-run summary shown by bare `gandalf`:
// which agents are set up, how their MCP servers line up across agents, and
// the few findings worth fixing first. It is read-only and never surfaces
// secret values, only where they live.
package overview

import (
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/qyinm/gandalf/internal/gandalfcore/agents"
	"github.com/qyinm/gandalf/internal/gandalfcore/audit"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

// MaxIssues bounds how many findings the overview lists before deferring to
// `gandalf report`.
const MaxIssues = 5

// Overview is the cross-agent summary of the user's global agent setup.
type Overview struct {
	Agents       []AgentSummary `json:"agents"`
	Servers      []ServerRow    `json:"servers"`
	Issues       []Issue        `json:"issues"`
	HiddenIssues int            `json:"hiddenIssues"`
}

// AgentSummary counts setup objects for one agent.
type AgentSummary struct {
	Agent   types.AgentID `json:"agent"`
	Name    string        `json:"name"`
	Servers int           `json:"mcpServers"`
	Skills  int           `json:"skills"`
	Hooks   int           `json:"hooks"`
}

// ServerRow shows one MCP server name across agents.
type ServerRow struct {
	Name     string          `json:"name"`
	Agents   []types.AgentID `json:"agents"`
	Mismatch string          `json:"mismatch,omitempty"`
}

// Issue is a finding phrased for the overview.
type Issue struct {
	Code     string         `json:"code"`
	Severity types.Severity `json:"severity"`
	Title    string         `json:"title"`
	Path     string         `json:"path,omitempty"`
}

// noisyCodes are findings that fire for most healthy setups (any npx-based
// MCP server is "executable config"), so the overview leaves them to
// `gandalf report`.
var noisyCodes = map[string]bool{
	"EXECUTABLE_CONFIG_ADDED": true,
	"UNSUPPORTED_AGENT_STATE": true,
}

// Build summarizes user- and managed-scope evidence with its audit findings.
func Build(evidence []types.DiscoveredItem, findings []types.AuditFinding) Overview {
	global := make([]types.DiscoveredItem, 0, len(evidence))
	for _, item := range evidence {
		if item.Scope == types.ScopeUser || item.Scope == types.ScopeManaged {
			global = append(global, item)
		}
	}

	result := Overview{
		Agents:  summarizeAgents(global),
		Servers: serverRows(global),
	}
	result.Issues, result.HiddenIssues = selectIssues(global, findings)
	return result
}

func summarizeAgents(evidence []types.DiscoveredItem) []AgentSummary {
	present := make(map[types.AgentID]*AgentSummary)
	for _, item := range evidence {
		if !agents.IsCurrentSupported(item.Agent) {
			continue
		}
		summary, ok := present[item.Agent]
		if !ok {
			summary = &AgentSummary{Agent: item.Agent, Name: agents.DisplayName(item.Agent)}
			present[item.Agent] = summary
		}
		switch item.Kind {
		case types.KindMcpServer:
			summary.Servers++
		case types.KindSkill:
			summary.Skills++
		case types.KindHook:
			summary.Hooks++
		}
	}
	out := make([]AgentSummary, 0, len(present))
	for _, id := range agents.CurrentSupportedIDs() {
		if summary, ok := present[id]; ok {
			out = append(out, *summary)
		}
	}
	return out
}

// serverConfig is the comparable, secret-free shape of one agent's MCP entry.
type serverConfig struct {
	transport string
	pkg       string
	version   string
	envKeys   []string
}

func serverRows(evidence []types.DiscoveredItem) []ServerRow {
	byName := make(map[string]map[types.AgentID]serverConfig)
	for _, item := range evidence {
		if item.Kind != types.KindMcpServer || item.Name == nil || !agents.IsCurrentSupported(item.Agent) {
			continue
		}
		name := *item.Name
		if byName[name] == nil {
			byName[name] = make(map[types.AgentID]serverConfig)
		}
		if _, seen := byName[name][item.Agent]; !seen {
			byName[name][item.Agent] = parseServerConfig(item.Value)
		}
	}

	rows := make([]ServerRow, 0, len(byName))
	for name, configs := range byName {
		row := ServerRow{Name: name}
		for _, id := range agents.CurrentSupportedIDs() {
			if _, ok := configs[id]; ok {
				row.Agents = append(row.Agents, id)
			}
		}
		row.Mismatch = describeMismatch(row.Agents, configs)
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if len(rows[i].Agents) != len(rows[j].Agents) {
			return len(rows[i].Agents) > len(rows[j].Agents)
		}
		return rows[i].Name < rows[j].Name
	})
	return rows
}

// packageLaunchers run a package named by their first non-flag argument.
var packageLaunchers = map[string]bool{"npx": true, "bunx": true, "pnpx": true, "uvx": true}

func parseServerConfig(raw json.RawMessage) serverConfig {
	var value map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return serverConfig{}
	}
	config := serverConfig{envKeys: envKeys(value)}
	if url, ok := value["url"].(string); ok && url != "" {
		config.transport = "remote"
		return config
	}
	command, _ := value["command"].(string)
	config.transport = "command:" + path.Base(command)
	if !packageLaunchers[path.Base(command)] {
		return config
	}
	args, _ := value["args"].([]any)
	for _, arg := range args {
		text, ok := arg.(string)
		if !ok || strings.HasPrefix(text, "-") {
			continue
		}
		config.pkg, config.version = splitPackageSpec(text)
		break
	}
	return config
}

// splitPackageSpec splits "@scope/name@1.2.3" or "name@latest" into package
// and version. Only registry package specs are parsed, so connection strings
// or paths in args never reach the overview.
func splitPackageSpec(spec string) (string, string) {
	if strings.Contains(spec, "://") || strings.ContainsAny(spec, " :=") {
		return "", ""
	}
	at := strings.LastIndex(spec, "@")
	if at <= 0 {
		return spec, ""
	}
	return spec[:at], spec[at+1:]
}

func envKeys(value map[string]any) []string {
	var keys []string
	if env, ok := value["env"].(map[string]any); ok {
		for key := range env {
			keys = append(keys, key)
		}
	}
	if redacted, ok := value["envKeys"].([]any); ok {
		for _, key := range redacted {
			if text, ok := key.(string); ok {
				keys = append(keys, text)
			}
		}
	}
	sort.Strings(keys)
	return keys
}

func describeMismatch(ids []types.AgentID, configs map[types.AgentID]serverConfig) string {
	if len(ids) < 2 {
		return ""
	}
	first := configs[ids[0]]
	for _, id := range ids[1:] {
		other := configs[id]
		switch {
		case first.transport != other.transport:
			return "different launch commands"
		case first.pkg != other.pkg:
			return "different packages"
		case first.version != other.version:
			return "versions differ: " + versionList(ids, configs)
		case strings.Join(first.envKeys, ",") != strings.Join(other.envKeys, ","):
			return "different env keys"
		}
	}
	return ""
}

func versionList(ids []types.AgentID, configs map[types.AgentID]serverConfig) string {
	seen := make(map[string]bool)
	var versions []string
	for _, id := range ids {
		version := configs[id].version
		if version == "" {
			version = "unpinned"
		}
		if !seen[version] {
			seen[version] = true
			versions = append(versions, version)
		}
	}
	return strings.Join(versions, " vs ")
}

func selectIssues(evidence []types.DiscoveredItem, findings []types.AuditFinding) ([]Issue, int) {
	byID := make(map[string]*types.DiscoveredItem, len(evidence))
	for i := range evidence {
		byID[evidence[i].ID] = &evidence[i]
	}

	var issues []Issue
	for _, finding := range findings {
		if noisyCodes[finding.Code] {
			continue
		}
		if finding.Severity != types.SeverityCritical && finding.Severity != types.SeverityHigh &&
			finding.Severity != types.SeverityMedium {
			continue
		}
		var item *types.DiscoveredItem
		if finding.EvidenceID != nil {
			item = byID[*finding.EvidenceID]
		}
		if item == nil {
			continue
		}
		issues = append(issues, Issue{
			Code:     finding.Code,
			Severity: finding.Severity,
			Title:    issueTitle(finding, item),
			Path:     item.SourcePath,
		})
	}

	if len(issues) <= MaxIssues {
		return issues, 0
	}
	return issues[:MaxIssues], len(issues) - MaxIssues
}

func issueTitle(finding types.AuditFinding, item *types.DiscoveredItem) string {
	name := item.ID
	if item.Name != nil {
		name = *item.Name
	}
	switch finding.Code {
	case "PLAINTEXT_SECRET":
		return fmt.Sprintf("%s MCP server stores a secret in plaintext (%s)",
			name, strings.Join(audit.PlaintextSecretLocations(item), ", "))
	case "HOOK_NETWORK_EGRESS":
		host, _ := audit.HookNetworkEgress(item)
		if host == "" {
			return fmt.Sprintf("%s hook sends data over the network", name)
		}
		return fmt.Sprintf("%s hook sends data to %s", name, host)
	case "PERMISSION_WILDCARD_ADDED":
		return fmt.Sprintf("%s lets the agent run matching commands without asking", name)
	default:
		return strings.TrimSuffix(finding.Problem, ".")
	}
}

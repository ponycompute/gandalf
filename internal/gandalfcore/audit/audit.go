package audit

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/qyinm/gandalf/internal/gandalfcore/graph"
	"github.com/qyinm/gandalf/internal/gandalfcore/policy"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

var (
	secretLikeNamePattern = regexp.MustCompile(`(?i)(?:secret|token|api[_-]?key|password|credential)`)

	// networkCommandPattern matches hook commands that can send data off the
	// machine. Detection is static: hooks are never executed during audit.
	networkCommandPattern = regexp.MustCompile(`(?i)(?:^|[\s;|&(\x60])(?:curl|wget|nc|ncat|netcat|telnet|scp|rsync|ssh|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(?:\s|$)`)
	urlHostPattern        = regexp.MustCompile(`(?i)\bhttps?://([^/\s:'"@]+)`)
)

func record(value json.RawMessage) map[string]json.RawMessage {
	if len(value) == 0 {
		return nil
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(value, &obj) != nil {
		return nil
	}
	return obj
}

func jsonString(value json.RawMessage) string {
	var s string
	if json.Unmarshal(value, &s) == nil {
		return s
	}
	return ""
}

func jsonBool(value json.RawMessage) bool {
	var b bool
	if json.Unmarshal(value, &b) == nil {
		return b
	}
	return false
}

func finding(
	code string,
	severity types.Severity,
	problem, cause, fix string,
	item *types.DiscoveredItem,
) types.AuditFinding {
	path := item.SourcePath
	evidenceID := item.ID
	return types.AuditFinding{
		Code:       code,
		Severity:   severity,
		Problem:    problem,
		Cause:      cause,
		Fix:        fix,
		Path:       &path,
		EvidenceID: &evidenceID,
	}
}

func entityName(item *types.DiscoveredItem) string {
	if item.Name != nil {
		return *item.Name
	}
	return item.ID
}

func isWildcardPermission(item *types.DiscoveredItem) bool {
	if item.Kind != types.KindPermission {
		return false
	}
	if len(item.Value) > 0 {
		if obj := record(item.Value); obj != nil {
			if v, ok := obj["rule"]; ok {
				return policy.PermissionWildcard{}.InJSON(v)
			}
		}
	}
	return policy.PermissionWildcard{}.InName(entityName(item))
}

func isSecretLike(item *types.DiscoveredItem) bool {
	if item.CaptureStatus != types.CaptureOmitted && item.CaptureStatus != types.CaptureRedacted {
		return false
	}
	if len(item.Metadata) > 0 {
		var meta map[string]json.RawMessage
		if json.Unmarshal(item.Metadata, &meta) == nil {
			if v, ok := meta["secretLike"]; ok && jsonBool(v) {
				return true
			}
		}
	}
	return secretLikeNamePattern.MatchString(entityName(item))
}

func hasExecutableConfig(item *types.DiscoveredItem) bool {
	obj := record(item.Value)
	if item.Kind == types.KindMcpServer {
		if obj != nil {
			if v, ok := obj["command"]; ok {
				if cmd := jsonString(v); cmd != "" {
					return true
				}
			}
		}
	}
	if item.Kind == types.KindHook || item.Kind == types.KindSkill || item.Kind == types.KindExtension {
		if len(item.Metadata) > 0 {
			var meta map[string]json.RawMessage
			if json.Unmarshal(item.Metadata, &meta) == nil {
				if v, ok := meta["executable"]; ok && jsonBool(v) {
					return true
				}
			}
		}
	}
	return false
}

func scopeSettingsLabel(scope types.EvidenceScope) string {
	switch scope {
	case types.ScopeProject:
		return "Project"
	case types.ScopeManaged:
		return "Managed"
	default:
		return "User"
	}
}

// PlaintextSecretLocations returns where an MCP server keeps a plaintext
// credential. Scanners that redact values up front (~/.claude.json) record
// the locations in metadata; otherwise they are derived from the value.
func PlaintextSecretLocations(item *types.DiscoveredItem) []string {
	if item.Kind != types.KindMcpServer {
		return nil
	}
	if len(item.Metadata) > 0 {
		var meta struct {
			PlaintextSecrets []string `json:"plaintextSecrets"`
			Redacted         bool     `json:"redacted"`
		}
		if json.Unmarshal(item.Metadata, &meta) == nil && (meta.Redacted || len(meta.PlaintextSecrets) > 0) {
			return meta.PlaintextSecrets
		}
	}
	return policy.PlaintextSecretLocations(item.Value)
}

// HookNetworkEgress reports whether a hook command invokes a network client,
// and the destination host when one is visible in the command.
func HookNetworkEgress(item *types.DiscoveredItem) (string, bool) {
	if item.Kind != types.KindHook {
		return "", false
	}
	command := metadataString(item, "command")
	if command == "" {
		if obj := record(item.Value); obj != nil {
			command = jsonString(obj["command"])
		}
	}
	if command == "" || !networkCommandPattern.MatchString(command) {
		return "", false
	}
	if match := urlHostPattern.FindStringSubmatch(command); len(match) == 2 {
		return match[1], true
	}
	return "", true
}

func metadataBool(item *types.DiscoveredItem, key string) bool {
	if len(item.Metadata) == 0 {
		return false
	}
	var meta map[string]json.RawMessage
	if json.Unmarshal(item.Metadata, &meta) != nil {
		return false
	}
	v, ok := meta[key]
	return ok && jsonBool(v)
}

func metadataString(item *types.DiscoveredItem, key string) string {
	if len(item.Metadata) == 0 {
		return ""
	}
	var meta map[string]json.RawMessage
	if json.Unmarshal(item.Metadata, &meta) != nil {
		return ""
	}
	v, ok := meta[key]
	if !ok {
		return ""
	}
	return jsonString(v)
}

func projectOverrideFindings(
	graphNodes []types.GraphNode,
	evidenceByID map[string]*types.DiscoveredItem,
) []types.AuditFinding {
	nodesByID := make(map[string]*types.GraphNode, len(graphNodes))
	for i := range graphNodes {
		nodesByID[graphNodes[i].ID] = &graphNodes[i]
	}

	var findings []types.AuditFinding
	emitted := make(map[string]struct{})

	for i := range graphNodes {
		node := &graphNodes[i]
		if node.OverriddenBy == nil {
			continue
		}
		overridingNode := nodesByID[*node.OverriddenBy]
		overriddenEvidence := evidenceByID[node.EvidenceID]
		var overridingEvidence *types.DiscoveredItem
		if overridingNode != nil {
			overridingEvidence = evidenceByID[overridingNode.EvidenceID]
		}
		if overriddenEvidence == nil || overridingEvidence == nil ||
			node.Scope != types.ScopeUser ||
			overridingNode == nil || overridingNode.Scope != types.ScopeProject {
			continue
		}
		key := overriddenEvidence.ID + ":" + overridingEvidence.ID
		if _, ok := emitted[key]; ok {
			continue
		}
		emitted[key] = struct{}{}

		path := overridingEvidence.SourcePath
		evidenceID := overridingEvidence.ID
		findings = append(findings, types.AuditFinding{
			Code:     "PROJECT_OVERRIDES_USER_POLICY",
			Severity: types.SeverityHigh,
			Problem:  "Project configuration overrides a user-level agent policy.",
			Cause: fmt.Sprintf(
				"%s has higher precedence than %s for %s.",
				overridingEvidence.SourcePath,
				overriddenEvidence.SourcePath,
				node.EntityName,
			),
			Fix:        "Review the project-level rule and remove it if the override is not intentional.",
			Path:       &path,
			EvidenceID: &evidenceID,
		})
	}
	return findings
}

func severityRank(severity types.Severity) int {
	switch severity {
	case types.SeverityCritical:
		return 0
	case types.SeverityHigh:
		return 1
	case types.SeverityMedium:
		return 2
	case types.SeverityLow:
		return 3
	default:
		return 4
	}
}

// AuditEvidence evaluates discovered evidence and graph overrides for trust findings.
func AuditEvidence(evidence []types.DiscoveredItem, graphNodes []types.GraphNode) []types.AuditFinding {
	evidenceByID := make(map[string]*types.DiscoveredItem, len(evidence))
	for i := range evidence {
		evidenceByID[evidence[i].ID] = &evidence[i]
	}

	var findings []types.AuditFinding

	for i := range evidence {
		item := &evidence[i]

		if hasExecutableConfig(item) {
			findings = append(findings, finding(
				"EXECUTABLE_CONFIG_ADDED",
				types.SeverityMedium,
				"Configuration references an executable command or hook.",
				fmt.Sprintf("%s contains executable configuration for %s.", item.SourcePath, entityName(item)),
				"Confirm the command is trusted and keep only explicit, necessary executable entries.",
				item,
			))
		}

		if metadataBool(item, "remote") && metadataBool(item, "changed") {
			findings = append(findings, finding(
				"REMOTE_MCP_CHANGED",
				types.SeverityMedium,
				"Remote MCP configuration changed.",
				fmt.Sprintf("%s marks %s as remote and changed.", item.SourcePath, entityName(item)),
				"Review the remote URL and host before trusting this MCP server.",
				item,
			))
		}

		if isWildcardPermission(item) {
			name := entityName(item)
			if name == item.ID {
				name = "a wildcard permission"
			}
			findings = append(findings, finding(
				"PERMISSION_WILDCARD_ADDED",
				types.SeverityHigh,
				scopeSettingsLabel(item.Scope)+" settings allow a broad permission wildcard.",
				fmt.Sprintf("%s contains %s.", item.SourcePath, name),
				"Replace the wildcard with explicit allowed commands or resources.",
				item,
			))
		}

		if locations := PlaintextSecretLocations(item); len(locations) > 0 {
			findings = append(findings, finding(
				"PLAINTEXT_SECRET",
				types.SeverityHigh,
				"An MCP server stores a credential in plaintext.",
				fmt.Sprintf("%s stores %s for %s in plaintext.", item.SourcePath, strings.Join(locations, ", "), entityName(item)),
				"Move the value into an environment variable or secret manager, reference it as ${VAR}, and rotate it if the file was ever shared or synced.",
				item,
			))
		}

		if host, ok := HookNetworkEgress(item); ok {
			destination := "the network"
			if host != "" {
				destination = host
			}
			findings = append(findings, finding(
				"HOOK_NETWORK_EGRESS",
				types.SeverityHigh,
				"A hook sends data over the network.",
				fmt.Sprintf("%s runs a %s hook that contacts %s.", item.SourcePath, entityName(item), destination),
				"Confirm you trust the destination; hooks receive tool inputs such as file edits and commands.",
				item,
			))
		}

		if isSecretLike(item) {
			findings = append(findings, finding(
				"SECRET_LIKE_VALUE_OMITTED",
				types.SeverityMedium,
				"A secret-like value was detected and omitted from the evidence inventory.",
				fmt.Sprintf("%s contains %s, which matches a sensitive key pattern.", item.SourcePath, entityName(item)),
				"Keep the value out of snapshots and rotate it if it may have been exposed elsewhere.",
				item,
			))
		}

		if item.CaptureStatus == types.CaptureParseFailed {
			errorSuffix := ""
			if errMsg := metadataString(item, "error"); errMsg != "" {
				errorSuffix = ": " + errMsg
			}
			findings = append(findings, finding(
				"PARSE_FAILED",
				types.SeverityHigh,
				"A relevant agent configuration file could not be parsed.",
				fmt.Sprintf("%s failed to parse%s", item.SourcePath, errorSuffix),
				"Fix the file syntax or exclude that source from the scan.",
				item,
			))
		}

		if item.Kind == types.KindSymlink &&
			(item.CaptureStatus == types.CaptureOmitted || metadataBool(item, "skipped")) &&
			!strings.Contains(item.SourcePath, "/skills/") {
			findings = append(findings, finding(
				"SYMLINK_SKIPPED",
				types.SeverityHigh,
				"A symlink was found and not followed.",
				fmt.Sprintf("%s points outside the scanned file content boundary.", item.SourcePath),
				"Inspect the symlink manually and replace it with a regular config file if it should be captured.",
				item,
			))
		}

		if item.Kind == types.KindUnsupported || item.CaptureStatus == types.CaptureUnsupported {
			findings = append(findings, finding(
				"UNSUPPORTED_AGENT_STATE",
				types.SeverityMedium,
				"Agent state was detected but cannot yet be interpreted by gandalf.",
				fmt.Sprintf("%s is present, but its semantics are unsupported.", item.SourcePath),
				"Treat this as a blind spot and inspect the source manually before relying on the snapshot.",
				item,
			))
		}

		if metadataBool(item, "worldWritable") {
			findings = append(findings, finding(
				"WORLD_WRITABLE_STORE",
				types.SeverityCritical,
				"The gandalf store is marked world-writable.",
				fmt.Sprintf("%s metadata reports unsafe store permissions.", item.SourcePath),
				"Change the store permissions to 0700 before trusting stored snapshots.",
				item,
			))
		}
	}

	findings = append(findings, projectOverrideFindings(graphNodes, evidenceByID)...)

	sort.Slice(findings, func(i, j int) bool {
		left := findings[i]
		right := findings[j]
		if severityRank(left.Severity) != severityRank(right.Severity) {
			return severityRank(left.Severity) < severityRank(right.Severity)
		}
		return left.Code < right.Code
	})

	return findings
}

// AuditEvidenceWithGraph builds the graph and audits evidence in one step.
func AuditEvidenceWithGraph(evidence []types.DiscoveredItem) []types.AuditFinding {
	return AuditEvidence(evidence, graph.BuildGraph(evidence))
}

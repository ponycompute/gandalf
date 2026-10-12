package plugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/qyinm/gandalf/internal/gandalfcore/parsers"
	"github.com/qyinm/gandalf/internal/gandalfcore/policy"
	"github.com/qyinm/gandalf/internal/gandalfcore/scan"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

const (
	codexSkillMaxFilesPerRoot = 500
	codexSkillScanBudgetMS    = 1000
)

var (
	secretLikePathPattern   = regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|auth|bearer)`)
	tomlKeyValuePattern     = regexp.MustCompile(`^([A-Za-z0-9_.-]+)\s*=\s*(.*)$`)
	tomlArrayHookPattern    = regexp.MustCompile(`^\[\[([^\]]+)]]$`)
	tomlSectionPattern      = regexp.MustCompile(`^\[([^\]]+)]$`)
	skillFrontmatterPattern = regexp.MustCompile(`(?s)^---\r?\n([\s\S]*?)\r?\n---`)
	skillNameLinePattern    = regexp.MustCompile(`^(name|description):\s*(.*)$`)
)

// CodexScanner discovers Codex agent configuration evidence.
type CodexScanner struct{}

func (CodexScanner) AgentID() types.AgentID { return types.AgentCodex }
func (CodexScanner) AgentName() string      { return "Codex" }
func (CodexScanner) Description() string {
	return "Codex agent configuration (prompts, config, MCP servers, skills)"
}

func (CodexScanner) Targets(projectPath, homeDir string) []scan.ScanTarget {
	return []scan.ScanTarget{
		scan.ProjectTarget(projectPath, "AGENTS.md", types.AgentCodex, types.KindAgentInstruction, types.ParserMarkdown, scan.ScanTargetOverrides{}),
		scan.ProjectTarget(projectPath, ".codex/config.toml", types.AgentCodex, types.KindAgentConfig, types.ParserToml, scan.ScanTargetOverrides{}),
		scan.HomeTarget(homeDir, ".codex/config.toml", types.AgentCodex, types.KindAgentConfig, types.ParserToml, scan.ScanTargetOverrides{}),
	}
}

func (c CodexScanner) Scan(context *scan.ScannerContext) []types.DiscoveredItem {
	base := scan.NewScannerBase(types.AgentCodex)
	inScope := func(target scan.ScanTarget) bool {
		return scan.ScopeEnabled(target.Scope, context.Scope)
	}

	var targets []scan.ScanTarget
	for _, target := range c.Targets(context.ProjectPath, context.HomeDir) {
		if inScope(target) {
			targets = append(targets, target)
		}
	}

	evidence := scan.ScanTargets(targets)

	if context.Scope == nil || (context.Scope != nil && *context.Scope == types.ScopeUser) {
		evidence = append(evidence, scanCodexMCPServers(context.HomeDir, base)...)
		evidence = append(evidence, scanCodexInstalledPlugins(context.HomeDir)...)
	}

	evidence = append(evidence, scanCodexHooks(context.ProjectPath, context.HomeDir, context.Scope, base)...)

	var skillEvidence []types.DiscoveredItem
	for _, target := range codexSkillTargets(context.HomeDir) {
		if inScope(target) {
			skillEvidence = append(skillEvidence, scanCodexSkillDirectory(target, base)...)
		}
	}
	evidence = append(evidence, dedupeSkillsBySource(skillEvidence)...)

	return evidence
}

func codexSkillTargets(homeDir string) []scan.ScanTarget {
	dir := true
	return []scan.ScanTarget{
		scan.HomeTarget(homeDir, ".codex/skills", types.AgentCodex, types.KindSkill, types.ParserFilesystem, scan.ScanTargetOverrides{Directory: &dir}),
		scan.HomeTarget(homeDir, ".codex/vendor_imports/skills", types.AgentCodex, types.KindSkill, types.ParserFilesystem, scan.ScanTargetOverrides{Directory: &dir}),
	}
}

func scanCodexMCPServers(homeDir string, base scan.ScannerBase) []types.DiscoveredItem {
	target := scan.HomeTarget(homeDir, ".codex/config.toml", types.AgentCodex, types.KindAgentConfig, types.ParserToml, scan.ScanTargetOverrides{})
	text, err := os.ReadFile(target.AbsolutePath)
	if err != nil {
		return nil
	}

	var evidence []types.DiscoveredItem
	for name, serverValue := range codexMCPServersFromTOML(string(text)) {
		evidenceTarget := scan.EvidenceBaseTarget{
			Agent:         target.Agent,
			SourcePath:    target.SourcePath,
			Scope:         target.Scope,
			Precedence:    target.Precedence,
			Parser:        target.Parser,
			Sensitivity:   "command_config",
			ContentPolicy: "structured_safe_fields_only",
		}
		var metadata map[string]any
		var value any = serverValue
		locations := takeCodexPlaintextSecrets(serverValue)
		if rawValue, err := json.Marshal(serverValue); err == nil {
			locations = append(locations, policy.PlaintextSecretLocations(rawValue)...)
			if redacted, err := policy.RedactStructuredValue(rawValue); err == nil {
				value = redacted
			}
		}
		if len(locations) > 0 {
			metadata = map[string]any{"plaintextSecrets": uniqueSorted(locations)}
		}
		item := base.Captured(evidenceTarget, types.KindMcpServer, metadata, value)
		item.ID = scan.ScannerItemID(target.Scope, target.Agent, target.SourcePath, "mcp-"+name)
		item.Name = stringPtr(name)
		evidence = append(evidence, item)
	}
	return evidence
}

// scanCodexInstalledPlugins surfaces installed Codex plugins declared as
// [plugins."name@source"] sections in config.toml so they appear in the
// Plugins tab alongside Claude Code plugins.
func scanCodexInstalledPlugins(homeDir string) []types.DiscoveredItem {
	configPath := filepath.Join(homeDir, ".codex", "config.toml")
	text, err := os.ReadFile(configPath)
	if err != nil {
		return nil
	}
	cacheRoot := filepath.Join(homeDir, ".codex", "plugins", "cache")
	var evidence []types.DiscoveredItem
	seen := make(map[string]struct{})
	for _, key := range codexPluginKeysFromTOML(string(text)) {
		name, marketplace := splitPluginKey(key)
		if name == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		sourcePath := displayClaudePath(filepath.Join(cacheRoot, marketplace, name), homeDir)
		metadata, _ := json.Marshal(map[string]any{
			"present":       true,
			"name":          name,
			"marketplace":   marketplace,
			"installed":     true,
			"status":        "installed",
			"inventoryOnly": true,
		})
		itemName := name
		evidence = append(evidence, types.DiscoveredItem{
			ID:            scan.ScannerItemID(types.ScopeUser, types.AgentCodex, sourcePath, "plugin-"+marketplace+"-"+name),
			Agent:         types.AgentCodex,
			Kind:          types.KindExtension,
			SourcePath:    sourcePath,
			Scope:         types.ScopeUser,
			Precedence:    20,
			Parser:        types.ParserToml,
			Sensitivity:   "metadata",
			ContentPolicy: "metadata_only",
			RestorePolicy: types.RestoreNotSupported,
			CaptureStatus: types.CaptureCaptured,
			Confidence:    types.ConfidenceHigh,
			Name:          &itemName,
			Metadata:      metadata,
		})
	}
	return evidence
}

// codexPluginKeysFromTOML extracts plugin keys from [plugins."key"] sections.
func codexPluginKeysFromTOML(text string) []string {
	var keys []string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(stripTOMLComment(raw))
		if !strings.HasPrefix(line, "[plugins.") || !strings.HasSuffix(line, "]") {
			continue
		}
		inner := strings.TrimSuffix(strings.TrimPrefix(line, "[plugins."), "]")
		inner = strings.Trim(inner, "\"")
		if inner != "" {
			keys = append(keys, inner)
		}
	}
	return keys
}

func codexMCPServersFromTOML(text string) map[string]map[string]any {
	servers := make(map[string]map[string]any)
	var currentServer *string
	var currentNestedPath []string

	lines := strings.Split(text, "\n")
	index := 0
	for index < len(lines) {
		line := strings.TrimSpace(stripTOMLComment(lines[index]))
		index++
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			sectionPath := splitTOMLDottedName(line[1 : len(line)-1])
			if len(sectionPath) >= 2 && sectionPath[0] == "mcp_servers" {
				name := sectionPath[1]
				currentServer = &name
				if len(sectionPath) > 2 {
					currentNestedPath = append([]string{}, sectionPath[2:]...)
				} else {
					currentNestedPath = nil
				}
				if _, ok := servers[name]; !ok {
					servers[name] = make(map[string]any)
				}
			} else {
				currentServer = nil
				currentNestedPath = nil
			}
			continue
		}

		if currentServer == nil {
			continue
		}

		key, rawValue, ok := parseKeyValueLine(line)
		if !ok {
			continue
		}

		if strings.HasPrefix(strings.TrimSpace(rawValue), "[") && !completeTOMLArray(rawValue) {
			arrayLines := []string{rawValue}
			for index < len(lines) {
				continuation := strings.TrimSpace(stripTOMLComment(lines[index]))
				index++
				arrayLines = append(arrayLines, continuation)
				if completeTOMLArray(strings.Join(arrayLines, " ")) {
					break
				}
			}
			rawValue = strings.Join(arrayLines, " ")
		}

		server := servers[*currentServer]
		pathParts := append(append([]string{}, currentNestedPath...), splitTOMLDottedName(key)...)
		assignTOMLValue(server, pathParts, rawValue)
	}

	return servers
}

// codexPlaintextSecretsKey is a parse-time side channel on the server map that
// records where literal credentials were found; scanCodexMCPServers moves it
// into evidence metadata so values themselves never need to be stored.
const codexPlaintextSecretsKey = "\x00plaintextSecrets"

func recordCodexPlaintextSecret(server map[string]any, location string) {
	existing, _ := server[codexPlaintextSecretsKey].([]string)
	server[codexPlaintextSecretsKey] = append(existing, location)
}

func takeCodexPlaintextSecrets(server map[string]any) []string {
	locations, _ := server[codexPlaintextSecretsKey].([]string)
	delete(server, codexPlaintextSecretsKey)
	return locations
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func assignTOMLValue(target map[string]any, pathParts []string, rawValue string) {
	if len(pathParts) == 0 {
		return
	}

	// Inline tables (env = { KEY = "value" }) go through the same per-key
	// rules as [section] tables so env values and secret-like fields are never
	// stored verbatim.
	if entries, ok := parsers.ParseTOMLInlineTable(rawValue); ok {
		for _, entry := range entries {
			assignTOMLValue(target, append(append([]string{}, pathParts...), splitTOMLDottedName(entry[0])...), entry[1])
		}
		return
	}

	if pathParts[0] == "env" && len(pathParts) >= 2 {
		key := pathParts[1]
		if value, ok := parsers.ParseTOMLScalar(rawValue).(string); ok && policy.IsPlaintextSecret(key, value) {
			recordCodexPlaintextSecret(target, "env."+key)
		}
		var keys []any
		if existing, ok := target["envKeys"].([]any); ok {
			keys = existing
		}
		found := false
		for _, item := range keys {
			if s, ok := item.(string); ok && s == key {
				found = true
				break
			}
		}
		if !found {
			keys = append(keys, key)
		}
		target["envKeys"] = keys
		return
	}

	cursor := target
	for _, part := range pathParts[:len(pathParts)-1] {
		next, ok := cursor[part]
		if !ok {
			nested := make(map[string]any)
			cursor[part] = nested
			cursor = nested
			continue
		}
		nested, ok := next.(map[string]any)
		if !ok {
			return
		}
		cursor = nested
	}

	key := pathParts[len(pathParts)-1]
	var parsed any
	if secretLikePath(pathParts) {
		if value, ok := parsers.ParseTOMLScalar(rawValue).(string); ok && policy.IsPlaintextSecret(key, value) {
			recordCodexPlaintextSecret(target, strings.Join(pathParts, "."))
		}
		parsed = "[redacted]"
	} else {
		parsed = parsers.ParseTOMLScalar(rawValue)
	}
	cursor[key] = parsed
}

func secretLikePath(pathParts []string) bool {
	return secretLikePathPattern.MatchString(strings.Join(pathParts, "."))
}

func completeTOMLArray(value string) bool {
	var quote *rune
	depth := 0
	runes := []rune(value)
	for index, ch := range runes {
		var previous rune
		if index > 0 {
			previous = runes[index-1]
		}
		if (ch == '"' || ch == '\'') && quote == nil {
			q := ch
			quote = &q
			continue
		}
		if quote != nil && ch == *quote && previous != '\\' {
			quote = nil
			continue
		}
		if quote != nil {
			continue
		}
		if ch == '[' {
			depth++
		}
		if ch == ']' {
			depth--
		}
	}
	return depth == 0
}

func stripTOMLComment(rawLine string) string {
	var quote *rune
	runes := []rune(rawLine)
	for index, ch := range runes {
		var previous rune
		if index > 0 {
			previous = runes[index-1]
		}
		if (ch == '"' || ch == '\'') && quote == nil {
			q := ch
			quote = &q
			continue
		}
		if quote != nil && ch == *quote && previous != '\\' {
			quote = nil
			continue
		}
		if ch == '#' && quote == nil {
			return string(runes[:index])
		}
	}
	return rawLine
}

func splitTOMLDottedName(name string) []string {
	var parts []string
	var current strings.Builder
	var quote *rune

	for _, ch := range name {
		if (ch == '"' || ch == '\'') && quote == nil {
			q := ch
			quote = &q
			continue
		}
		if quote != nil && ch == *quote {
			quote = nil
			continue
		}
		if ch == '.' && quote == nil {
			parts = append(parts, strings.TrimSpace(current.String()))
			current.Reset()
			continue
		}
		current.WriteRune(ch)
	}
	parts = append(parts, strings.TrimSpace(current.String()))

	var filtered []string
	for _, part := range parts {
		if part != "" {
			filtered = append(filtered, part)
		}
	}
	return filtered
}

func parseKeyValueLine(line string) (string, string, bool) {
	matches := tomlKeyValuePattern.FindStringSubmatch(line)
	if len(matches) != 3 {
		return "", "", false
	}
	return matches[1], matches[2], true
}

func scanCodexSkillDirectory(target scan.ScanTarget, base scan.ScannerBase) []types.DiscoveredItem {
	scanResult := findSkillFiles(target.AbsolutePath)
	var evidence []types.DiscoveredItem

	for _, skillFile := range scanResult.files {
		frontmatter := readSkillFrontmatter(skillFile)
		skillDir := filepath.Dir(skillFile)
		relativeSkillDir, err := filepath.Rel(target.AbsolutePath, skillDir)
		if err != nil {
			relativeSkillDir = ""
		}
		relativeSkillDir = filepath.ToSlash(relativeSkillDir)

		sourcePath := target.SourcePath
		if relativeSkillDir != "" && relativeSkillDir != "." {
			sourcePath = target.SourcePath + "/" + relativeSkillDir
		}

		directoryName := filepath.Base(skillDir)
		name := directoryName
		if frontmatter != nil && frontmatter.name != "" {
			name = frontmatter.name
		}

		metadata := map[string]any{
			"present":              true,
			"entrypoint":           filepath.Base(skillFile),
			"entrypointStatus":     "captured",
			"directoryName":        directoryName,
			"nameMatchesDirectory": name == directoryName,
		}

		item := base.Captured(
			scan.EvidenceBaseTargetFromScanTarget(targetWithSource(target, sourcePath)),
			types.KindSkill,
			metadata,
			nil,
		)
		item.ID = scan.ScannerItemID(target.Scope, target.Agent, sourcePath, "skill")
		item.Name = stringPtr(name)
		evidence = append(evidence, item)
	}

	return evidence
}

func targetWithSource(target scan.ScanTarget, sourcePath string) scan.ScanTarget {
	target.SourcePath = sourcePath
	return target
}

func codexHookTargets(projectPath, homeDir string) []scan.ScanTarget {
	overrides := scan.ScanTargetOverrides{
		Sensitivity:   stringPtr("command_config"),
		ContentPolicy: stringPtr("structured_safe_fields_only"),
	}
	return []scan.ScanTarget{
		scan.ProjectTarget(projectPath, ".codex/hooks.json", types.AgentCodex, types.KindHook, types.ParserJSON, overrides),
		scan.HomeTarget(homeDir, ".codex/hooks.json", types.AgentCodex, types.KindHook, types.ParserJSON, overrides),
	}
}

func codexInlineHookTargets(projectPath, homeDir string) []scan.ScanTarget {
	overrides := scan.ScanTargetOverrides{
		Sensitivity:   stringPtr("command_config"),
		ContentPolicy: stringPtr("structured_safe_fields_only"),
	}
	return []scan.ScanTarget{
		scan.ProjectTarget(projectPath, ".codex/config.toml", types.AgentCodex, types.KindHook, types.ParserToml, overrides),
		scan.HomeTarget(homeDir, ".codex/config.toml", types.AgentCodex, types.KindHook, types.ParserToml, overrides),
	}
}

func scanCodexHooks(projectPath, homeDir string, scope *types.EvidenceScope, base scan.ScannerBase) []types.DiscoveredItem {
	inScope := func(target scan.ScanTarget) bool {
		return scope == nil || target.Scope == *scope
	}

	var evidence []types.DiscoveredItem
	for _, target := range codexHookTargets(projectPath, homeDir) {
		if inScope(target) {
			evidence = append(evidence, scanCodexHooksFile(target, base)...)
		}
	}
	for _, target := range codexInlineHookTargets(projectPath, homeDir) {
		if inScope(target) {
			evidence = append(evidence, scanCodexInlineHooksFile(target, base)...)
		}
	}
	return evidence
}

func scanCodexHooksFile(target scan.ScanTarget, base scan.ScannerBase) []types.DiscoveredItem {
	text, err := os.ReadFile(target.AbsolutePath)
	if err != nil {
		return nil
	}

	var value map[string]any
	if err := json.Unmarshal(text, &value); err != nil {
		item := base.ParseFailed(scan.EvidenceBaseTargetFromScanTarget(target), types.KindHook, err.Error())
		item.Parser = types.ParserJSON
		return []types.DiscoveredItem{item}
	}

	return codexHookItemsFromValue(target, value, base)
}

func scanCodexInlineHooksFile(target scan.ScanTarget, base scan.ScannerBase) []types.DiscoveredItem {
	text, err := os.ReadFile(target.AbsolutePath)
	if err != nil {
		return nil
	}
	return codexInlineHookItemsFromTOML(target, string(text), base)
}

type hookGroup struct {
	eventName string
	matcher   string
	hooks     []map[string]any
}

func codexInlineHookItemsFromTOML(target scan.ScanTarget, text string, base scan.ScannerBase) []types.DiscoveredItem {
	var groups []hookGroup
	var currentGroup *int
	var currentHook *int

	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSpace(stripTOMLComment(rawLine))
		if line == "" {
			continue
		}

		if matches := tomlArrayHookPattern.FindStringSubmatch(line); len(matches) == 2 {
			sectionPath := splitTOMLDottedName(matches[1])
			if len(sectionPath) == 2 && sectionPath[0] == "hooks" {
				groups = append(groups, hookGroup{
					eventName: sectionPath[1],
					matcher:   "*",
				})
				idx := len(groups) - 1
				currentGroup = &idx
				currentHook = nil
			} else if len(sectionPath) == 3 && sectionPath[0] == "hooks" && sectionPath[2] == "hooks" {
				if currentGroup == nil || groups[*currentGroup].eventName != sectionPath[1] {
					groups = append(groups, hookGroup{
						eventName: sectionPath[1],
						matcher:   "*",
					})
					idx := len(groups) - 1
					currentGroup = &idx
				}
				if currentGroup != nil {
					groups[*currentGroup].hooks = append(groups[*currentGroup].hooks, make(map[string]any))
					hookIdx := len(groups[*currentGroup].hooks) - 1
					currentHook = &hookIdx
				}
			} else {
				currentGroup = nil
				currentHook = nil
			}
			continue
		}

		if tomlSectionPattern.MatchString(line) {
			currentGroup = nil
			currentHook = nil
			continue
		}

		key, rawValue, ok := parseKeyValueLine(line)
		if !ok || currentGroup == nil {
			continue
		}

		var parsed any
		if secretLikePath([]string{key}) {
			parsed = "[redacted]"
		} else {
			parsed = parsers.ParseTOMLScalar(rawValue)
		}

		if currentHook != nil {
			groups[*currentGroup].hooks[*currentHook][key] = parsed
		} else if key == "matcher" {
			if matcher, ok := parsed.(string); ok {
				groups[*currentGroup].matcher = matcher
			}
		}
	}

	hooks := make(map[string]any)
	for _, group := range groups {
		var items []any
		if existing, ok := hooks[group.eventName].([]any); ok {
			items = existing
		}
		nestedHooks := make([]any, len(group.hooks))
		for i, hook := range group.hooks {
			nestedHooks[i] = hook
		}
		items = append(items, map[string]any{
			"matcher": group.matcher,
			"hooks":   nestedHooks,
		})
		hooks[group.eventName] = items
	}

	return codexHookItemsFromValue(target, map[string]any{"hooks": hooks}, base)
}

func codexHookItemsFromValue(target scan.ScanTarget, value map[string]any, base scan.ScannerBase) []types.DiscoveredItem {
	hooksValue, ok := value["hooks"].(map[string]any)
	if !ok {
		return nil
	}

	var evidence []types.DiscoveredItem
	evidenceTarget := scan.EvidenceBaseTargetFromScanTarget(target)

	for eventName, eventHooksValue := range hooksValue {
		eventHooks, ok := eventHooksValue.([]any)
		if !ok {
			continue
		}
		for groupIndex, groupValue := range eventHooks {
			group, ok := groupValue.(map[string]any)
			if !ok {
				continue
			}
			matcher := "*"
			if m, ok := group["matcher"].(string); ok {
				matcher = m
			}
			nestedHooks, ok := anySlice(group["hooks"])
			if !ok {
				continue
			}
			for hookIndex, hookValue := range nestedHooks {
				hook, ok := hookValue.(map[string]any)
				if !ok {
					continue
				}
				command, _ := hook["command"].(string)
				hookType := "command"
				if t, ok := hook["type"].(string); ok {
					hookType = t
				}
				var timeout *float64
				if t, ok := hook["timeout"].(float64); ok {
					timeout = &t
				}

				hookPayload := map[string]any{"type": hookType}
				if command != "" {
					hookPayload["command"] = command
				}
				if timeout != nil {
					hookPayload["timeout"] = *timeout
				}

				source := target.Scope.String()
				if target.Scope == types.ScopeManaged {
					source = "plugin"
				}

				metadata := map[string]any{
					"executable": hookType == "command" && command != "",
					"eventName":  eventName,
					"matcher":    matcher,
					"hookIndex":  hookIndex,
					"groupIndex": groupIndex,
					"source":     source,
				}

				item := base.Captured(evidenceTarget, types.KindHook, metadata, hookPayload)
				item.ID = scan.ScannerItemID(
					target.Scope,
					target.Agent,
					target.SourcePath,
					formatHookID(eventName, groupIndex, hookIndex),
				)
				item.Name = stringPtr(eventName + "." + matcher)
				if target.Parser == types.ParserToml {
					item.Parser = types.ParserToml
				} else {
					item.Parser = types.ParserJSON
				}
				evidence = append(evidence, item)
			}
		}
	}

	return evidence
}

func formatHookID(eventName string, groupIndex, hookIndex int) string {
	return "hook-" + eventName + "-" + itoa(groupIndex) + "-" + itoa(hookIndex)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

type skillFrontmatter struct {
	name string
}

type skillFileScan struct {
	files []string
}

func findSkillFiles(root string) skillFileScan {
	var files []string
	seen := make(map[string]struct{})
	deadline := time.Now().Add(codexSkillScanBudgetMS * time.Millisecond)
	walkSkillFiles(root, &files, 0, seen, deadline)
	return skillFileScan{files: files}
}

func walkSkillFiles(dir string, files *[]string, depth uint32, seen map[string]struct{}, deadline time.Time) {
	if depth > 8 || time.Now().After(deadline) || len(*files) >= codexSkillMaxFilesPerRoot {
		return
	}

	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return
	}
	if _, ok := seen[resolved]; ok {
		return
	}
	seen[resolved] = struct{}{}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	if len(entries) > policy.MaxDirectoryEntries {
		entries = entries[:policy.MaxDirectoryEntries]
	}

	for _, entry := range entries {
		if time.Now().After(deadline) || len(*files) >= codexSkillMaxFilesPerRoot {
			return
		}

		path := filepath.Join(dir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}

		if info.IsDir() {
			walkSkillFiles(path, files, depth+1, seen, deadline)
		} else if info.Mode().IsRegular() && strings.EqualFold(entry.Name(), "skill.md") {
			*files = append(*files, path)
		}
	}
}

func readSkillFrontmatter(filePath string) *skillFrontmatter {
	text, err := os.ReadFile(filePath)
	if err != nil {
		return nil
	}
	matches := skillFrontmatterPattern.FindStringSubmatch(string(text))
	if len(matches) != 2 {
		return nil
	}

	frontmatter := &skillFrontmatter{}
	for _, line := range strings.Split(matches[1], "\n") {
		if caps := skillNameLinePattern.FindStringSubmatch(strings.TrimSpace(line)); len(caps) == 3 && caps[1] == "name" {
			frontmatter.name = scan.UnquoteYAMLScalar(caps[2])
		}
	}
	return frontmatter
}

func dedupeSkillsBySource(evidence []types.DiscoveredItem) []types.DiscoveredItem {
	seen := make(map[string]struct{})
	var result []types.DiscoveredItem
	for _, item := range evidence {
		if _, ok := seen[item.SourcePath]; ok {
			continue
		}
		seen[item.SourcePath] = struct{}{}
		result = append(result, item)
	}
	return result
}

func stringPtr(value string) *string {
	return &value
}

func anySlice(value any) ([]any, bool) {
	switch v := value.(type) {
	case []any:
		return v, true
	case []map[string]any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = item
		}
		return out, true
	default:
		return nil, false
	}
}

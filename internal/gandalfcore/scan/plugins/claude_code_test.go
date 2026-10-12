package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qyinm/gandalf/internal/gandalfcore/scan"
	"github.com/qyinm/gandalf/internal/gandalfcore/setup"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

func TestClaudeCodeScannerDiscoversPluginMarketplaces(t *testing.T) {
	homeDir := t.TempDir()
	writeFile(t, filepath.Join(homeDir, ".claude/plugins/known_marketplaces.json"), `{
		"empty-marketplace": {
			"source": {"source": "github", "repo": "example/empty"},
			"installLocation": "`+filepath.ToSlash(filepath.Join(homeDir, ".claude/plugins/marketplaces/empty-marketplace"))+`"
		},
		"openai-codex": {
			"source": {"source": "github", "repo": "openai/codex-plugin-cc"},
			"installLocation": "`+filepath.ToSlash(filepath.Join(homeDir, ".claude/plugins/marketplaces/openai-codex"))+`"
		}
	}`)
	writeFile(t, filepath.Join(homeDir, ".claude/plugins/installed_plugins.json"), `{
		"version": 2,
		"plugins": {
			"codex@openai-codex": [{
				"scope": "user",
				"version": "1.0.2"
			}]
		}
	}`)
	writeFile(t, filepath.Join(homeDir, ".claude/plugins/marketplaces/empty-marketplace/.claude-plugin/marketplace.json"), `{
		"name": "empty-marketplace",
		"plugins": []
	}`)
	writeFile(t, filepath.Join(homeDir, ".claude/plugins/marketplaces/openai-codex/.claude-plugin/marketplace.json"), `{
		"name": "openai-codex",
		"owner": {"name": "OpenAI"},
		"plugins": [{
			"name": "codex",
			"description": "Use Codex from Claude Code.",
			"version": "1.0.2",
			"author": {"name": "OpenAI"},
			"source": "./plugins/codex",
			"category": "development"
		}]
	}`)

	evidence := ClaudeCodeScanner{}.Scan(&scan.ScannerContext{
		ProjectPath: t.TempDir(),
		HomeDir:     homeDir,
	})
	sources := setup.BuildMarketplace(evidence)

	if len(sources) != 2 {
		t.Fatalf("sources = %#v", sources)
	}
	empty := findMarketplaceSourceByLabel(t, sources, "empty-marketplace")
	if empty.Kind != setup.MarketplaceSourceMarketplace || len(empty.Entries) != 0 {
		t.Fatalf("empty marketplace = %#v", empty)
	}
	openai := findMarketplaceSourceByLabel(t, sources, "openai-codex")
	if openai.Kind != setup.MarketplaceSourceMarketplace || len(openai.Entries) != 1 {
		t.Fatalf("openai marketplace = %#v", openai)
	}
	entry := openai.Entries[0]
	if entry.Name != "codex" || !entry.Installed || entry.Status != "installed" {
		t.Fatalf("entry = %#v", entry)
	}
	if len(entry.Provides) != 1 || entry.Provides[0] != "plugin" {
		t.Fatalf("provides = %#v", entry.Provides)
	}
}

func TestClaudeCodeScannerEmitsInstalledPluginsAsInventory(t *testing.T) {
	homeDir := t.TempDir()
	writeFile(t, filepath.Join(homeDir, ".claude/plugins/installed_plugins.json"), `{
		"version": 2,
		"plugins": {
			"codex@openai-codex": [{"scope": "user", "version": "1.0.2"}],
			"vercel@claude-plugins-official": [{"scope": "user", "version": "1.0.0"}]
		}
	}`)

	evidence := ClaudeCodeScanner{}.Scan(&scan.ScannerContext{
		ProjectPath: t.TempDir(),
		HomeDir:     homeDir,
	})

	inventory := setup.BuildInventory(evidence)
	plugins := make(map[string]setup.InventoryItem)
	for _, item := range inventory {
		if item.ObjectKind == setup.ObjectPlugin {
			plugins[item.Name] = item
		}
	}
	if len(plugins) != 2 {
		t.Fatalf("expected 2 plugin inventory items, got %d: %#v", len(plugins), plugins)
	}
	if _, ok := plugins["codex"]; !ok {
		t.Fatalf("expected codex plugin in inventory: %#v", plugins)
	}
	if _, ok := plugins["vercel"]; !ok {
		t.Fatalf("expected vercel plugin in inventory: %#v", plugins)
	}

	// Installed plugins are inventory, not extra marketplace sources.
	if sources := setup.BuildMarketplace(evidence); len(sources) != 0 {
		t.Fatalf("installed plugins must not appear as marketplace sources: %#v", sources)
	}
}

func TestClaudeCodeInstalledPluginInventoryOnlyUsesUserScope(t *testing.T) {
	homeDir := t.TempDir()
	writeFile(t, filepath.Join(homeDir, ".claude/plugins/installed_plugins.json"), `{
		"version": 2,
		"plugins": {
			"project-only@openai-codex": [{"scope": "project", "version": "1.0.0"}],
			"user-install@openai-codex": [{"scope": "project", "version": "0.1.0"}, {"scope": "user", "version": "1.2.0"}]
		}
	}`)

	evidence := ClaudeCodeScanner{}.Scan(&scan.ScannerContext{
		ProjectPath: t.TempDir(),
		HomeDir:     homeDir,
	})
	inventory := setup.BuildInventory(evidence)
	plugins := make(map[string]setup.InventoryItem)
	for _, item := range inventory {
		if item.ObjectKind == setup.ObjectPlugin {
			plugins[item.Name] = item
		}
	}
	if _, ok := plugins["project-only"]; ok {
		t.Fatalf("project-scoped plugin should not be user inventory: %#v", plugins["project-only"])
	}
	if item, ok := plugins["user-install"]; !ok {
		t.Fatalf("expected user-scoped install in inventory: %#v", plugins)
	} else if item.Scope != types.ScopeUser {
		t.Fatalf("scope = %s, want user", item.Scope)
	}
}

func findMarketplaceSourceByLabel(t *testing.T, sources []setup.MarketplaceSource, label string) setup.MarketplaceSource {
	t.Helper()
	for _, source := range sources {
		if source.Label == label {
			return source
		}
	}
	t.Fatalf("missing marketplace source %q: %#v", label, sources)
	return setup.MarketplaceSource{}
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeCodeScannerEmitsUserMCPServersFromGlobalConfig(t *testing.T) {
	homeDir := t.TempDir()
	writeFile(t, filepath.Join(homeDir, ".claude.json"), `{
		"numStartups": 42,
		"projects": {"/work/app": {"mcpServers": {"local-only": {"command": "node"}}}},
		"mcpServers": {
			"github": {
				"command": "npx",
				"args": ["-y", "@modelcontextprotocol/server-github"],
				"env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_supersecretvalue123"}
			},
			"playwright": {"command": "npx", "args": ["@playwright/mcp@latest"]}
		}
	}`)

	evidence := ClaudeCodeScanner{}.Scan(&scan.ScannerContext{
		ProjectPath: t.TempDir(),
		HomeDir:     homeDir,
	})

	servers := map[string]types.DiscoveredItem{}
	for _, item := range evidence {
		if item.Kind == types.KindMcpServer && item.SourcePath == "~/.claude.json" {
			servers[*item.Name] = item
		}
	}
	if len(servers) != 2 {
		t.Fatalf("user MCP servers = %#v, want github and playwright only", servers)
	}

	github := servers["github"]
	if github.Scope != types.ScopeUser || github.RestorePolicy != types.RestoreNotSupported {
		t.Fatalf("github scope/restore = %s/%s", github.Scope, github.RestorePolicy)
	}
	if strings.Contains(string(github.Value), "supersecret") {
		t.Fatalf("redacted value leaks the secret: %s", github.Value)
	}
	if !strings.Contains(string(github.Value), "GITHUB_PERSONAL_ACCESS_TOKEN") {
		t.Fatalf("redacted value should keep env key names: %s", github.Value)
	}
	if !strings.Contains(string(github.Metadata), "env.GITHUB_PERSONAL_ACCESS_TOKEN") {
		t.Fatalf("metadata should record the plaintext secret location: %s", github.Metadata)
	}
	if strings.Contains(string(servers["playwright"].Metadata), "plaintextSecrets") {
		t.Fatalf("playwright has no secrets: %s", servers["playwright"].Metadata)
	}

	for _, item := range evidence {
		if item.SourcePath == "~/.claude.json" && item.Kind == types.KindAgentConfig && len(item.Value) > 0 {
			t.Fatalf("~/.claude.json file evidence must stay metadata-only, got value %s", item.Value)
		}
	}
}

func TestClaudeCodeScannerSkipsUserMCPServersForProjectScope(t *testing.T) {
	homeDir := t.TempDir()
	writeFile(t, filepath.Join(homeDir, ".claude.json"), `{"mcpServers": {"github": {"command": "npx"}}}`)
	projectScope := types.ScopeProject

	evidence := ClaudeCodeScanner{}.Scan(&scan.ScannerContext{
		ProjectPath: t.TempDir(),
		HomeDir:     homeDir,
		Scope:       &projectScope,
	})
	for _, item := range evidence {
		if item.Kind == types.KindMcpServer && item.SourcePath == "~/.claude.json" {
			t.Fatalf("project scope must not read user MCP servers: %#v", item)
		}
	}
}

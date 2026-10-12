package plugins

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/qyinm/gandalf/internal/gandalfcore/scan"
	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

func TestCodexMCPServersFromTOML(t *testing.T) {
	text := `[mcp_servers.context7]
command = "npx"
args = [
  "-y",
  "@upstash/context7-mcp",
]

[mcp_servers.node_repl]
command = "node"
enabled = false

[mcp_servers.node_repl.env]
OPENAI_API_KEY = "secret"
`
	servers := codexMCPServersFromTOML(text)
	if len(servers) != 2 {
		t.Fatalf("server count = %d", len(servers))
	}

	context7 := servers["context7"]
	if context7["command"] != "npx" {
		t.Fatalf("context7 command = %#v", context7["command"])
	}
	args, _ := context7["args"].([]any)
	if len(args) != 2 {
		t.Fatalf("context7 args = %#v", context7["args"])
	}

	nodeRepl := servers["node_repl"]
	if nodeRepl["enabled"] != false {
		t.Fatalf("node_repl enabled = %#v", nodeRepl["enabled"])
	}
	envKeys, _ := nodeRepl["envKeys"].([]any)
	if len(envKeys) != 1 || envKeys[0] != "OPENAI_API_KEY" {
		t.Fatalf("node_repl envKeys = %#v", nodeRepl["envKeys"])
	}

	serialized, err := json.Marshal(servers)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(serialized), "secret") {
		t.Fatalf("serialized servers leaked secret: %s", serialized)
	}
}

func TestCodexPluginKeysFromTOML(t *testing.T) {
	text := `model = "gpt-5"

[plugins."vercel@openai-curated"]

[plugins."documents@openai-primary-runtime"]

[projects."/Users/x/some-plugin-thing"]

[mcp_servers.context7]
command = "npx"
`
	keys := codexPluginKeysFromTOML(text)
	if len(keys) != 2 {
		t.Fatalf("expected 2 plugin keys, got %#v", keys)
	}
	if keys[0] != "vercel@openai-curated" || keys[1] != "documents@openai-primary-runtime" {
		t.Fatalf("plugin keys = %#v", keys)
	}

	name, marketplace := splitPluginKey(keys[0])
	if name != "vercel" || marketplace != "openai-curated" {
		t.Fatalf("split = %q %q", name, marketplace)
	}
}

func TestCodexInlineHookItemsFromTOML(t *testing.T) {
	text := `model = "gpt-5"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "notify"
`
	target := scan.HomeTarget("/tmp", ".codex/config.toml", types.AgentCodex, types.KindHook, types.ParserToml, scan.ScanTargetOverrides{})
	base := scan.NewScannerBase(types.AgentCodex)
	items := codexInlineHookItemsFromTOML(target, text, base)

	if len(items) != 1 {
		t.Fatalf("hook count = %d", len(items))
	}
	if items[0].Name == nil || *items[0].Name != "Stop.*" {
		t.Fatalf("hook name = %#v", items[0].Name)
	}
	if items[0].Parser != types.ParserToml {
		t.Fatalf("parser = %q", items[0].Parser)
	}
}

func TestCodexHookItemsFromValue(t *testing.T) {
	value := map[string]any{
		"hooks": map[string]any{
			"PreToolUse": []any{
				map[string]any{
					"matcher": "Write",
					"hooks": []any{
						map[string]any{
							"type":    "command",
							"command": "project-hook",
							"timeout": float64(5),
						},
					},
				},
			},
		},
	}
	target := scan.ProjectTarget("/tmp", ".codex/hooks.json", types.AgentCodex, types.KindHook, types.ParserJSON, scan.ScanTargetOverrides{})
	base := scan.NewScannerBase(types.AgentCodex)
	items := codexHookItemsFromValue(target, value, base)

	if len(items) != 1 {
		t.Fatalf("hook count = %d", len(items))
	}
	if items[0].Name == nil || *items[0].Name != "PreToolUse.Write" {
		t.Fatalf("hook name = %#v", items[0].Name)
	}

	var metadata map[string]any
	if err := json.Unmarshal(items[0].Metadata, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["executable"] != true {
		t.Fatalf("executable = %#v", metadata["executable"])
	}
}

func TestReadSkillFrontmatter(t *testing.T) {
	t.Run("extracts name", func(t *testing.T) {
		frontmatter := readSkillFrontmatterFromText("---\nname: review\ndescription: Review code\n---\n")
		if frontmatter == nil || frontmatter.name != "review" {
			t.Fatalf("frontmatter = %#v", frontmatter)
		}
	})

	t.Run("returns nil without frontmatter", func(t *testing.T) {
		if readSkillFrontmatterFromText("no frontmatter") != nil {
			t.Fatal("expected nil frontmatter")
		}
	})
}

func readSkillFrontmatterFromText(text string) *skillFrontmatter {
	matches := skillFrontmatterPattern.FindStringSubmatch(text)
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

func TestDedupeSkillsBySource(t *testing.T) {
	first := types.DiscoveredItem{SourcePath: "~/.codex/skills/review"}
	second := types.DiscoveredItem{SourcePath: "~/.codex/skills/review"}
	other := types.DiscoveredItem{SourcePath: "~/.codex/skills/lint"}
	result := dedupeSkillsBySource([]types.DiscoveredItem{first, second, other})
	if len(result) != 2 {
		t.Fatalf("deduped count = %d", len(result))
	}
}

func TestCodexMCPInlineEnvTableKeepsKeysOnly(t *testing.T) {
	servers := codexMCPServersFromTOML(`
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_supersecretvalue123", LOG_LEVEL = "debug", API_KEY = "${API_KEY}" }
http_headers = { Authorization = "Bearer abc123", "X-Trace" = "on" }
`)
	server := servers["github"]
	raw, err := json.Marshal(server)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if strings.Contains(text, "supersecret") || strings.Contains(text, "abc123") {
		t.Fatalf("inline table values leaked into evidence: %s", text)
	}
	keys, _ := server["envKeys"].([]any)
	if len(keys) != 3 {
		t.Fatalf("envKeys = %#v, want all three inline env keys", server["envKeys"])
	}
	headers, _ := server["http_headers"].(map[string]any)
	if headers["X-Trace"] != "on" || headers["Authorization"] != "[redacted]" {
		t.Fatalf("http_headers = %#v", server["http_headers"])
	}
	locations := takeCodexPlaintextSecrets(server)
	if strings.Join(uniqueSorted(locations), ",") != "env.GITHUB_PERSONAL_ACCESS_TOKEN,http_headers.Authorization" {
		t.Fatalf("plaintext secret locations = %#v", locations)
	}
	if _, ok := server[codexPlaintextSecretsKey]; ok {
		t.Fatal("side-channel key must be removed from the server value")
	}
}

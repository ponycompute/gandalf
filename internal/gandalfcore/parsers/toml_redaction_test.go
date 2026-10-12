package parsers

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseTOMLKeyValuesRedactsInlineTablesAndURLCredentials(t *testing.T) {
	result := ParseTOMLKeyValues(`
model = "gpt-5"
[mcp_servers.gh]
command = "npx"
args = ["srv", "postgresql://u:hunter2@db/x"]
env = { GITHUB_TOKEN = "ghp_supersecretvalue123", LOG_LEVEL = "debug" }
http_headers = { Authorization = "Bearer abc123", "X-Trace" = "on" }
`)
	if result.Err != nil {
		t.Fatalf("parse failed: %s", result.Err.Error)
	}
	raw, err := json.Marshal(result.Ok.Value)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, secret := range []string{"hunter2", "supersecret", "abc123"} {
		if strings.Contains(text, secret) {
			t.Fatalf("parsed TOML leaks %q: %s", secret, text)
		}
	}
	for _, kept := range []string{"gpt-5", "GITHUB_TOKEN", "LOG_LEVEL", "X-Trace", "postgresql://u:[redacted]@db/x"} {
		if !strings.Contains(text, kept) {
			t.Fatalf("parsed TOML dropped %q: %s", kept, text)
		}
	}
}

func TestParseTOMLInlineTable(t *testing.T) {
	entries, ok := ParseTOMLInlineTable(`{ A = "x, y", "B-C" = [1, 2], D = { E = "f" } }`)
	if !ok || len(entries) != 3 {
		t.Fatalf("entries = %#v ok = %v", entries, ok)
	}
	if entries[0][1] != `"x, y"` || entries[1][0] != `"B-C"` || entries[2][1] != `{ E = "f" }` {
		t.Fatalf("entries = %#v", entries)
	}
	if _, ok := ParseTOMLInlineTable(`"not a table"`); ok {
		t.Fatal("a string is not an inline table")
	}
}

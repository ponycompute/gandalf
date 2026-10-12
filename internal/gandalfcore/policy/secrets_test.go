package policy

import (
	"reflect"
	"strings"
	"testing"
)

func TestPlaintextSecretLocations(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  []string
	}{
		{
			name:  "secret-like env key with literal value",
			value: `{"command":"npx","env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"ghp_abcdefghijklmnop"}}`,
			want:  []string{"env.GITHUB_PERSONAL_ACCESS_TOKEN"},
		},
		{
			name:  "env references are not plaintext",
			value: `{"env":{"API_KEY":"${API_KEY}","TOKEN":"$TOKEN","SECRET":"{env:SECRET}"}}`,
			want:  nil,
		},
		{
			name:  "token prefix under a neutral key",
			value: `{"env":{"SLACK":"xoxb-1234567890-abcdef"}}`,
			want:  []string{"env.SLACK"},
		},
		{
			name:  "credentials embedded in an args URL",
			value: `{"command":"npx","args":["-y","server-postgres","postgresql://admin:hunter2@db:5432/app"]}`,
			want:  []string{"URL credentials in args"},
		},
		{
			name:  "token passed as an argument",
			value: `{"args":["--token","sk-ant-abcdefghijklmnopqrstu"]}`,
			want:  []string{"token in args"},
		},
		{
			name:  "remote server header",
			value: `{"url":"https://mcp.example.com","headers":{"Authorization":"Bearer abc123"}}`,
			want:  []string{"headers.Authorization"},
		},
		{
			name:  "env var name fields are not secrets",
			value: `{"url":"https://mcp.example.com","bearer_token_env_var":"EXAMPLE_TOKEN"}`,
			want:  nil,
		},
		{
			name:  "redacted values are ignored",
			value: `{"token":"[redacted]","envKeys":["API_KEY"]}`,
			want:  nil,
		},
		{
			name:  "clean server",
			value: `{"command":"npx","args":["@playwright/mcp@latest"]}`,
			want:  nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := PlaintextSecretLocations([]byte(tt.value))
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("PlaintextSecretLocations() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestPlaintextSecretLocationsNeverReturnsValues(t *testing.T) {
	value := `{"env":{"GITHUB_TOKEN":"ghp_supersecretvalue123"},"args":["postgresql://u:hunter2@h/db"]}`
	for _, location := range PlaintextSecretLocations([]byte(value)) {
		if strings.Contains(location, "supersecret") || strings.Contains(location, "hunter2") {
			t.Fatalf("location leaks the secret value: %q", location)
		}
	}
}

func TestRedactMCPServerValueScrubsInlineCredentials(t *testing.T) {
	value := `{"command":"npx","args":["-y","server-postgres","postgresql://admin:hunter2@db/app"],"env":{"API_KEY":"abc"}}`
	redacted, err := RedactMCPServerValue([]byte(value))
	if err != nil {
		t.Fatal(err)
	}
	text := string(redacted)
	if strings.Contains(text, "hunter2") || strings.Contains(text, `"abc"`) {
		t.Fatalf("redacted value still carries secrets: %s", text)
	}
	if !strings.Contains(text, "server-postgres") || !strings.Contains(text, "API_KEY") {
		t.Fatalf("redaction removed non-secret structure: %s", text)
	}
}

func TestScrubInlineSecretsKeepsShape(t *testing.T) {
	cases := map[string]string{
		"postgresql://admin:hunter2@db:5432/app": "postgresql://admin:[redacted]@db:5432/app",
		"--token=ghp_abcdefghijklmnop":           "--token=[redacted]",
		"https://mcp.linear.app/sse":             "https://mcp.linear.app/sse",
		"@playwright/mcp@latest":                 "@playwright/mcp@latest",
	}
	for input, want := range cases {
		if got := ScrubInlineSecrets(input); got != want {
			t.Fatalf("ScrubInlineSecrets(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestRedactJSONOutput(t *testing.T) {
	clean := []byte(`{"z":1,"a":{"value":{"command":"npx"}}}`)
	if got := RedactJSONOutput(clean); string(got) != string(clean) {
		t.Fatalf("clean output must pass through unchanged, got %s", got)
	}

	dirty := []byte(`{"evidence":[{"kind":"agent_config","authConfigured":false,"value":{"env":{"GITHUB_TOKEN":"ghp_supersecretvalue123"},"api_key":"plain"},"metadata":{"command":"curl https://u:hunter2@host/x"}}]}`)
	got := string(RedactJSONOutput(dirty))
	for _, secret := range []string{"supersecret", "hunter2", `"plain"`} {
		if strings.Contains(got, secret) {
			t.Fatalf("output still contains %q: %s", secret, got)
		}
	}
	if !strings.Contains(got, `"authConfigured": false`) {
		t.Fatalf("non-value fields must keep their type: %s", got)
	}
}

func TestContainsRedaction(t *testing.T) {
	if !ContainsRedaction([]byte(`{"args":["x://u:[redacted]@h"]}`)) || !ContainsRedaction([]byte(`{"envKeys":["A"]}`)) {
		t.Fatal("expected redaction markers to be detected")
	}
	if ContainsRedaction([]byte(`{"command":"npx","env":{"A":"b"}}`)) {
		t.Fatal("a faithful value is not redacted")
	}
}

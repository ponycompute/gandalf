package policy

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

var (
	// credentialURLPattern matches userinfo credentials embedded in a URL,
	// such as postgresql://user:password@host/db.
	credentialURLPattern = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@`)

	// tokenPattern matches well-known credential prefixes so plaintext tokens
	// are caught even when stored under a non-obvious key or inside args.
	tokenPattern = regexp.MustCompile(`(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|glpat-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})`)

	// envReferencePattern matches values that point at an environment
	// variable instead of holding the secret itself.
	envReferencePattern = regexp.MustCompile(`^\s*(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\{env:[^}]+\})\s*$`)
)

// secretMapFields are MCP server fields whose entries are name/value pairs
// that commonly carry credentials.
var secretMapFields = []string{"env", "headers", "http_headers"}

// PlaintextSecretLocations reports where an MCP server configuration stores a
// credential in plaintext. It returns field locations such as
// "env.GITHUB_TOKEN" or "URL credentials in args" and never the values
// themselves, so callers can surface the risk without leaking the secret.
func PlaintextSecretLocations(value json.RawMessage) []string {
	if len(value) == 0 {
		return nil
	}
	var server map[string]any
	if err := json.Unmarshal(value, &server); err != nil {
		return nil
	}

	found := make(map[string]struct{})
	for _, field := range secretMapFields {
		entries, ok := server[field].(map[string]any)
		if !ok {
			continue
		}
		for key, raw := range entries {
			text, ok := raw.(string)
			if !ok || !isPlaintextValue(text) {
				continue
			}
			if IsSecretLikeKey(key) || tokenPattern.MatchString(text) {
				found[field+"."+key] = struct{}{}
			}
		}
	}

	for key, raw := range server {
		text, ok := raw.(string)
		if !ok || !isPlaintextValue(text) {
			continue
		}
		switch {
		case key == "url" || key == "command":
			if label := inlineSecretLabel(text); label != "" {
				found[label+" in "+key] = struct{}{}
			}
		case IsSecretLikeKey(key) && !namesEnvVariable(key):
			found[key] = struct{}{}
		}
	}

	if args, ok := server["args"].([]any); ok {
		for _, arg := range args {
			text, ok := arg.(string)
			if !ok {
				continue
			}
			if label := inlineSecretLabel(text); label != "" {
				found[label+" in args"] = struct{}{}
			}
		}
	}

	if len(found) == 0 {
		return nil
	}
	locations := make([]string, 0, len(found))
	for location := range found {
		locations = append(locations, location)
	}
	sort.Strings(locations)
	return locations
}

func isPlaintextValue(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || trimmed == "[redacted]" {
		return false
	}
	return !envReferencePattern.MatchString(trimmed)
}

// namesEnvVariable reports keys whose value is the name of an environment
// variable (Codex bearer_token_env_var, for example), not the secret itself.
func namesEnvVariable(key string) bool {
	lower := strings.ToLower(key)
	return strings.HasSuffix(lower, "env_var") || strings.HasSuffix(lower, "_env")
}

func inlineSecretLabel(text string) string {
	switch {
	case credentialURLPattern.MatchString(text):
		return "URL credentials"
	case tokenPattern.MatchString(text):
		return "token"
	default:
		return ""
	}
}

// RedactMCPServerValue redacts an MCP server value for evidence that must not
// carry secrets: env values become envKeys, secret-like keys become
// "[redacted]", and credentials embedded in args, url, or command strings are
// replaced with "[redacted]".
func RedactMCPServerValue(value json.RawMessage) (json.RawMessage, error) {
	redacted, err := RedactStructuredValue(value)
	if err != nil {
		return nil, err
	}
	var server map[string]any
	if err := json.Unmarshal(redacted, &server); err != nil {
		return redacted, nil
	}
	for _, key := range []string{"url", "command"} {
		if text, ok := server[key].(string); ok && inlineSecretLabel(text) != "" {
			server[key] = "[redacted]"
		}
	}
	if args, ok := server["args"].([]any); ok {
		for i, arg := range args {
			if text, ok := arg.(string); ok && inlineSecretLabel(text) != "" {
				args[i] = "[redacted]"
			}
		}
	}
	return json.Marshal(server)
}

// IsPlaintextSecret reports whether a name/value pair holds a literal
// credential: the value is not an environment reference and either the name
// is secret-like or the value carries a known token format.
func IsPlaintextSecret(name, value string) bool {
	if !isPlaintextValue(value) || namesEnvVariable(name) {
		return false
	}
	return IsSecretLikeKey(name) || tokenPattern.MatchString(value) || credentialURLPattern.MatchString(value)
}

package policy

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

var (
	// credentialURLPattern matches userinfo credentials embedded in a URL,
	// such as postgresql://user:password@host/db. Group 1 keeps the scheme and
	// user so scrubbing can replace only the password.
	credentialURLPattern = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]+:)[^/\s@]+@`)

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

// ScrubInlineSecrets masks credentials embedded inside a longer string: the
// password part of URL userinfo and known token formats. Everything else is
// kept so the value stays recognizable (postgresql://admin:[redacted]@db/app).
func ScrubInlineSecrets(text string) string {
	if !credentialURLPattern.MatchString(text) && !tokenPattern.MatchString(text) {
		return text
	}
	scrubbed := credentialURLPattern.ReplaceAllString(text, "${1}[redacted]@")
	return tokenPattern.ReplaceAllString(scrubbed, "[redacted]")
}

// RedactMCPServerValue redacts an MCP server value for evidence that must not
// carry secrets: env values become envKeys, secret-like keys become
// "[redacted]", and credentials embedded in strings such as args or url are
// masked in place.
func RedactMCPServerValue(value json.RawMessage) (json.RawMessage, error) {
	return RedactStructuredValue(value)
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

// valueCarryingFields are output fields that hold captured config values.
// Key-based redaction applies inside them; elsewhere only inline credentials
// in strings are masked, so output field types and names stay unchanged.
var valueCarryingFields = map[string]bool{
	"value":          true,
	"effectiveValue": true,
	"before":         true,
	"after":          true,
	"targetContent":  true,
}

// RedactJSONOutput masks secrets in a JSON document about to be printed.
// Snapshots written by older versions may hold raw values; this keeps them
// out of CLI output without changing what is stored or restored. It returns
// the input unchanged when nothing needed masking, preserving field order.
func RedactJSONOutput(data []byte) []byte {
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return data
	}
	sanitized, changed := sanitizeOutput(decoded)
	if !changed {
		return data
	}
	out, err := json.MarshalIndent(sanitized, "", "  ")
	if err != nil {
		return data
	}
	return out
}

func sanitizeOutput(value any) (any, bool) {
	switch v := value.(type) {
	case string:
		scrubbed := ScrubInlineSecrets(v)
		return scrubbed, scrubbed != v
	case []any:
		changed := false
		for i, item := range v {
			next, itemChanged := sanitizeOutput(item)
			v[i] = next
			changed = changed || itemChanged
		}
		return v, changed
	case map[string]any:
		changed := false
		for key, nested := range v {
			if valueCarryingFields[key] {
				before, _ := json.Marshal(nested)
				redacted := redactValue(nested)
				after, _ := json.Marshal(redacted)
				v[key] = redacted
				if string(before) != string(after) {
					changed = true
				}
				continue
			}
			next, nestedChanged := sanitizeOutput(nested)
			v[key] = next
			changed = changed || nestedChanged
		}
		return v, changed
	default:
		return value, false
	}
}

// ContainsRedaction reports whether a captured value was redacted, either by
// masking ("[redacted]") or by reducing an env table to envKeys. Such a value
// is not a faithful copy of the original and must never be written back.
func ContainsRedaction(value json.RawMessage) bool {
	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		return false
	}
	return containsRedaction(decoded)
}

func containsRedaction(value any) bool {
	switch v := value.(type) {
	case string:
		return strings.Contains(v, "[redacted]")
	case []any:
		for _, item := range v {
			if containsRedaction(item) {
				return true
			}
		}
	case map[string]any:
		if _, ok := v["envKeys"]; ok {
			return true
		}
		for _, nested := range v {
			if containsRedaction(nested) {
				return true
			}
		}
	}
	return false
}

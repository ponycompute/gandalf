package parsers

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/qyinm/gandalf/internal/gandalfcore/policy"
)

type ParseSuccess struct {
	Value any
}

type ParseFailure struct {
	Error string
}

type ParseResult struct {
	Ok  *ParseSuccess
	Err *ParseFailure
}

type DotenvEntry struct {
	Key           string
	SecretLike    bool
	CaptureStatus string
}

func ParseJSON(text string) ParseResult {
	var raw json.RawMessage
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return ParseResult{Err: &ParseFailure{Error: err.Error()}}
	}
	redacted, err := policy.RedactStructuredValue(raw)
	if err != nil {
		return ParseResult{Err: &ParseFailure{Error: err.Error()}}
	}
	var value any
	if err := json.Unmarshal(redacted, &value); err != nil {
		return ParseResult{Err: &ParseFailure{Error: err.Error()}}
	}
	return ParseResult{Ok: &ParseSuccess{Value: value}}
}

func ParseTOMLKeyValues(text string) ParseResult {
	value := make(map[string]any)
	lines := strings.Split(text, "\n")
	index := 0

	for index < len(lines) {
		line := strings.TrimSuffix(strings.TrimSpace(lines[index]), "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			index++
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			index++
			continue
		}

		key, rawValue, ok := parseTOMLKeyValueLine(line)
		if !ok {
			index++
			continue
		}

		processedValue := strings.TrimSpace(rawValue)

		if strings.HasPrefix(processedValue, "[") && !strings.HasSuffix(processedValue, "]") {
			arrayLines := []string{processedValue}
			index++
			for index < len(lines) {
				continuationLine := strings.TrimSuffix(strings.TrimSpace(lines[index]), "\r")
				done := strings.HasSuffix(continuationLine, "]") || strings.HasSuffix(continuationLine, "],")
				arrayLines = append(arrayLines, continuationLine)
				index++
				if done {
					break
				}
			}
			processedValue = strings.Join(arrayLines, " ")
		} else {
			index++
		}

		var parsed any
		if policy.IsSecretLikeKey(key) {
			parsed = "[redacted]"
		} else if entries, ok := ParseTOMLInlineTable(processedValue); ok {
			parsed = inlineTableValue(entries)
		} else {
			parsed = ParseTOMLScalar(processedValue)
		}
		value[key] = parsed
	}

	// The shared redactor turns env tables into envKeys and masks credentials
	// embedded in strings (URL passwords, known token formats).
	raw, err := json.Marshal(value)
	if err != nil {
		return ParseResult{Err: &ParseFailure{Error: err.Error()}}
	}
	redacted, err := policy.RedactStructuredValue(raw)
	if err != nil {
		return ParseResult{Err: &ParseFailure{Error: err.Error()}}
	}
	var out any
	if err := json.Unmarshal(redacted, &out); err != nil {
		return ParseResult{Err: &ParseFailure{Error: err.Error()}}
	}
	return ParseResult{Ok: &ParseSuccess{Value: out}}
}

// inlineTableValue converts inline-table entries to a map, redacting
// secret-like keys so values like env = { TOKEN = "..." } are never kept.
func inlineTableValue(entries [][2]string) map[string]any {
	table := make(map[string]any, len(entries))
	for _, entry := range entries {
		key := strings.Trim(strings.TrimSpace(entry[0]), `"'`)
		if policy.IsSecretLikeKey(key) {
			table[key] = "[redacted]"
			continue
		}
		if nested, ok := ParseTOMLInlineTable(entry[1]); ok {
			table[key] = inlineTableValue(nested)
			continue
		}
		table[key] = ParseTOMLScalar(entry[1])
	}
	return table
}

// ParseTOMLInlineTable splits a single-line TOML inline table into raw
// key/value pairs, respecting quotes and nested brackets or braces.
func ParseTOMLInlineTable(rawValue string) ([][2]string, bool) {
	trimmed := strings.TrimSpace(rawValue)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return nil, false
	}
	body := trimmed[1 : len(trimmed)-1]

	var parts []string
	var quote rune
	depth := 0
	start := 0
	runes := []rune(body)
	for index, ch := range runes {
		switch {
		case quote != 0:
			if ch == quote && (index == 0 || runes[index-1] != '\\') {
				quote = 0
			}
		case ch == '"' || ch == '\'':
			quote = ch
		case ch == '[' || ch == '{':
			depth++
		case ch == ']' || ch == '}':
			depth--
		case ch == ',' && depth == 0:
			parts = append(parts, string(runes[start:index]))
			start = index + 1
		}
	}
	parts = append(parts, string(runes[start:]))

	var entries [][2]string
	for _, part := range parts {
		key, value, ok := splitTOMLInlineEntry(part)
		if !ok {
			continue
		}
		entries = append(entries, [2]string{key, value})
	}
	return entries, true
}

// splitTOMLInlineEntry splits `key = value` at the first "=" outside quotes,
// so quoted keys such as "X-Trace" = "on" are supported.
func splitTOMLInlineEntry(part string) (string, string, bool) {
	var quote rune
	for index, ch := range part {
		switch {
		case quote != 0:
			if ch == quote {
				quote = 0
			}
		case ch == '"' || ch == '\'':
			quote = ch
		case ch == '=':
			key := strings.TrimSpace(part[:index])
			value := strings.TrimSpace(part[index+1:])
			if key == "" || value == "" {
				return "", "", false
			}
			return key, value, true
		}
	}
	return "", "", false
}

func ParseMarkdown(text string) ParseResult {
	frontmatter, ok := extractMarkdownFrontmatter(text)
	if !ok {
		return ParseResult{Ok: &ParseSuccess{Value: map[string]any{"hasFrontmatter": false}}}
	}

	metadata := make(map[string]any)
	for _, rawLine := range strings.Split(frontmatter, "\n") {
		line := strings.TrimSuffix(strings.TrimSpace(rawLine), "\r")
		key, rawValue, ok := parseMarkdownMetadataLine(line)
		if !ok {
			continue
		}
		var parsed any
		if policy.IsSecretLikeKey(key) {
			parsed = "[redacted]"
		} else {
			parsed = rawValue
		}
		metadata[key] = parsed
	}

	return ParseResult{Ok: &ParseSuccess{Value: map[string]any{
		"hasFrontmatter": true,
		"metadata":       metadata,
	}}}
}

func ParseDotenvKeys(text string) []DotenvEntry {
	var entries []DotenvEntry

	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSuffix(strings.TrimSpace(rawLine), "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		key, ok := parseDotenvKey(line)
		if !ok {
			continue
		}

		entries = append(entries, DotenvEntry{
			Key:           key,
			SecretLike:    policy.IsSecretLikeKey(key),
			CaptureStatus: policy.CaptureStatusForKey(key),
		})
	}

	return entries
}

func ParseTOMLScalar(rawValue string) any {
	value := strings.TrimSuffix(strings.TrimSpace(rawValue), ",")
	if (strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`)) ||
		(strings.HasPrefix(value, `'`) && strings.HasSuffix(value, `'`)) {
		return value[1 : len(value)-1]
	}
	if value == "true" {
		return true
	}
	if value == "false" {
		return false
	}
	if strings.Contains(value, ".") {
		if number, err := strconv.ParseFloat(value, 64); err == nil {
			return number
		}
	} else if integer, err := strconv.ParseInt(value, 10, 64); err == nil {
		return integer
	} else if number, err := strconv.ParseFloat(value, 64); err == nil {
		return number
	}
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		inner := value[1 : len(value)-1]
		parts := strings.Split(inner, ",")
		items := make([]any, 0, len(parts))
		for _, entry := range parts {
			parsed := ParseTOMLScalar(strings.TrimSpace(entry))
			if s, ok := parsed.(string); ok && s == "" {
				continue
			}
			items = append(items, parsed)
		}
		return items
	}
	return value
}

func parseTOMLKeyValueLine(line string) (string, string, bool) {
	parts := strings.SplitN(line, "=", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	key := strings.TrimSpace(parts[0])
	rawValue := parts[1]
	if key == "" || !isTOMLKey(key) {
		return "", "", false
	}
	return key, rawValue, true
}

func isTOMLKey(key string) bool {
	for _, ch := range key {
		if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '.' || ch == '-') {
			return false
		}
	}
	return true
}

func parseMarkdownMetadataLine(line string) (string, string, bool) {
	parts := strings.SplitN(line, ":", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	key := strings.TrimSpace(parts[0])
	rawValue := strings.TrimSpace(parts[1])
	if key == "" || !isTOMLKey(key) {
		return "", "", false
	}
	return key, rawValue, true
}

func parseDotenvKey(line string) (string, bool) {
	line = strings.TrimPrefix(line, "export ")
	parts := strings.SplitN(line, "=", 2)
	if len(parts) < 1 {
		return "", false
	}
	key := strings.TrimSpace(parts[0])
	if key == "" {
		return "", false
	}
	for index, ch := range key {
		if index == 0 {
			if !((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch == '_') {
				return "", false
			}
			continue
		}
		if !((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_') {
			return "", false
		}
	}
	return key, true
}

func extractMarkdownFrontmatter(text string) (string, bool) {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	if !strings.HasPrefix(normalized, "---\n") {
		return "", false
	}
	rest := normalized[4:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", false
	}
	return rest[:end], true
}

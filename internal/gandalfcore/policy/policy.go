package policy

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

const (
	MaxFileBytes        = 256 * 1024
	MaxDirectoryDepth   = 4
	MaxDirectoryEntries = 250
)

var secretKeyPattern = regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|auth|bearer)`)

func RestorePolicyFor(kind types.EvidenceKind) types.RestorePolicy {
	switch kind {
	case types.KindAgentInstruction, types.KindAgentConfig, types.KindSkill, types.KindExtension:
		return types.RestoreFullContent
	case types.KindMcpServer, types.KindPermission, types.KindHook:
		return types.RestoreStructuredFields
	case types.KindEnvKey:
		return types.RestoreKeyInventory
	default:
		return types.RestoreNotSupported
	}
}

// PermissionWildcard inspects permission names and structured rule payloads.
type PermissionWildcard struct{}

func (PermissionWildcard) InName(name string) bool {
	return permissionWildcardToken(name)
}

func (PermissionWildcard) InJSON(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return permissionWildcardToken(string(raw))
	}
	return permissionWildcardValue(decoded)
}

func permissionWildcardToken(s string) bool {
	return s == "*" || strings.Contains(s, "*") || strings.Contains(s, "(*)")
}

func permissionWildcardValue(value any) bool {
	switch v := value.(type) {
	case string:
		return permissionWildcardToken(v)
	case []any:
		for _, item := range v {
			if permissionWildcardValue(item) {
				return true
			}
		}
	}
	return false
}

func IsSecretLikeKey(key string) bool {
	return secretKeyPattern.MatchString(key)
}

func CaptureStatusForKey(key string) string {
	if IsSecretLikeKey(key) {
		return "redacted"
	}
	return "omitted"
}

func RedactStructuredValue(value json.RawMessage) (json.RawMessage, error) {
	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		return value, err
	}
	redacted := redactValue(decoded)
	out, err := json.Marshal(redacted)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func redactValue(value any) any {
	switch v := value.(type) {
	case string:
		return ScrubInlineSecrets(v)
	case map[string]any:
		return redactObject(v)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = redactValue(item)
		}
		return out
	default:
		return value
	}
}

func redactObject(obj map[string]any) map[string]any {
	redacted := make(map[string]any, len(obj))
	for key, nested := range obj {
		if IsSecretLikeKey(key) {
			redacted[key] = "[redacted]"
			continue
		}
		if key == "env" {
			if envMap, ok := nested.(map[string]any); ok {
				keys := make([]string, 0, len(envMap))
				for k := range envMap {
					keys = append(keys, k)
				}
				redacted["envKeys"] = keys
				continue
			}
		}
		redacted[key] = redactValue(nested)
	}
	return redacted
}

func IgnoredDirectory(name string) bool {
	switch name {
	case ".git", "node_modules", "dist", "build", ".cache", "cache", "caches", "logs", "log", ".next", "coverage", ".turbo":
		return true
	default:
		return false
	}
}

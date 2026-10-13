package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/qyinm/gandalf/internal/gandalfcore/types"
)

// CommonFlags are shared CLI options across commands.
type CommonFlags struct {
	Project string
	Home    string
	JSON    bool
}

func (f *CommonFlags) bindFlags(cmdFlags interface {
	StringVarP(*string, string, string, string, string)
	StringVar(*string, string, string, string)
	BoolVar(*bool, string, bool, string)
}) {
	cmdFlags.StringVarP(&f.Project, "project", "p", ".", "Project directory")
	cmdFlags.StringVar(&f.Home, "home", "", "Home directory (defaults to $HOME)")
	cmdFlags.BoolVar(&f.JSON, "json", false, "Emit JSON output")
}

// runtimeOptions are the resolved directories a command operates on.
type runtimeOptions struct {
	ProjectPath string
	HomeDir     string
}

func resolveRuntime(flags *CommonFlags) (runtimeOptions, *types.SnapError) {
	homeDir := flags.Home
	if homeDir == "" {
		if envHome := os.Getenv("HOME"); envHome != "" {
			homeDir = envHome
		} else if cwd, err := os.Getwd(); err == nil {
			homeDir = cwd
		} else {
			homeDir = "."
		}
	}

	projectPath := flags.Project
	if abs, err := filepath.Abs(projectPath); err == nil {
		if resolved, err := filepath.EvalSymlinks(abs); err == nil {
			projectPath = resolved
		} else {
			projectPath = abs
		}
	}

	return runtimeOptions{ProjectPath: projectPath, HomeDir: homeDir}, nil
}

func writeJSON(w io.Writer, value any) int {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return writeError(w, &types.SnapError{
			Code:    "GANDALF_JSON_SERIALIZE_FAILED",
			Problem: "Failed to serialize JSON output.",
			Cause:   err.Error(),
			Fix:     "This is an internal error.",
		})
	}
	if _, err := fmt.Fprintf(w, "%s\n", data); err != nil {
		return 1
	}
	return 0
}

func writeError(w io.Writer, err *types.SnapError) int {
	lines := []string{
		err.Code,
		fmt.Sprintf("Problem: %s", err.Problem),
		fmt.Sprintf("Cause: %s", err.Cause),
		fmt.Sprintf("Fix: %s", err.Fix),
	}
	if err.Path != nil {
		lines = append(lines, fmt.Sprintf("Path: %s", *err.Path))
	}
	_, _ = io.WriteString(w, strings.Join(lines, "\n")+"\n")
	return 1
}

type exitError struct {
	code int
}

func (e exitError) Error() string {
	return fmt.Sprintf("exit %d", e.code)
}

func errExit(code int) error {
	return exitError{code: code}
}

// IsExitError reports whether err is a CLI exit code wrapper.
func IsExitError(err error) (int, bool) {
	var target exitError
	if errors.As(err, &target) {
		return target.code, true
	}
	return 0, false
}

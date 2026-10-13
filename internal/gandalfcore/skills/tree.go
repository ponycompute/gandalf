package skills

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// treeEntry is one file or in-tree symlink of a skill directory. Hashing and
// copying both walk the same entries, so a copy always hashes equal to its
// source.
type treeEntry struct {
	rel    string
	mode   fs.FileMode
	target string // set for symlinks
}

var ignoredNames = map[string]struct{}{
	".DS_Store": {},
	".git":      {},
}

// walkTree lists the regular files and in-tree relative symlinks under dir,
// sorted by path. Symlinks that are absolute or resolve outside dir are left
// out: copying them would silently point a skill at files it does not own.
func walkTree(dir string) ([]treeEntry, error) {
	var entries []treeEntry
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		if _, ignored := ignoredNames[d.Name()]; ignored {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if linkStaysInside(dir, path, target) {
				entries = append(entries, treeEntry{rel: rel, mode: info.Mode(), target: target})
			}
		case info.Mode().IsRegular():
			entries = append(entries, treeEntry{rel: rel, mode: info.Mode()})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].rel < entries[j].rel })
	return entries, nil
}

func linkStaysInside(dir, linkPath, target string) bool {
	if filepath.IsAbs(target) {
		return false
	}
	resolved := filepath.Join(filepath.Dir(linkPath), target)
	rel, err := filepath.Rel(dir, resolved)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// HashDir returns a SHA-256 digest of a skill directory's content. File
// permissions and timestamps are not part of the digest.
func HashDir(dir string) (string, error) {
	entries, err := walkTree(dir)
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	for _, entry := range entries {
		rel := filepath.ToSlash(entry.rel)
		if entry.target != "" {
			fmt.Fprintf(digest, "link\x00%s\x00%s\x00", rel, entry.target)
			continue
		}
		fileHash, err := hashFile(filepath.Join(dir, entry.rel))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(digest, "file\x00%s\x00%s\x00", rel, fileHash)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// copyTree copies the skill at src into dest, which must not exist. The copy
// is staged in a hidden sibling directory and renamed into place, so readers
// never observe a half-written skill.
func copyTree(src, dest string) error {
	entries, err := walkTree(src)
	if err != nil {
		return err
	}
	parent := filepath.Dir(dest)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(parent, ".gandalf-staging-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)

	for _, entry := range entries {
		target := filepath.Join(staging, entry.rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if entry.target != "" {
			if err := os.Symlink(entry.target, target); err != nil {
				return err
			}
			continue
		}
		if err := copyFile(filepath.Join(src, entry.rel), target, entry.mode.Perm()); err != nil {
			return err
		}
	}
	if err := os.Chmod(staging, 0o755); err != nil {
		return err
	}
	return os.Rename(staging, dest)
}

func copyFile(src, dest string, perm fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

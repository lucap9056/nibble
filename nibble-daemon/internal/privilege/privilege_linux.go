//go:build linux

package privilege

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
)

// Matches the nonroot user of distroless images.
const fallbackID = 65532

func ownerOf(path string) (int, int, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, 0, err
	}
	stat := info.Sys().(*syscall.Stat_t)
	return int(stat.Uid), int(stat.Gid), nil
}

func chownTree(root string, uid, gid int) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(path, uid, gid)
	})
}

func chown(owned Ownership, uid, gid int) error {
	for _, dir := range owned.Dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		if err := os.Lchown(dir, uid, gid); err != nil {
			return err
		}
	}
	for _, file := range owned.Files {
		if err := os.Lchown(file, uid, gid); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	for _, tree := range owned.Trees {
		if err := chownTree(tree, uid, gid); err != nil {
			return err
		}
	}
	return nil
}

func Drop(sourceDir string, owned Ownership) error {
	if os.Geteuid() != 0 {
		return nil
	}
	uid, gid, err := ownerOf(sourceDir)
	if err != nil {
		return fmt.Errorf("failed to inspect bubble source dir: %w", err)
	}
	if uid == 0 {
		uid, gid = fallbackID, fallbackID
	}
	if err := chown(owned, uid, gid); err != nil {
		return fmt.Errorf("failed to hand state over to %d:%d: %w", uid, gid, err)
	}

	// Since Go 1.16 these apply to every thread of the process on Linux.
	if err := syscall.Setgroups([]int{}); err != nil {
		return fmt.Errorf("failed to clear groups: %w", err)
	}
	if err := syscall.Setgid(gid); err != nil {
		return fmt.Errorf("failed to set gid %d: %w", gid, err)
	}
	if err := syscall.Setuid(uid); err != nil {
		return fmt.Errorf("failed to set uid %d: %w", uid, err)
	}
	// root's HOME is not writable after the drop, and bun install keeps its cache there.
	tempDir := os.TempDir()
	if err := os.Setenv("HOME", tempDir); err != nil {
		return err
	}
	slog.Debug("privileges dropped", "uid", uid, "gid", gid)
	return nil
}

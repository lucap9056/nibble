package install

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

var (
	ErrAbsolutePath      = errors.New("path must be relative to the bubble source dir")
	ErrOutsideSourceDir  = errors.New("path must be inside the bubble source dir")
	ErrInsideNodeModules = errors.New("path must not be inside node_modules")
	ErrNoPackageJSON     = errors.New("path must be a directory containing package.json")
)

func isOutsideDir(relativePath string) bool {
	return relativePath == ".." ||
		strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relativePath)
}

func ResolveTarget(sourceDir, target string) (string, error) {
	if path.IsAbs(target) || filepath.IsAbs(target) || filepath.VolumeName(target) != "" {
		return "", fmt.Errorf("%w: %s", ErrAbsolutePath, target)
	}
	realSourceDir, err := filepath.EvalSymlinks(sourceDir)
	if err != nil {
		return "", fmt.Errorf("failed to resolve bubble source dir: %w", err)
	}
	joinedTarget := filepath.Join(realSourceDir, filepath.FromSlash(target))
	realTarget, err := filepath.EvalSymlinks(joinedTarget)
	if err != nil {
		return "", fmt.Errorf("failed to resolve %s: %w", target, err)
	}

	relativePath, err := filepath.Rel(realSourceDir, realTarget)
	if err != nil || isOutsideDir(relativePath) {
		return "", fmt.Errorf("%w: %s", ErrOutsideSourceDir, realTarget)
	}
	segments := strings.Split(relativePath, string(filepath.Separator))
	if slices.Contains(segments, "node_modules") {
		return "", fmt.Errorf("%w: %s", ErrInsideNodeModules, realTarget)
	}

	manifestPath := filepath.Join(realTarget, "package.json")
	info, err := os.Stat(manifestPath)
	if err != nil || info.IsDir() {
		return "", fmt.Errorf("%w: %s", ErrNoPackageJSON, realTarget)
	}
	return realTarget, nil
}

func Run(engineBinaryPath, dir string, args []string) error {
	installArgs := append([]string{"install"}, args...)
	cmd := exec.Command(engineBinaryPath, installArgs...)
	cmd.Dir = dir
	// The engine is a compiled Bun executable; BUN_BE_BUN makes it run as the bun CLI instead of the engine.
	cmd.Env = append(os.Environ(), "BUN_BE_BUN=1")
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

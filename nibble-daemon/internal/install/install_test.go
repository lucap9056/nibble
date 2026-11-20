package install

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writePackage(t *testing.T, dir string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(dir, 0o755))
	manifestPath := filepath.Join(dir, "package.json")
	require.NoError(t, os.WriteFile(manifestPath, []byte("{}"), 0o644))
}

func TestResolveTarget(t *testing.T) {
	rootDir := t.TempDir()
	sourceDir := filepath.Join(rootDir, "bubbles")
	bubbleDir := filepath.Join(sourceDir, "signature")
	nestedDir := filepath.Join(sourceDir, "api", "users")
	outsideDir := filepath.Join(rootDir, "outside")
	writePackage(t, sourceDir)
	writePackage(t, bubbleDir)
	writePackage(t, nestedDir)
	writePackage(t, outsideDir)
	writePackage(t, filepath.Join(bubbleDir, "node_modules", "sharp"))
	require.NoError(t, os.MkdirAll(filepath.Join(sourceDir, "empty"), 0o755))

	realSourceDir, err := filepath.EvalSymlinks(sourceDir)
	require.NoError(t, err)
	realBubbleDir, err := filepath.EvalSymlinks(bubbleDir)
	require.NoError(t, err)
	realNestedDir, err := filepath.EvalSymlinks(nestedDir)
	require.NoError(t, err)

	cases := []struct {
		name    string
		target  string
		want    string
		wantErr error
	}{
		{"bubble name", "signature", realBubbleDir, nil},
		{"nested bubble name", "api/users", realNestedDir, nil},
		{"source dir itself", ".", realSourceDir, nil},
		{"dot segments back inside", "signature/../signature", realBubbleDir, nil},
		{"absolute path", bubbleDir, "", ErrAbsolutePath},
		{"rooted path", "/signature", "", ErrAbsolutePath},
		{"dot segments escape", "../outside", "", ErrOutsideSourceDir},
		{"node_modules", "signature/node_modules/sharp", "", ErrInsideNodeModules},
		{"no package.json", "empty", "", ErrNoPackageJSON},
		{"package.json file", "signature/package.json", "", ErrNoPackageJSON},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveTarget(sourceDir, tc.target)
			if tc.wantErr != nil {
				assert.ErrorIs(t, err, tc.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}

	t.Run("missing", func(t *testing.T) {
		_, err := ResolveTarget(sourceDir, "missing")
		assert.Error(t, err)
	})

	t.Run("symlink escape", func(t *testing.T) {
		linkPath := filepath.Join(sourceDir, "escape")
		if err := os.Symlink(outsideDir, linkPath); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		_, err := ResolveTarget(sourceDir, "escape")
		assert.ErrorIs(t, err, ErrOutsideSourceDir)
	})
}

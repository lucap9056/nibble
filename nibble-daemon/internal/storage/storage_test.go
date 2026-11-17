package storage

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newStorage(t *testing.T) *Storage {
	t.Helper()
	dir := t.TempDir()
	databasePath := filepath.Join(dir, "bubbles.db")
	s, err := Open(databasePath)
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestReplaceBubbles(t *testing.T) {
	ctx := context.Background()
	s := newStorage(t)
	original := Bubble{Name: "alpha", SnapshotHash: "abc"}
	replacement := Bubble{Name: "beta", SnapshotHash: "def", Enabled: true}
	duplicated := []Bubble{replacement, replacement}

	_, err := s.SaveBubble(ctx, original)
	require.NoError(t, err)

	duplicateErr := s.ReplaceBubbles(ctx, duplicated)
	require.Error(t, duplicateErr)
	kept, err := s.ListBubbles(ctx)
	require.NoError(t, err)
	assert.Equal(t, []Bubble{original}, kept)

	replaceErr := s.ReplaceBubbles(ctx, []Bubble{replacement})
	require.NoError(t, replaceErr)
	replaced, err := s.ListBubbles(ctx)
	require.NoError(t, err)
	assert.Equal(t, []Bubble{replacement}, replaced)
}

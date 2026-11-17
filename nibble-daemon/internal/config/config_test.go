package config

import (
	"daemon/internal/storage"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadBubbles(t *testing.T) {
	load := func(input string) ([]storage.Bubble, error) {
		reader := strings.NewReader(input)
		return LoadBubbles(reader)
	}

	omitted, err := load("")
	require.NoError(t, err)
	assert.Nil(t, omitted)

	empty, err := load("[]")
	require.NoError(t, err)
	assert.Equal(t, []storage.Bubble{}, empty)

	seeded, err := load(`[{"name":"a","hash":"h1","routing":true},{"name":"b","hash":"ignored","snapshotHash":"h2"},{"name":"c"}]`)
	require.NoError(t, err)
	assert.Equal(t, []storage.Bubble{
		{Name: "a", SnapshotHash: "h1", Enabled: true, Routing: true},
		{Name: "b", SnapshotHash: "h2", Enabled: true},
		{Name: "c", Enabled: true},
	}, seeded)

	_, unknownErr := load(`[{"name":"a","enabled":true}]`)
	assert.Error(t, unknownErr)

	_, missingErr := load(`[{"hash":"h1"}]`)
	assert.Error(t, missingErr)
}

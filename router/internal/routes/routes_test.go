package routes_test

import (
	"router/internal/routes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewTable_RejectsInvalidEntries(t *testing.T) {
	invalid := [][]routes.Entry{
		{{Name: "", SocketPath: "a"}},
		{{Name: "a/b", SocketPath: "a"}},
		{{Name: "a", SocketPath: ""}},
		{{Name: "a", SocketPath: "x"}, {Name: "a", SocketPath: "y"}},
	}
	for _, entries := range invalid {
		_, err := routes.NewTable(entries)
		assert.Error(t, err, "%+v", entries)
	}
}

func TestResolve(t *testing.T) {
	api := routes.Entry{Name: "api", SocketPath: "api.sock"}
	table, err := routes.NewTable([]routes.Entry{api})
	require.NoError(t, err)

	matches := map[string]string{
		"/api":                 "/",
		"/api/":                "/",
		"/api?x=1":             "/?x=1",
		"/api/users/1?x=1&y=2": "/users/1?x=1&y=2",
		"/api//double":         "//double",
	}
	for target, upstreamPath := range matches {
		resolved, ok := table.Resolve(target)
		require.True(t, ok, target)
		assert.Equal(t, routes.Resolved{Entry: api, Prefix: "/api", UpstreamPath: upstreamPath}, resolved, target)
	}

	for _, target := range []string{"/", "/apix", "/apix/y", "/other", "api", "*", ""} {
		_, ok := table.Resolve(target)
		assert.False(t, ok, "%q should not match", target)
	}
}
